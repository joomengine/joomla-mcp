<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use VDM\Plugin\Console\JoomlaMcp\Action\SystemInfoAction;
use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
use VDM\Plugin\Console\JoomlaMcp\Action\FixedModelStateAction;
use VDM\Plugin\Console\JoomlaMcp\Action\PurgeExpiredCacheAction;
use VDM\Plugin\Console\JoomlaMcp\Action\RefreshExtensionDiscoveryAction;
use VDM\Plugin\Console\JoomlaMcp\Action\RefreshExtensionUpdatesAction;
use VDM\Plugin\Console\JoomlaMcp\Action\SchedulerTaskAction;
use VDM\Plugin\Console\JoomlaMcp\Action\SessionGarbageCollectionAction;
use VDM\Plugin\Console\JoomlaMcp\Action\SiteStateAction;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\NativeOperationsInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;
use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaActionRegistryFactory;
use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;
use VDM\Plugin\Console\JoomlaMcp\Protocol\DescriptionService;
use VDM\Plugin\Console\JoomlaMcp\Protocol\DispatchService;
use VDM\Plugin\Console\JoomlaMcp\Protocol\RequestDecoder;
use VDM\Plugin\Console\JoomlaMcp\Protocol\SelfTestService;

$GLOBALS['failures'] = 0;

$allow = new class implements CapabilityResolverInterface {
    public function actor(): array
    {
        return ['id' => 42, 'configured' => true];
    }

    public function resolve(ActionDescriptor $descriptor): array
    {
        return ['allowed' => true, 'requirements' => []];
    }
};

$deny = new class implements CapabilityResolverInterface {
    public function actor(): array
    {
        return ['id' => null, 'configured' => false];
    }

    public function resolve(ActionDescriptor $descriptor): array
    {
        return ['allowed' => false, 'requirements' => []];
    }
};

$native = new class implements NativeOperationsInterface {
    public bool $offline = false;
    public array $calls = [];
    public int $exitCode = 0;

    public function siteOfflineState(): bool
    {
        return $this->offline;
    }

    public function setSiteOffline(bool $offline): int
    {
        $this->calls[] = ['site', $offline];
        $this->offline = $offline;

        return $this->exitCode;
    }

    public function garbageCollectSessions(string $application): int
    {
        $this->calls[] = ['sessions', $application];

        return $this->exitCode;
    }

    public function garbageCollectSessionMetadata(): int
    {
        $this->calls[] = ['metadata'];

        return $this->exitCode;
    }

    public function setSchedulerTaskState(int $id, int $state): int
    {
        $this->calls[] = ['scheduler-state', $id, $state];

        return $this->exitCode;
    }

    public function runSchedulerTask(int $id): int
    {
        $this->calls[] = ['scheduler-run', $id];

        return $this->exitCode;
    }
};

$echoAction = new class implements ActionInterface {
    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'test.echo',
            'Echo one safe value.',
            'read',
            [],
            ['type' => 'object', 'additionalProperties' => false],
            ['type' => 'object'],
        );
    }

    public function execute(array $input): array
    {
        if (array_diff(array_keys($input), ['value']) !== []) {
            throw new \VDM\Plugin\Console\JoomlaMcp\Domain\ActionException('INVALID_INPUT', 'Unknown input.');
        }

        return ['value' => $input['value'] ?? null];
    }
};

test('request decoder accepts the versioned object contract', static function (): void {
    $decoded = (new RequestDecoder())->decode('{"protocol":"joomla-mcp/1","id":"a","action":"test.echo","input":{}}');
    expect($decoded['action'] === 'test.echo', 'Action was not decoded.');
});

test('request decoder rejects unknown envelope members', static function (): void {
    $result = (new DispatchService(new ActionRegistry(), $GLOBALS['allow']))->handleJson(
        '{"protocol":"joomla-mcp/1","id":1,"action":"test.echo","input":{},"url":"https://attacker.invalid"}',
    );
    expect(jsonObject($result)['error']['code'] === 'INVALID_REQUEST', 'Unknown envelope member was accepted.');
});

test('registry rejects duplicate action names', static function () use ($echoAction): void {
    try {
        new ActionRegistry([$echoAction, $echoAction]);
        expect(false, 'Duplicate action name was accepted.');
    } catch (InvalidArgumentException) {
        expect(true, 'Duplicate action was rejected.');
    }
});

