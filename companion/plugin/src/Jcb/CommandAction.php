<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use Joomla\CMS\Factory;
use Joomla\CMS\Language\Text;
use VDM\Joomla\Componentbuilder\Table;
use VDM\Joomla\Database\Load;
use ReflectionClass;
use ReflectionProperty;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Output\NullOutput;
use Symfony\Component\Console\Output\OutputInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final readonly class CommandAction implements ActionInterface
{
    public function __construct(
        private object $application,
        private object $command,
        private int $actorId,
        private string $verb,
        private string $area,
        private string $entity,
        private array $properties,
    ) {
    }

    public function descriptor(): ActionDescriptor
    {
        $compiler = $this->verb === 'compile';
        $options = ['type' => 'object', 'additionalProperties' => false, 'properties' => $this->properties];
        if ($compiler) {
            $options['anyOf'] = [['required' => ['component']], ['required' => ['components']]];
        } else {
            $options['required'] = ['items'];
        }
        return new ActionDescriptor(
            'jcb.' . $this->verb . '.' . $this->area,
            'Run the installed ' . $this->command->getName() . ' command after preview and operator approval.',
            'high',
            [['action' => 'core.admin', 'asset' => 'com_componentbuilder']],
            ['type' => 'object', 'required' => ['options'], 'additionalProperties' => false, 'properties' => ['options' => $options]],
            ['type' => 'object', 'required' => ['applied', 'dryRun']],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, ['options', 'dryRun', '_edgeConfirmed', '_expectedContractFingerprint']);
        $options = CommandOptions::normalize($input['options'] ?? null, $this->properties, $this->verb);
        $identity = $this->application->getIdentity();
        if ($this->actorId < 1 || (int) ($identity->id ?? 0) !== $this->actorId || !empty($identity->block)
            || !$identity->authorise('core.admin', 'com_componentbuilder')) {
            throw new ActionException('ACCESS_DENIED', 'The configured JCB actor is unavailable or lacks component administration permission.');
        }
        $state = new DefinitionState(new Load(), new Table());
        if (isset($options['repo']) && !$state->hasRepository($options['repo'])) {
            throw new ActionException('INVALID_INPUT', 'The selected repository GUID does not identify an installed JCB repository.');
        }
        $compiler = $this->verb === 'compile';
        $selectors = json_decode($options[$compiler ? 'components' : 'items'], true, 4, JSON_THROW_ON_ERROR);
        $fingerprint = $this->fingerprint($state, $options);
        $preview = [
            'preState' => ['contractFingerprint' => $fingerprint],
            'requestedState' => ['command' => $this->command->getName(), 'options' => $options],
        ];
        if (Input::boolean($input, 'dryRun', true)) {
            return ['dryRun' => true, 'applied' => false] + $preview;
        }
        if (!Input::boolean($input, '_edgeConfirmed', false)
            || !hash_equals($fingerprint, Input::text($input, '_expectedContractFingerprint', '', 64))) {
            throw new ActionException('PLAN_STALE', 'An unchanged, operator-confirmed JCB command plan is required.');
        }

        $workspace = $compiler ? CompilerOutput::directory() : null;
        $native = $compiler ? Factory::getConfig() : null;
        $nativeTmp = $native?->get('tmp_path');
        $appTmp = $this->application->get('tmp_path');
        $post = $compiler ? $this->application->getInput()->post : null;
        $priorPost = [];
        $environment = [];
        $beforeMessages = count($this->application->getMessageQueue());
        try {
            // The native commands accept paths, selectors, install flags and credentials through
            // environment fallbacks. Only the typed, reviewed arguments below are authoritative.
            foreach (getenv() as $key => $value) {
                if (str_starts_with($key, 'JCB_')) {
                    $environment[$key] = $value;
                    putenv($key);
                }
            }
            if ($compiler) {
                $this->application->set('tmp_path', $workspace);
                $native->set('tmp_path', $workspace);
                foreach (CommandOptions::compilerPostOverrides($options) as $key => $value) {
                    $priorPost[$key] = $post->get($key, null, 'RAW');
                    $post->set($key, $value);
                }
            }
            $args = [];
            foreach ($options as $name => $value) {
                if ($value !== false) {
                    $args['--' . $name] = $value;
                }
            }
            $nativeInput = new ArrayInput($args, $this->command->getDefinition());
            $nativeInput->setInteractive(false);
            // Joomla binds command identity and dependencies when registering the object.
            // Stdout from Joomla's application is handled by DispatchService, console output is discarded.
            $output = new class extends NullOutput {
                public function getErrorOutput(): OutputInterface
                {
                    return $this;
                }
            };
            $exit = $this->command->execute($nativeInput, $output);
            $statuses = $this->messages($beforeMessages);
            if ($exit !== 0 || $statuses['errors'] > 0) {
                throw new ActionException('JCB_PARTIAL', 'The native JCB command reported errors. It may have made partial changes.');
            }
            if ($compiler) {
                $paths = (new ReflectionProperty($this->command, 'outputPaths'))->getValue($this->command);
                $artifacts = CompilerOutput::verify($workspace, $paths);
                $verification = ['status' => $statuses['warnings'] === 0 ? 'verified' : 'partial',
                    'artifactCount' => count($artifacts), ...$statuses];
                return ['dryRun' => false, 'applied' => true, 'verification' => $verification, 'artifacts' => $artifacts];
            }
            $verification = (new PackageVerification())->inspect($this->command, $this->verb, $this->entity,
                $selectors, $options['repo'] ?? null, $statuses);
            return ['dryRun' => false, 'applied' => true, 'verification' => $verification];
        } finally {
            if ($compiler) {
                $native->set('tmp_path', $nativeTmp);
                $this->application->set('tmp_path', $appTmp);
                foreach ($priorPost as $key => $value) {
                    $post->set($key, $value);
                }
            }
            foreach ($environment as $key => $value) {
                putenv($key . '=' . $value);
            }
        }
    }

    private function fingerprint(DefinitionState $state, array $options): string
    {
        $sources = [];
        $reflection = new ReflectionClass($this->command);
        do {
            $filename = $reflection->getFileName();
            if (!is_string($filename) || ($hash = hash_file('sha256', $filename)) === false) {
                throw new ActionException('JCB_SOURCE_UNAVAILABLE', 'The installed command source cannot be verified.');
            }
            $sources[$reflection->getName()] = $hash;
        } while ($reflection = $reflection->getParentClass());
        $contract = [];
        foreach ($this->command->getDefinition()->getOptions() as $name => $option) {
            $contract[$name] = [$option->acceptValue(), $option->isValueRequired(), $option->isArray(), $option->getDefault()];
        }
        ksort($contract);
        // A package service or compiler dependency can change independently of the console class.
        $library = dirname((new ReflectionClass(Table::class))->getFileName(), 4);
        $files = [];
        $bytes = 0;
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($library, \FilesystemIterator::SKIP_DOTS)) as $entry) {
            if (!$entry->isFile() || $entry->getExtension() !== 'php') {
                continue;
            }
            $bytes += $entry->getSize();
            if ($entry->isLink() || count($files) >= 8192 || $bytes > 268435456
                || ($digest = hash_file('sha256', $entry->getPathname())) === false) {
                throw new ActionException('JCB_SOURCE_UNAVAILABLE', 'The installed JCB library could not be fingerprinted.');
            }
            $files[substr($entry->getPathname(), strlen($library) + 1)] = $digest;
        }
        ksort($files);
        $sources['library'] = hash('sha256', serialize($files));
        return hash('sha256', serialize([$this->actorId, $this->command->getName(), $this->entity, $contract,
            $sources, $state->fingerprint(), $options]));
    }

    private function messages(int $before): array
    {
        $counts = ['warnings' => 0, 'errors' => 0];
        if ($this->verb !== 'compile') {
            $bus = (new ReflectionProperty($this->command, 'message'))->getValue($this->command);
            foreach (['warning' => 'warnings', 'error' => 'errors'] as $key => $counter) {
                $counts[$counter] = count((array) $bus?->get($key));
            }
            if ($this->verb === 'push') {
                // JCB returns false and emits this localized warning for an already synchronized dependency.
                $markers = ['McpAreaMarker', 'McpItemMarker', 'McpRepoMarker'];
                $template = Text::sprintf('COM_COMPONENTBUILDER_NO_CHANGE_S_ITEM_S_IN_REPO_S_IS_ALREADY_IN_SYNC', ...$markers);
                $pattern = '~^' . str_replace($markers, '.{0,1024}?', preg_quote($template, '~')) . '$~Ds';
                $counts['inSyncWarnings'] = 0;
                foreach ((array) $bus?->get('warning') as $warning) {
                    if (is_string($warning) && strlen($warning) <= 4096 && preg_match($pattern, $warning) === 1) {
                        $counts['inSyncWarnings']++;
                    }
                }
            }
        }
        foreach (array_slice($this->application->getMessageQueue(), $before) as $message) {
            if (($message['type'] ?? '') === 'error') {
                $counts['errors']++;
            } elseif (($message['type'] ?? '') === 'warning') {
                $counts['warnings']++;
            }
        }
        return $counts;
    }
}
