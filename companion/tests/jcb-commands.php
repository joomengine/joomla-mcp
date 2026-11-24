<?php

declare(strict_types=1);

namespace Joomla\DI {
    final class ContainerResource
    {
        public function __construct(private object $instance) {}
    }
}
namespace VDM\Joomla\Componentbuilder {
    final class Factory
    {
        public static function getArea(string $entity): ?string
        {
            return $entity === 'joomla_component' ? 'JoomlaComponent' : null;
        }
    }
}
namespace VDM\Joomla\Data {
    class Item
    {
        public function __construct(private object $record) {}
        public function table(string $table): static { return $this; }
        public function get(string $id, string $key): ?object
        {
            return $this->record->{$key} === $id ? clone $this->record : null;
        }
    }
    class Items
    {
        public function __construct(private object $record) {}
        public function table(string $table): static { return $this; }
        public function get(array $ids, string $key): array
        {
            return in_array($this->record->{$key}, $ids, true) ? [clone $this->record] : [];
        }
    }
}
namespace VDM\Joomla\Abstraction\Remote {
    class Get
    {
        public function __construct(protected object $grep) {}
        public function getGuidField(): string { return 'guid'; }
        public function mapItem(object $item): object { return $item; }
    }
    class Set
    {
        protected ?object $resolver = null;
        public function __construct(protected object $git, protected object $grep, public array $repos) {}
        public function getGuidField(): string { return 'guid'; }
        public function mapItem(object $item): object { return $item; }
        protected function targetRepo(object $record, object $repo): bool { return true; }
        protected function index_map_IndexSettingsPath(object $record): string { return 'settings.json'; }
        public function getIndexPath(): string { return 'index.json'; }
        public function getIndexItem(object $item): array { return ['path' => 'p', 'settings' => 'settings.json']; }
    }
}

namespace {
    use Joomla\DI\ContainerResource;
    use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
    use VDM\Plugin\Console\JoomlaMcp\Jcb\CommandOptions;
    use VDM\Plugin\Console\JoomlaMcp\Jcb\CompilerOutput;
    use VDM\Plugin\Console\JoomlaMcp\Jcb\FileComparison;
    use VDM\Plugin\Console\JoomlaMcp\Jcb\PackageVerification;
    use VDM\Joomla\Abstraction\Remote\Get;
    use VDM\Joomla\Abstraction\Remote\Set;
    use VDM\Joomla\Data\Item;
    use VDM\Joomla\Data\Items;

    function jcbFailure(callable $f): void
    {
        try { $f(); } catch (ActionException) { return; }
        throw new \RuntimeException('Expected rejection.');
    }

    test('JCB options admit only installed reviewed forms and explicit inline selections', static function (): void {
        $definition = new class {
            public function getArguments(): array { return []; }
            public function hasOption($name): bool { return in_array($name, ['component', 'components', 'build-date', 'options', 'minify', 'items', 'repo', 'force', 'resolve']); }
            public function getOption($name): object {
                return new class(!in_array($name, ['force', 'resolve'], true)) {
                    public function __construct(private bool $value) {}
                    public function acceptValue(): bool { return $this->value; }
                    public function isArray(): bool { return false; }
                };
            }
        };
        $guid = '60d58feb-2077-41a1-a91d-b53b19425675';
        $compiler = CommandOptions::properties($definition, true);
        $packages = CommandOptions::properties($definition, false);
        expect(CommandOptions::normalize((object) ['component'=>$guid], $compiler, 'compile')['components']
            === json_encode([$guid]), 'Compiler selector did not freeze.');
        expect(CommandOptions::normalize((object) ['items'=>'alpha,beta', 'resolve'=>true], $packages, 'init')['items']
            === '["alpha","beta"]', 'Bounded alternative keys should work.');
        expect(CommandOptions::normalize((object) ['items'=>'alpha'], $packages, 'get')['items']
            === '["alpha"]', 'Get resolves bounded alternative keys itself.');
        foreach (['init', 'pull', 'reset'] as $verb) {
            jcbFailure(fn () => CommandOptions::normalize((object) ['items'=>'alpha'], $packages, $verb));
        }
        $bundled = CommandOptions::normalize((object) ['components'=>'{"items":["' . $guid . '"]}',
            'options'=>'{"minify":1,"build_date":"2026-11-24"}', 'minify'=>'2'], $compiler, 'compile');
        expect($bundled['minify'] === '2' && $bundled['build-date'] === '2026-11-24'
            && !isset($bundled['options']), 'Explicit compiler options must take precedence over a bounded bundle.');
        expect(CommandOptions::compilerPostOverrides(['minify' => '0', 'powers' => '2']) === [
            'backup' => '0', 'repository' => '0', 'powers_repository' => '0', 'show_advanced_options' => '1',
            'minify' => '0',
        ], 'Disallowed exports and explicit zero-valued native options must be applied to compiler input.');
        foreach ([['install'=>true], ['options'=>'{"install":1}'], ['components'=>'@/tmp/path'],
            ['components'=>'1'], ['components'=>'[]'], ['components'=>'*'], ['components'=>'["../x"]'],
            ['components'=>$guid, 'build-date'=>'2026-02-31']] as $bad) {
            jcbFailure(fn () => CommandOptions::normalize((object) $bad, $compiler, 'compile'));
        }
        foreach ([['items'=>'all'], ['items'=>'@file'], ['items'=>'../x'], ['items'=>'[]'], ['items'=>'first','repo'=>'https://example.invalid'],
            ['items'=>'first', 'repo-file'=>'x'], ['items'=>'first', 'force'=>'true']] as $bad) {
            jcbFailure(fn () => CommandOptions::normalize((object) $bad, $packages, 'init'));
        }
        jcbFailure(fn () => CommandOptions::normalize((object) ['items'=>'alpha'], $packages, 'push'));
    });