test('dispatcher executes an explicitly registered action', static function () use ($echoAction, $allow): void {
    $service = new DispatchService(new ActionRegistry([$echoAction]), $allow);
    $result = jsonObject($service->handleJson(
        '{"protocol":"joomla-mcp/1","id":7,"action":"test.echo","input":{"value":"ok"}}',
    ));
    expect($result['ok'] === true && $result['result']['value'] === 'ok', 'Registered action did not execute.');
});

test('dispatcher rejects unknown actions', static function () use ($allow): void {
    $service = new DispatchService(new ActionRegistry(), $allow);
    $result = jsonObject($service->handleJson(
        '{"protocol":"joomla-mcp/1","id":8,"action":"shell.run","input":{}}',
    ));
    expect($result['ok'] === false && $result['error']['code'] === 'UNKNOWN_ACTION', 'Unknown action was not rejected.');
});

test('dispatcher enforces effective capabilities before execution', static function () use ($echoAction, $deny): void {
    $service = new DispatchService(new ActionRegistry([$echoAction]), $deny);
    $result = jsonObject($service->handleJson(
        '{"protocol":"joomla-mcp/1","id":9,"action":"test.echo","input":{}}',
    ));
    expect($result['error']['code'] === 'ACCESS_DENIED', 'Denied capability executed.');
});

test('description is sorted, versioned, and includes effective access', static function () use ($echoAction, $allow): void {
    $registry = new ActionRegistry([$echoAction, new SystemInfoAction()]);
    $description = jsonObject((new DescriptionService($registry, $allow))->toJson());
    expect($description['protocol'] === 'joomla-mcp/1', 'Description protocol is missing.');
    expect($description['companion']['version'] === '0.7.0', 'Description companion version is stale.');
    expect($description['actions'][0]['name'] === 'system.info', 'Actions are not sorted.');
    expect(isset($description['actions'][0]['effective']['allowed']), 'Effective access is missing.');
});

test('Joomla console command configuration does not chain void setters', static function (): void {
    foreach (['CliInventoryCommand.php', 'DescribeCommand.php', 'DispatchCommand.php', 'SelfTestCommand.php'] as $file) {
        $source = file_get_contents(dirname(__DIR__) . '/plugin/src/Command/' . $file);
        expect(is_string($source), sprintf('Could not read %s.', $file));
        expect(
            preg_match('/->set(?:Description|Help|Name|Aliases|Application|Definition|Hidden)\\([^;]+\\)\\s*->/s', $source) !== 1,
            sprintf('%s chains a Joomla Console setter that returns void.', $file),
        );
    }
});

test('companion self-test validates the full catalogue and fixed dispatch', static function () use ($allow): void {
    $registry = (new JoomlaActionRegistryFactory(new stdClass()))->create();
    $result = (new SelfTestService($registry, $allow))->evaluate();
    expect($result['ok'] === true, 'Companion self-test did not pass.');
    expect($result['checks']['pluginEnabled'] === true, 'Companion self-test did not prove plugin activation.');
    expect($result['checks']['catalogue']['actionCount'] === 231, 'Companion self-test catalogue count changed.');
    expect($result['checks']['dispatch']['action'] === 'system.info', 'Companion self-test did not use the fixed safe action.');
});

test('companion self-test fails closed without its reviewed catalogue', static function () use ($allow): void {
    $result = (new SelfTestService(new ActionRegistry(), $allow))->evaluate();
    expect($result['ok'] === false, 'Incomplete companion catalogue passed self-test.');
    expect($result['error']['code'] === 'SELF_TEST_FAILED', 'Self-test exposed an unexpected error contract.');
});

