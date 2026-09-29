<?php

declare(strict_types=1);

namespace Joomla\CMS {
    if (!class_exists(Factory::class, false)) {
        final class Factory
        {
            public static function getApplication(): object
            {
                return new class {
                    public function getInput(): object
                    {
                        return new class {
                            public function set(string $key, mixed $value): void
                            {
                            }
                        };
                    }
                };
            }
        }
    }
}

namespace Joomla\Component\Installer\Administrator\Model {
    if (!class_exists(InstallerModel::class, false)) {
        abstract class InstallerModel
        {
        }
    }
}

namespace {
    use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
    use VDM\Plugin\Console\JoomlaMcp\Action\FixedModelListAction;
    use VDM\Plugin\Console\JoomlaMcp\Action\ListArticlesAction;
    use VDM\Plugin\Console\JoomlaMcp\Action\ListExtensionsAction;
    use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
    use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
    use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;
    use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaModelProvider;
    use VDM\Plugin\Console\JoomlaMcp\Joomla\ModelListPage;
    use Joomla\Component\Installer\Administrator\Model\InstallerModel;

    final class NativePaginationModel
    {
        public array $state = [];
        public int $reads = 0;
        public array $rows;

        public function __construct(int $count)
        {
            $this->rows = [];

            for ($id = 1; $id <= $count; ++$id) {
                $this->rows[] = (object) ['id' => $id, 'lang_id' => $id, 'extension_id' => $id, 'title' => 'Row ' . $id];
            }
        }

        public function setState(string $key, mixed $value): void
        {
            $this->state[$key] = $value;
        }

        public function getTotal(): int
        {
            return count($this->rows);
        }

        public function getItems(): array
        {
            ++$this->reads;
            $start = $this->state['list.start'] ?? 0;
            $limit = $this->state['list.limit'] ?? 20;
            $total = count($this->rows);

            // Match the native page rewind that caused the reported boundary
            // failures. Ordinary successful mocks cannot detect this defect.
            if ($start > $total - $limit) {
                $start = max(0, (int) ceil($total / $limit) - 1) * $limit;
                $this->state['list.start'] = $start;
            }

            return array_slice($this->rows, $start, $limit);
        }
    }

    function nativeListProvider(object $model): ModelProviderInterface
    {
        return new class ($model) implements ModelProviderInterface {
            public function __construct(private object $model)
            {
            }

            public function administrator(string $component, string $modelName): object
            {
                return $this->model;
            }
        };
    }

    function nativePaginationAction(string $id, NativePaginationModel $model): object
    {
        $provider = nativeListProvider($model);

        if (in_array($id, ['extensions.list', 'extensions.installed.list'], true)) {
            return new ListExtensionsAction($provider, $id);
        }

        if ($id === 'extensions.update-sites.list') {
            return new FixedModelListAction($id, 'List update sites.', 'com_installer', 'Updatesites', ['id', 'title'], $provider);
        }

        if ($id === 'articles.legacy.list') {
            $application = new class ($model) {
                public function __construct(private object $model)
                {
                }

                public function bootComponent(string $component): object
                {
                    return new class ($this->model) {
                        public function __construct(private object $model)
                        {
                        }

                        public function getMVCFactory(): object
                        {
                            return new class ($this->model) {
                                public function __construct(private object $model)
                                {
                                }

                                public function createModel(string $name, string $prefix, array $config): object
                                {
                                    return $this->model;
                                }
                            };
                        }
                    };
                }
            };

            return new ListArticlesAction(new JoomlaModelProvider($application));
        }

        $entity = array_values(array_filter(CoreEntityCatalogue::all(), static fn ($entity): bool => $entity->id . '.list' === $id))[0];

        return new CoreEntityAction($entity, 'list', $provider);
    }

    $listIds = [
        'banners.categories.list', 'contacts.categories.list', 'content.categories.list',
        'extensions.installed.list', 'extensions.list', 'extensions.update-sites.list',
        'menus.site-items.list', 'menus.site.list', 'modules.administrator.list', 'modules.site.list',
        'newsfeeds.categories.list', 'templates.administrator-styles.list', 'templates.site-styles.list',
        'content.articles.list', 'articles.legacy.list',
    ];

    foreach ($listIds as $id) {
        test($id . ' preserves exact slices at empty, tail, end and beyond-end offsets', static function () use ($id): void {
            foreach ([0, 1, 7] as $total) {
                $model = new NativePaginationModel($total);
                $action = nativePaginationAction($id, $model);

                foreach ([[0, 3], [1, 1], [5, 3], [$total, 1], [$total + 5, 2], [0, 3]] as [$offset, $limit]) {
                    $before = $model->reads;
                    $result = $action->execute(['offset' => $offset, 'limit' => $limit]);
                    $field = in_array($id, ['extensions.list', 'extensions.installed.list'], true) ? 'extensionId' : 'id';
                    $expected = array_map(static fn ($row): int => $row->id, array_slice($model->rows, $offset, $limit));
                    expect(array_column($result['items'], $field) === $expected, 'Requested slice was rewound for ' . $id);
                    expect($result['page'] === ['offset' => $offset, 'limit' => $limit, 'count' => count($expected), 'total' => $total], 'Page metadata disagrees with records.');

                    if (in_array($id, ['extensions.list', 'extensions.installed.list', 'extensions.update-sites.list'], true)) {
                        $ordering = $id === 'extensions.update-sites.list' ? 'update_site_id' : 'extension_id';
                        expect($model->state['list.ordering'] === $ordering && $model->state['list.direction'] === 'ASC', 'Installer slices have no stable identity order.');
                    }

                    if ($offset >= $total) {
                        expect($model->reads === $before, 'An empty page invoked native getItems and could rewind.');
                    }
                }
            }
        });
    }