    test('JCB compiler verifies only regular ZIP results under the owned workspace', static function (): void {
        if (!class_exists(\ZipArchive::class)) {
            return;
        }
        $dir = sys_get_temp_dir() . '/jcb-zip-check-' . bin2hex(random_bytes(6));
        mkdir($dir, 0700);
        $zip = new \ZipArchive();
        try {
            $file = $dir . '/com_demo.zip';
            $zip->open($file, \ZipArchive::CREATE);
            $zip->addFromString('demo.xml', '<extension/>');
            $zip->close();
            $result = CompilerOutput::verify($dir, [$file]);
            expect($result === [['name'=>'com_demo.zip','size'=>filesize($file),'sha256'=>hash_file('sha256', $file)]],
                'Archive metadata or digest mismatch.');
            jcbFailure(fn () => CompilerOutput::verify($dir, []));
            jcbFailure(fn () => CompilerOutput::verify(dirname($dir) . '/absent', [$file]));
            symlink($file, $dir . '/linked.zip');
            jcbFailure(fn () => CompilerOutput::verify($dir, [$dir . '/linked.zip']));
        } finally {
            foreach (glob($dir . '/*') as $file) { unlink($file); }
            rmdir($dir);
        }
    });

    function jcbPackageResult(string $verb, bool $matches, string $category): array
    {
        $guid = '60d58feb-2077-41a1-a91d-b53b19425675';
        $local = (object) ['guid'=>$guid, 'name'=>'demo'];
        $remote = (object) ['name'=>$matches ? 'demo' : 'wrong', 'guid'=>$guid];
        $git = new class($remote) {
            public function __construct(private object $remote) {}
            public function setTarget($target): void {}
            public function reset_(): void {}
            public function get($org, $repo, $path, $branch): object {
                return $path === 'settings.json' ? $this->remote : (object) [
                    $this->remote->guid=>(object) ['path'=>'p', 'settings'=>'settings.json']];
            }
        };
        $grep = new class($remote) {
            public object $tracker;
            public array $paths = [];
            public function __construct(private object $remote) { $this->tracker = new \stdClass(); }
            public function setBranchField($branch): void {}
            public function loadApi($git, $base, $token): void {}
            public function get($value, $order, $repo): object { return clone $this->remote; }
        };
        $repo = (object) ['organisation'=>'joomengine', 'repository'=>'definitions', 'write_branch'=>'main'];
        $container = new class(['Data.Item'=>new Item($local), 'Data.Items'=>new Items($local),
            'JoomlaComponent.Remote.Get'=>new Get($grep), 'JoomlaComponent.Remote.Set'=>new Set($git,$grep,[$repo])]) {
            public function __construct(private array $services) {}
            public function getResource(string $name): ?ContainerResource {
                return isset($this->services[$name]) ? new ContainerResource($this->services[$name]) : null;
            }
        };
        $tracker = new class($guid) {
            public function __construct(private string $guid) {}
            public function get($key, $default): array { return ['joomla_component'=>['guid|' . $this->guid => true]]; }
        };
        $builder = (object) ['container'=>$container, 'tracker'=>$tracker,
            'results'=>[$category=>[$guid=>'joomla_component']]];
        return (new PackageVerification())->inspect((object) ['get'=>$builder, 'set'=>$builder],
            $verb, 'joomla_component', [$guid], null, ['errors'=>0,'warnings'=>0]);
    }

    test('JCB package verification proves retained rows, freshly compared imports and targeted remote pushes', static function (): void {
        foreach (['get', 'init', 'pull', 'reset', 'push'] as $verb) {
            $good = jcbPackageResult($verb, true, 'added');
            expect($good['status'] === 'verified', $verb . ' positive read-back failed.');
            $bad = jcbPackageResult($verb, false, 'added');
            expect($bad['status'] === 'partial' && $bad['differentCount'] > 0, $verb . ' did not detect mismatch.');
        }
        expect(jcbPackageResult('init', false, 'local')['status'] === 'verified', 'Init should preserve and verify an existing local record.');
    });

    test('JCB folder read-back compares bounded regular files and rejects unsafe ZIP entries', static function (): void {
        if (!class_exists(\ZipArchive::class)) {
            return;
        }
        $dir = sys_get_temp_dir() . '/jcb-folder-check-' . bin2hex(random_bytes(6));
        mkdir($dir, 0700);
        $file = $dir . '/fixture.txt';
        $archive = tempnam(sys_get_temp_dir(), 'jcb-zip');
        $read = new FileComparison();
        $local = new \ReflectionMethod($read, 'localDirectory');
        $remote = new \ReflectionMethod($read, 'archive');
        try {
            file_put_contents($file, 'native content');
            $make = static function (string $name) use ($archive): string {
                $zip = new \ZipArchive();
                $zip->open($archive, \ZipArchive::OVERWRITE);
                $zip->addFromString($name, 'native content');
                $zip->close();
                return file_get_contents($archive);
            };
            $expected = $remote->invoke($read, $make('fixture.txt'));
            expect($expected === $local->invoke($read, $dir, false), 'Local folder hash must match the remote archive.');
            file_put_contents($file, 'changed content');
            expect($expected !== $local->invoke($read, $dir, false), 'Folder comparison must detect changed bytes.');
            jcbFailure(fn () => $remote->invoke($read, $make('../fixture.txt')));
            symlink($file, $dir . '/other');
            jcbFailure(fn () => $local->invoke($read, $dir, false));
        } finally {
            if (is_link($dir . '/other')) { unlink($dir . '/other'); }
            unlink($archive);
            unlink($file);
            rmdir($dir);
        }
    });
}