test('Joomla factory registers the reviewed native model catalogue', static function (): void {
    $registry = (new JoomlaActionRegistryFactory(new stdClass()))->create();
    $names = array_map(static fn (ActionInterface $action): string => $action->descriptor()->name, $registry->all());
    expect(count($names) === count(array_unique($names)), 'Native action names are not unique.');
    expect(count($names) === 231, 'The reviewed 231-action native capability catalogue changed.');

    foreach ([
        'configuration.application.get',
        'configuration.get_safe',
        'content.articles.list',
        'content.articles.get',
        'content.articles.create',
        'content.articles.update',
        'content.articles.delete',
        'content.articles.state',
        'banners.banners.list',
        'banners.banners.create',
        'users.users.list',
        'users.users.create',
        'users.users.delete',
        'extensions.installed.list',
        'extensions.discovered.list',
        'extensions.discovered.refresh',
        'extensions.updates.list',
        'extensions.updates.refresh',
        'extensions.update-sites.list',
        'extensions.update-sites.state.set',
        'extensions.state.set',
        'scheduler.tasks.list',
        'scheduler.tasks.state.set',
        'scheduler.tasks.run',
        'core.update.status',
        'cache.groups.list',
        'cache.clean',
        'cache.expired.purge',
        'site.state.get',
        'site.state.set',
        'sessions.data.gc',
        'sessions.metadata.gc',
        'system.info',
    ] as $required) {
        expect(in_array($required, $names, true), sprintf('Native action "%s" is missing.', $required));
    }
});

test('native operations expose semantic methods and no generic command runner', static function (): void {
    $methods = array_map(
        static fn (ReflectionMethod $method): string => $method->getName(),
        (new ReflectionClass(NativeOperationsInterface::class))->getMethods(),
    );
    sort($methods, SORT_STRING);
    expect($methods === [
        'garbageCollectSessionMetadata',
        'garbageCollectSessions',
        'runSchedulerTask',
        'setSchedulerTaskState',
        'setSiteOffline',
        'siteOfflineState',
    ], 'Native operations gained a generic command or an unreviewed capability.');
});

test('native command output is discarded without an unbounded memory buffer', static function (): void {
    $source = file_get_contents(dirname(__DIR__) . '/plugin/src/Joomla/JoomlaNativeOperations.php');
    expect(is_string($source), 'Could not read JoomlaNativeOperations source.');
    expect(str_contains($source, 'new NullOutput()'), 'Native commands do not use NullOutput.');
    expect(str_contains($source, '$command->execute('), 'Native commands do not use Joomla Framework Console execute().');
    expect(!str_contains($source, '$command->run('), 'Native commands call a non-existent run() method.');
    expect(!str_contains($source, 'BufferedOutput'), 'Native commands retain unbounded human output.');
});

test('production operation schemas expose no caller-selected Joomla primitive', static function (): void {
    $registry = (new JoomlaActionRegistryFactory(new stdClass()))->create();
    $productionActions = [
        'cache.expired.purge',
        'extensions.discovered.refresh',
        'extensions.updates.refresh',
        'extensions.update-sites.list',
        'extensions.update-sites.state.set',
        'extensions.state.set',
        'scheduler.tasks.state.set',
        'scheduler.tasks.run',
        'site.state.get',
        'site.state.set',
        'sessions.data.gc',
        'sessions.metadata.gc',
    ];

    foreach ($productionActions as $name) {
        $properties = $registry->get($name)->descriptor()->inputSchema['properties'] ?? [];

        foreach (['command', 'component', 'model', 'method', 'url', 'path', 'php', 'sql'] as $escape) {
            expect(!array_key_exists($escape, $properties), sprintf('Action "%s" exposes "%s".', $name, $escape));
        }
    }
});

test('core entity catalogue covers all source-backed CRUD bases with explicit fields', static function (): void {
    $entities = CoreEntityCatalogue::all();
    expect(count($entities) === 36, 'Expected all 36 Joomla 6 core CRUD bases.');
    expect(count(array_filter($entities, static fn ($entity): bool => $entity->supportsState)) === 28, 'Expected all 28 verified core state actions.');
    $ids = array_map(static fn ($entity): string => $entity->id, $entities);
    expect(count($ids) === count(array_unique($ids)), 'Core entity ids are not unique.');

    foreach (['content.articles', 'banners.banners', 'users.users', 'contacts.contacts', 'menus.site-items', 'fields.users'] as $id) {
        expect(in_array($id, $ids, true), sprintf('Core entity "%s" is missing.', $id));
    }

    foreach ($entities as $entity) {
        expect($entity->readFields !== [] && $entity->writeFields !== [], 'Entity fields must be explicit.');
        expect(str_starts_with($entity->component, 'com_'), 'Entity component must be fixed.');

        if ($entity->supportsState) {
            expect(in_array($entity->stateField, $entity->readFields, true), 'State-enabled entity has no readable postcondition field.');
        }
    }
});