    test('cache groups calculate the full native collection total before slicing', static function (): void {
        $model = new class {
            public array $state = [];
            public ?array $cached = null;

            public function setState(string $key, mixed $value): void
            {
                $this->state[$key] = $value;
            }

            public function getData(): array
            {
                $rows = $this->cached ??= array_map(static fn ($id): object => (object) ['id' => $id], range(1, 5));
                $limit = $this->state['list.limit'];

                return $limit === 0 ? $rows : array_slice($rows, $this->state['list.start'], $limit);
            }
        };
        $action = new FixedModelListAction('cache.groups.list', 'List cache groups.', 'com_cache', 'Cache', ['id'], nativeListProvider($model), 'getData');

        foreach ([[1, 2], [4, 2], [5, 1], [0, 2]] as [$offset, $limit]) {
            $result = $action->execute(['offset' => $offset, 'limit' => $limit]);
            expect(array_column($result['items'], 'id') === array_slice(range(1, 5), $offset, $limit), 'Cache slice changed.');
            expect($result['page']['total'] === 5, 'Cache total counted the returned slice.');
        }
    });

    test('native installer translated filtering defines the total and requested slice', static function (): void {
        $model = new class extends InstallerModel {
            public array $state = [];

            public function setState(string $key, mixed $value): void
            {
                $this->state[$key] = $value;
            }

            public function getTotal(): int
            {
                // Installer's base SQL total precedes its translated-name filter.
                return 7;
            }

            public function getItems(): array
            {
                expect($this->state['list.start'] === 0 && $this->state['list.limit'] === 0, 'Installer filtered records were paged before counting.');

                return $this->state['filter.search'] === 'no-match'
                    ? []
                    : [(object) ['extension_id' => 2], (object) ['extension_id' => 5]];
            }
        };
        $action = new ListExtensionsAction(nativeListProvider($model));

        foreach ([[0, 1], [1, 3], [2, 1], [4, 2], [0, 2]] as [$offset, $limit]) {
            $result = $action->execute(['offset' => $offset, 'limit' => $limit]);
            $expected = array_slice([2, 5], $offset, $limit);
            expect(array_column($result['items'], 'extensionId') === $expected, 'Installer returned an incorrect filtered slice.');
            expect($result['page']['total'] === 2, 'Installer advertised the unfiltered SQL total.');
        }

        $empty = $action->execute(['search' => 'no-match']);
        expect($empty['items'] === [] && $empty['page']['total'] === 0, 'No-match installer filter reported unfiltered rows.');
        expect($action->execute([])['page']['total'] === 2, 'Reused installer model retained an old filter.');
    });

    test('content language ordering resolves id aliases and approved qualified columns', static function (): void {
        $model = new class {
            public array $state = [];

            public function setState(string $key, mixed $value): void
            {
                $this->state[$key] = $value;
            }

            public function isValidFilterColumn(string $field): bool
            {
                return in_array($field, ['a.lang_id', 'a.title', 'a.ordering', 'a.published'], true);
            }

            public function getTotal(): int
            {
                return 1;
            }

            public function getItems(): array
            {
                expect(str_starts_with($this->state['list.ordering'], 'a.'), 'Ordering is ambiguous or references a nonexistent id.');

                return [(object) ['lang_id' => 3, 'title' => 'English']];
            }
        };
        $entity = array_values(array_filter(CoreEntityCatalogue::all(), static fn ($entity): bool => $entity->id === 'languages.content'))[0];
        $action = new CoreEntityAction($entity, 'list', nativeListProvider($model));
        $orders = $action->descriptor()->inputSchema['properties']['order']['enum'];

        foreach ($orders as $order) {
            $result = $action->execute(['order' => $order, 'limit' => 2]);
            expect($result['items'][0]['lang_id'] === 3 && $result['items'][0]['id'] === 3, 'Language identity alias was not normalized.');
            expect($model->state['list.ordering'] === 'a.' . ($order === 'id' ? 'lang_id' : $order), 'Advertised ordering was mapped incorrectly.');
        }

        $action->execute(['search' => 'English']);
        $action->execute([]);
        expect($model->state['filter.search'] === '', 'A reused model retained an earlier search.');
    });

    test('invalid native list totals fail without masking model defects as empty results', static function (): void {
        foreach ([-1, '1', false, null] as $total) {
            $model = new class ($total) {
                public function __construct(private mixed $total)
                {
                }

                public function setState(string $key, mixed $value): void
                {
                }

                public function getTotal(): mixed
                {
                    return $this->total;
                }

                public function getItems(): array
                {
                    throw new RuntimeException('An invalid total reached getItems.');
                }
            };

            try {
                ModelListPage::read($model, 0, 1);
                throw new RuntimeException('Invalid list total was accepted.');
            } catch (ActionException $exception) {
                expect($exception->errorCode === 'MODEL_RESULT_INVALID', 'Wrong invalid-total error category.');
            }
        }
    });
}