test('generic list action bounds model state and strips non-allowlisted output', static function (): void {
    $entity = array_values(array_filter(
        CoreEntityCatalogue::all(),
        static fn ($candidate): bool => $candidate->id === 'users.users',
    ))[0];
    $model = new class {
        public array $state = [];

        public function setState(string $key, mixed $value): void
        {
            $this->state[$key] = $value;
        }

        public function getItems(): array
        {
            return [(object) ['id' => 7, 'name' => 'Ada', 'username' => 'ada', 'email' => 'ada@example.test', 'password' => 'must-not-leak']];
        }

        public function getTotal(): int
        {
            return 1;
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            expect($component === 'com_users' && $modelName === 'Users', 'Unexpected model selection.');

            return $this->model;
        }
    };
    $result = (new CoreEntityAction($entity, 'list', $provider))->execute([
        'offset' => 5, 'limit' => 10, 'search' => 'ada', 'direction' => 'DESC',
    ]);
    expect($model->state['list.start'] === 5 && $model->state['list.limit'] === 10, 'Pagination was not applied.');
    expect($model->state['filter.search'] === 'ada', 'Search was not applied.');
    expect(!array_key_exists('password', $result['items'][0]), 'A user password escaped the read allowlist.');
    expect(!str_contains(json_encode($result, JSON_THROW_ON_ERROR), 'must-not-leak'), 'A secret value escaped normalization.');
});

test('generic writes preview by default and require the signed edge marker to apply', static function (): void {
    $entity = array_values(array_filter(
        CoreEntityCatalogue::all(),
        static fn ($candidate): bool => $candidate->id === 'content.articles',
    ))[0];
    $model = new class {
        public int $saveCalls = 0;
        public array $saved = [];

        public function save(array $data): bool
        {
            $this->saveCalls++;
            $this->saved = $data;

            return true;
        }

        public function getState(string $key, int $default = 0): int
        {
            return 91;
        }

        public function getItem(int $id): object
        {
            return (object) ['id' => $id, 'title' => $this->saved['title'] ?? ''];
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            return $this->model;
        }
    };
    $action = new CoreEntityAction($entity, 'create', $provider);
    $preview = $action->execute(['data' => ['title' => 'Safe article']]);
    expect($preview['applied'] === false && $preview['dryRun'] === true, 'Write did not default to preview.');
    expect($model->saveCalls === 0, 'Preview invoked the Joomla model.');

    try {
        $action->execute(['data' => ['title' => 'Safe article'], 'dryRun' => false]);
        expect(false, 'Unconfirmed write was applied.');
    } catch (ActionException $exception) {
        expect($exception->errorCode === 'CONFIRMATION_REQUIRED', 'Wrong confirmation error code.');
    }

    $applied = $action->execute([
        'data' => ['title' => 'Safe article'],
        'dryRun' => false,
        '_edgeConfirmed' => true,
    ]);
    expect($applied['applied'] === true && $applied['id'] === 91, 'Edge-confirmed write was not applied.');
    expect($model->saveCalls === 1 && $model->saved['title'] === 'Safe article', 'Joomla model did not receive validated data.');
});

test('generic updates merge existing writable fields without replaying sensitive values', static function (): void {
    $entity = array_values(array_filter(
        CoreEntityCatalogue::all(),
        static fn ($candidate): bool => $candidate->id === 'users.users',
    ))[0];
    $model = new class {
        public array $saved = [];

        public function getItem(int $id): object
        {
            return (object) [
                'id' => $id,
                'name' => 'Existing user',
                'username' => 'existing-user',
                'email' => 'existing@example.test',
                'password' => 'stored-password-hash',
                'groups' => [2],
            ];
        }

        public function save(array $data): bool
        {
            $this->saved = $data;

            return true;
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            return $this->model;
        }
    };
    $result = (new CoreEntityAction($entity, 'update', $provider))->execute([
        'id' => 77,
        'data' => ['name' => 'Updated user'],
        'dryRun' => false,
        '_edgeConfirmed' => true,
    ]);

    expect($result['applied'] === true, 'The partial update was not applied.');
    expect($model->saved['name'] === 'Updated user', 'The requested update did not override the existing value.');
    expect($model->saved['username'] === 'existing-user', 'Required existing fields were not retained.');
    expect(!array_key_exists('password', $model->saved), 'A stored sensitive value was replayed into an update.');
});

test('generic writes reject unknown fields and CLI etags before model invocation', static function (): void {
    $entity = CoreEntityCatalogue::all()[0];
    $provider = new class implements ModelProviderInterface {
        public int $calls = 0;

        public function administrator(string $component, string $modelName): object
        {
            $this->calls++;

            return new stdClass();
        }
    };
    $action = new CoreEntityAction($entity, 'update', $provider);

    foreach ([
        ['id' => 1, 'data' => ['component' => 'com_users']],
        ['id' => 1, 'data' => ['title' => 'x'], 'etag' => 'caller-controlled'],
    ] as $input) {
        try {
            $action->execute($input);
            expect(false, 'Unsafe write input was accepted.');
        } catch (ActionException $exception) {
            expect($exception->errorCode === 'INVALID_INPUT', 'Unsafe input produced the wrong error.');
        }
    }

    expect($provider->calls === 0, 'Rejected input reached a Joomla model.');
});

test('generic delete and state operations use only bounded numeric ids', static function (): void {
    $entity = CoreEntityCatalogue::all()[0];
    $model = new class {
        public array $deleted = [];
        public array $published = [];
        public int $state = 1;

        public function delete(array &$ids): bool
        {
            $this->deleted = $ids;

            return true;
        }

        public function publish(array &$ids, int $state): bool
        {
            $this->published = [$ids, $state];
            $this->state = $state;

            return true;
        }

        public function getItem(int $id): object
        {
            return (object) ['id' => $id, 'state' => $this->state];
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            return $this->model;
        }
    };
    $flags = ['dryRun' => false, '_edgeConfirmed' => true];
    $deleted = (new CoreEntityAction($entity, 'delete', $provider))->execute(['id' => 12] + $flags);
    $stated = (new CoreEntityAction($entity, 'state', $provider))->execute(['id' => 12, 'state' => 0] + $flags);
    expect($deleted['applied'] === true && $model->deleted === [12], 'Delete ids were not bounded.');
    expect($stated['applied'] === true && $model->published === [[12], 0], 'State transition was not bounded.');
    expect($stated['item']['state'] === 0, 'State transition was not read back.');
});

test('expired cache purge is preview-first and delegates only to Joomla CacheModel purge', static function (): void {
    $model = new class {
        public int $calls = 0;

        public function purge(): bool
        {
            $this->calls++;

            return true;
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            expect($component === 'com_cache' && $modelName === 'Cache', 'Cache purge selected an unexpected Joomla model.');

            return $this->model;
        }
    };
    $action = new PurgeExpiredCacheAction($provider);
    $preview = $action->execute([]);
    expect($preview['dryRun'] === true && $model->calls === 0, 'Cache purge preview invoked Joomla.');
    $result = $action->execute(['dryRun' => false, '_edgeConfirmed' => true]);
    expect($result['applied'] === true && $model->calls === 1, 'Confirmed expired cache purge did not use Joomla.');
});

test('extension metadata refreshes use the native Joomla discover and stable update sequences', static function (): void {
    $discover = new class {
        public int $total = 2;
        public int $calls = 0;

        public function getTotal(): int
        {
            return $this->total;
        }

        public function discover(): int
        {
            $this->calls++;
            $this->total = 3;

            return 1;
        }
    };
    $update = new class {
        public int $total = 4;
        public int $purges = 0;
        public int $finds = 0;

        public function getTotal(): int
        {
            return $this->total;
        }

        public function purge(): bool
        {
            $this->purges++;
            $this->total = 0;

            return true;
        }

        public function findUpdates(): bool
        {
            $this->finds++;
            $this->total = 5;

            return true;
        }
    };
    $provider = new class ($discover, $update) implements ModelProviderInterface {
        public function __construct(private object $discover, private object $update)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            expect($component === 'com_installer', 'Refresh escaped com_installer.');

            return $modelName === 'Discover' ? $this->discover : $this->update;
        }
    };
    $discovery = (new RefreshExtensionDiscoveryAction($provider))->execute([
        'dryRun' => false, '_edgeConfirmed' => true,
    ]);
    $updates = (new RefreshExtensionUpdatesAction($provider))->execute([
        'dryRun' => false, '_edgeConfirmed' => true,
    ]);
    expect($discovery['postState']['newlyDiscovered'] === 1 && $discover->calls === 1, 'Native discovery sequence was not used.');
    expect($updates['postState']['availableUpdateCount'] === 5, 'Native update refresh was not read back.');
    expect($update->purges === 1 && $update->finds === 1, 'Update refresh did not purge then find updates exactly once.');
});

test('fixed extension state adapter reads, applies, verifies, and provides inverse recovery', static function (): void {
    $model = new class {
        public bool $enabled = true;
        public array $state = [];
        public int $publishCalls = 0;

        public function setState(string $key, mixed $value): void
        {
            $this->state[$key] = $value;
        }

        public function getItems(): array
        {
            return [(object) [
                'extension_id' => 19,
                'name' => 'Safe extension',
                'type' => 'plugin',
                'element' => 'safe',
                'folder' => 'system',
                'client_id' => 0,
                'enabled' => $this->enabled ? 1 : 0,
                'protected' => 0,
            ]];
        }

        public function publish(array &$ids, int $state): bool
        {
            expect($ids === [19], 'State adapter passed an unbounded extension selection.');
            $this->publishCalls++;
            $this->enabled = $state === 1;

            return true;
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            expect($component === 'com_installer' && $modelName === 'Manage', 'State adapter selected an unexpected model.');

            return $this->model;
        }
    };
    $action = new FixedModelStateAction(
        'extensions.state.set',
        'test',
        'com_installer',
        'Manage',
        'extension_id',
        ['extension_id', 'name', 'enabled', 'protected'],
        $provider,
    );
    $preview = $action->execute(['id' => 19, 'enabled' => false]);
    expect($preview['preState']['enabled'] === true && $model->publishCalls === 0, 'State preview mutated Joomla.');
    $result = $action->execute(['id' => 19, 'enabled' => false, 'dryRun' => false, '_edgeConfirmed' => true]);
    expect($result['verification']['matchesRequestedState'] === true, 'Extension state read-back failed.');
    expect($result['recovery']['input']['enabled'] === true && $model->publishCalls === 1, 'Extension state recovery is incomplete.');
});

test('site and session operations expose only typed native Joomla command adapters', static function () use ($native): void {
    $native->offline = false;
    $native->calls = [];
    $site = new SiteStateAction($native, true);
    $preview = $site->execute(['offline' => true]);
    expect($preview['preState']['offline'] === false && $native->calls === [], 'Site preview ran a command.');
    $changed = $site->execute(['offline' => true, 'dryRun' => false, '_edgeConfirmed' => true]);
    expect($changed['verification']['matchesRequestedState'] === true, 'Site state was not verified.');
    expect($changed['recovery']['input']['offline'] === false, 'Site state recovery was not recorded.');

    $session = new SessionGarbageCollectionAction($native);
    $session->execute(['application' => 'administrator', 'dryRun' => false, '_edgeConfirmed' => true]);
    $metadata = new SessionGarbageCollectionAction($native, true);
    $metadata->execute(['dryRun' => false, '_edgeConfirmed' => true]);
    expect(in_array(['sessions', 'administrator'], $native->calls, true), 'Typed session application was not preserved.');
    expect(in_array(['metadata'], $native->calls, true), 'Metadata garbage collection was not invoked.');

    try {
        $session->execute(['application' => 'installation']);
        expect(false, 'Unsupported session application was accepted.');
    } catch (ActionException $exception) {
        expect($exception->errorCode === 'INVALID_INPUT', 'Unsupported session application produced the wrong error.');
    }
});

test('scheduler mutations are single-task, preview-first, and return pre/post state', static function () use ($native): void {
    $task = new class {
        public int $state = 1;

        public function getItem(int $id): object
        {
            return (object) [
                'id' => $id,
                'title' => 'Maintenance',
                'type' => 'safe.test',
                'state' => $this->state,
                'last_exit_code' => 0,
                'locked' => null,
                'last_execution' => null,
                'next_execution' => null,
                'times_executed' => 0,
                'times_failed' => 0,
                'priority' => 0,
                'note' => '',
            ];
        }
    };
    $provider = new class ($task) implements ModelProviderInterface {
        public function __construct(private object $task)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            expect($component === 'com_scheduler' && $modelName === 'Task', 'Scheduler selected an unexpected model.');

            return $this->task;
        }
    };
    $native->calls = [];
    $state = new SchedulerTaskAction('state', $provider, $native);
    $preview = $state->execute(['id' => 7, 'state' => 0]);
    expect($preview['dryRun'] === true && $native->calls === [], 'Scheduler preview invoked Joomla command.');

    // Reflect the command's native persistence in the read-back test model.
    $nativeWithState = new class ($native, $task) implements NativeOperationsInterface {
        public function __construct(private NativeOperationsInterface $inner, private object $task)
        {
        }

        public function siteOfflineState(): bool { return $this->inner->siteOfflineState(); }
        public function setSiteOffline(bool $offline): int { return $this->inner->setSiteOffline($offline); }
        public function garbageCollectSessions(string $application): int { return $this->inner->garbageCollectSessions($application); }
        public function garbageCollectSessionMetadata(): int { return $this->inner->garbageCollectSessionMetadata(); }
        public function runSchedulerTask(int $id): int { return $this->inner->runSchedulerTask($id); }
        public function setSchedulerTaskState(int $id, int $state): int
        {
            $this->task->state = $state;

            return $this->inner->setSchedulerTaskState($id, $state);
        }
    };
    $result = (new SchedulerTaskAction('state', $provider, $nativeWithState))->execute([
        'id' => 7, 'state' => 0, 'dryRun' => false, '_edgeConfirmed' => true,
    ]);
    expect($result['verification']['matchesExpectedOutcome'] === true, 'Scheduler state was not verified.');
    expect($result['recovery']['input'] === ['id' => 7, 'state' => 1], 'Scheduler recovery state is incorrect.');
});

test('all reversible native state setters fail closed on mismatched read-back', static function (): void {
    $expectPostconditionFailure = static function (callable $callback, string $label): void {
        try {
            $callback();
            expect(false, $label . ' accepted a mismatched postcondition.');
        } catch (ActionException $exception) {
            expect($exception->errorCode === 'POSTCONDITION_FAILED', $label . ' produced the wrong failure code.');
        }
    };

    $coreModel = new class {
        public function publish(array &$ids, int $state): bool { return true; }
        public function getItem(int $id): object { return (object) ['id' => $id, 'state' => 1]; }
    };
    $coreProvider = new class ($coreModel) implements ModelProviderInterface {
        public function __construct(private object $model) {}
        public function administrator(string $component, string $modelName): object { return $this->model; }
    };
    $article = array_values(array_filter(
        CoreEntityCatalogue::all(),
        static fn ($candidate): bool => $candidate->id === 'content.articles',
    ))[0];
    $expectPostconditionFailure(
        static fn () => (new CoreEntityAction($article, 'state', $coreProvider))->execute([
            'id' => 8, 'state' => 0, 'dryRun' => false, '_edgeConfirmed' => true,
        ]),
        'Core entity state',
    );

    $fixedModel = new class {
        public function setState(string $key, mixed $value): void {}
        public function getItems(): array { return [(object) ['extension_id' => 9, 'enabled' => 1]]; }
        public function publish(array &$ids, int $state): bool { return true; }
    };
    $fixedProvider = new class ($fixedModel) implements ModelProviderInterface {
        public function __construct(private object $model) {}
        public function administrator(string $component, string $modelName): object { return $this->model; }
    };
    $fixed = new FixedModelStateAction(
        'extensions.state.set', 'test', 'com_installer', 'Manage', 'extension_id',
        ['extension_id', 'enabled'], $fixedProvider,
    );
    $expectPostconditionFailure(
        static fn () => $fixed->execute(['id' => 9, 'enabled' => false, 'dryRun' => false, '_edgeConfirmed' => true]),
        'Extension state',
    );

    $nativeMismatch = new class implements NativeOperationsInterface {
        public function siteOfflineState(): bool { return false; }
        public function setSiteOffline(bool $offline): int { return 0; }
        public function garbageCollectSessions(string $application): int { return 0; }
        public function garbageCollectSessionMetadata(): int { return 0; }
        public function setSchedulerTaskState(int $id, int $state): int { return 0; }
        public function runSchedulerTask(int $id): int { return 0; }
    };
    $expectPostconditionFailure(
        static fn () => (new SiteStateAction($nativeMismatch, true))->execute([
            'offline' => true, 'dryRun' => false, '_edgeConfirmed' => true,
        ]),
        'Site state',
    );

    $taskModel = new class {
        public function getItem(int $id): object { return (object) ['id' => $id, 'state' => 1]; }
    };
    $taskProvider = new class ($taskModel) implements ModelProviderInterface {
        public function __construct(private object $model) {}
        public function administrator(string $component, string $modelName): object { return $this->model; }
    };
    $expectPostconditionFailure(
        static fn () => (new SchedulerTaskAction('state', $taskProvider, $nativeMismatch))->execute([
            'id' => 10, 'state' => 0, 'dryRun' => false, '_edgeConfirmed' => true,
        ]),
        'Scheduler task state',
    );
});

test('plugin source contains no process, code, or generic database escape hatch', static function (): void {
    $root = dirname(__DIR__) . '/plugin';
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root));
    $forbidden = '/\b(?:shell_exec|exec|system|passthru|proc_open|popen|eval)\s*\(/i';

    foreach ($iterator as $file) {
        if (!$file->isFile() || $file->getExtension() !== 'php') {
            continue;
        }

        $source = file_get_contents($file->getPathname());
        expect(is_string($source) && preg_match($forbidden, $source) !== 1, 'Forbidden primitive in ' . $file->getFilename());
        expect(!str_contains((string) $source, 'getDbo('), 'Direct database access in ' . $file->getFilename());
        expect(!str_contains((string) $source, 'createQuery('), 'Direct query construction in ' . $file->getFilename());
        expect(!str_contains((string) $source, 'new PDO'), 'Direct PDO access in ' . $file->getFilename());
    }
});

test('manifests declare an installable package and Joomla console plugin', static function (): void {
    $root = dirname(__DIR__);
    $package = file_get_contents($root . '/pkg_joomlamcp.xml');
    $plugin = file_get_contents($root . '/plugin/joomlamcp.xml');
    $build = file_get_contents($root . '/build.php');
    expect(is_string($package) && str_contains($package, 'type="package"'), 'Package manifest is invalid.');
    expect(is_string($plugin) && str_contains($plugin, 'type="plugin" group="console"'), 'Plugin manifest is invalid.');
    expect(str_contains((string) $package, '<version>0.7.0</version>'), 'Package manifest version is stale.');
    expect(substr_count((string) $build, "'LICENSE.txt'") >= 2, 'Companion build does not package the project license.');
    expect(str_contains((string) $plugin, '<version>0.7.0</version>'), 'Plugin manifest version is stale.');
    expect(str_contains((string) $build, "\$version = '0.7.0';"), 'Package build filename version is stale.');
    expect(str_contains((string) $plugin, 'VDM\\Plugin\\Console\\JoomlaMcp'), 'Plugin namespace is missing.');
    expect(str_contains((string) $plugin, '<scriptfile>script.php</scriptfile>'), 'Plugin installer script is not declared.');
    $installer = file_get_contents($root . '/plugin/script.php');
    expect(is_string($installer) && str_contains($installer, "\$type !== 'install'"), 'Installer does not preserve update-time plugin state.');
    expect(str_contains((string) $installer, "'folder' => 'console'"), 'Installer is not fixed to the console plugin group.');
    expect(str_contains((string) $installer, "'element' => 'joomlamcp'"), 'Installer is not fixed to the companion plugin element.');
    expect(str_contains((string) $installer, '$extension->enabled = 1;'), 'Installer does not enable the companion after first install.');
    $extensionSource = file_get_contents($root . '/plugin/src/Extension/JoomlaMcpPlugin.php');
    expect(is_string($extensionSource) && str_contains($extensionSource, 'SelfTestCommand::class'), 'Companion self-test command is not registered.');
    expect(str_contains((string) $extensionSource, 'CliInventoryCommand::class'), 'Companion CLI inventory command is not registered.');
    $inventorySource = file_get_contents($root . '/plugin/src/Command/CliInventoryCommand.php');
    expect(is_string($inventorySource) && str_contains($inventorySource, 'getAllCommands()'), 'CLI inventory does not use Joomla\'s native command registry.');
    expect(!str_contains((string) $inventorySource, 'doRun('), 'CLI inventory executes installed commands.');
});

if ($GLOBALS['failures'] > 0) {
    file_put_contents('php://stderr', sprintf("%d test(s) failed.\n", $GLOBALS['failures']), FILE_APPEND);
    exit(1);
}

file_put_contents('php://stdout', "All companion contract/security tests passed.\n", FILE_APPEND);
