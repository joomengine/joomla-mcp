<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use Joomla\DI\ContainerResource;
use ReflectionMethod;
use ReflectionProperty;
use VDM\Joomla\Abstraction\Remote\Get;
use VDM\Joomla\Abstraction\Remote\Set;
use VDM\Joomla\Componentbuilder\Factory;
use VDM\Joomla\Componentbuilder\Utilities\RepoHelper;
use VDM\Joomla\Data\Item;
use VDM\Joomla\Data\Items;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

/** Inspect the native builder's actual results and re-read the affected data with its selected repository. */
final class PackageVerification
{
    private int $reads = 0;
    private int $matches = 0;
    private int $different = 0;
    private int $unknown = 0;
    private array $dependencies = [];

    public function inspect(object $command, string $verb, string $entity, array $selectors, ?string $repoId, array $messages): array
    {
        $push = $verb === 'push';
        $skippedPushes = 0;
        try {
            $builder = self::property($command, $push ? 'set' : 'get');
            $container = self::property($builder, 'container');
            $data = $this->instance($container, $push ? 'Data.Items' : 'Data.Item');
            if ($data::class !== ($push ? Items::class : Item::class)) {
                throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'A plain local read-back adapter is required.');
            }
            $reader = clone $data;
            $native = $push ? [] : self::property($builder, 'results');
            $this->different += count($native['not_found'] ?? []);
            $targets = [];
            $assets = [];
            foreach (['local', 'added'] as $category) {
                foreach (($native[$category] ?? []) as $guid => $area) {
                    if (!is_string($area)) {
                        $this->unknown++;
                        continue;
                    }
                    if (Factory::getArea($area) === null) {
                        $assets[(string) $guid] = $area;
                        continue;
                    }
                    $getter = $this->handler($container, $area, false);
                    $targets[$area][$getter->getGuidField()][(string) $guid] = $category;
                }
            }
            foreach (self::property($builder, 'tracker')->get('save', []) as $area => $saved) {
                foreach ($saved as $keyAndId => $ok) {
                    $pair = explode('|', (string) $keyAndId, 2);
                    if (count($pair) !== 2 || !preg_match('/^[a-z][a-z0-9_]{0,63}$/D', $pair[0]) || strlen($pair[1]) > 191) {
                        $this->unknown++;
                        continue;
                    }
                    if ($ok !== true) {
                        if ($push && $ok === false) {
                            $skippedPushes++;
                        } else {
                            $this->different++;
                        }
                    }
                    $targets[$area][$pair[0]][$pair[1]] ??= 'saved';
                }
            }

            // JCB can resolve a configured entity-specific alias. Every requested selector
            // must be accounted for even when the native command returns exit code zero.
            if (!$push && count(array_filter($selectors, static fn ($s) => !preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/Di', $s))) > 0) {
                $resolved = $builder->getValidGuids($entity, $selectors);
                if (count($resolved) !== count($selectors)) {
                    $this->different++;
                }
                $selectors = $resolved;
            }
            $selectedIds = [];
            $customRepo = $repoId === null ? null : RepoHelper::getRepo($repoId);
            if ($repoId !== null && !is_object($customRepo)) {
                throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'The selected native repository could not be reloaded.');
            }
            foreach ($targets as $area => $keys) {
                $handler = $this->handler($container, $area, $push);
                foreach ($keys as $key => $records) {
                    foreach ($records as $id => $category) {
                        $this->reserveRead();
                        $id = (string) $id;
                        if ($push) {
                            $rows = $reader->table($area)->get([$id], $key) ?? [];
                            $record = reset($rows);
                        } else {
                            $record = $reader->table($area)->get($id, $key);
                        }
                        if (!is_object($record)) {
                            $this->different++;
                            continue;
                        }
                        $guid = (string) ($record->{$handler->getGuidField()} ?? '');
                        if ($area === $entity) {
                            $selectedIds[$guid] = true;
                        }
                        if ($push) {
                            $this->checkPush($handler, $record);
                        } elseif ($category === 'local' && in_array($verb, ['get', 'init'], true)) {
                            // JCB deliberately retained this local record; no import or remote equality is implied.
                            $this->matches++;
                        } else {
                            $this->checkImport($handler, $record, $guid, $customRepo);
                        }
                    }
                }
            }
            foreach ($selectors as $id) {
                if (!isset($selectedIds[$id])) {
                    $this->different++;
                }
            }
            $files = new FileComparison();
            foreach ($this->dependencies as $dependency) {
                $area = $dependency['entity'] ?? null;
                $key = $dependency['key'] ?? null;
                $value = $dependency['value'] ?? null;
                if (($dependency['table'] ?? null) === 'file_system') {
                    if (!in_array($area, ['file', 'folder'], true) || !is_string($key)) {
                        $this->unknown++;
                        continue;
                    }
                    $direction = $push ? 'Set' : 'Get';
                    $kind = ucfirst($area);
                    $service = $this->instance($container, $kind . '.Remote.' . $direction);
                    $normalize = $this->instance($container, 'Utilities.Normalize');
                    if ($service::class !== 'VDM\\Joomla\\Componentbuilder\\Package\\Remote\\' . $direction . $kind
                        || $normalize::class !== 'VDM\\Joomla\\Componentbuilder\\Utilities\\Normalize') {
                        $this->unknown++;
                        continue;
                    }
                    $retained = isset($native['local'][$key]) && $native['local'][$key] === $value;
                    if ($files->matches($dependency, $service, $normalize, $push, $customRepo, $retained)) {
                        $this->matches++;
                        unset($assets[$key]);
                    } else {
                        $this->different++;
                    }
                    continue;
                }
                if (!is_string($area) || Factory::getArea($area) === null
                    || !is_string($key) || !preg_match('/^[a-z][a-z0-9_]{0,63}$/D', $key)
                    || !is_string($value) || strlen($value) > 191) {
                    $this->unknown++;
                    continue;
                }
                $this->reserveRead();
                if (!$push) {
                    $reader->table($area)->get($value, $key) === null ? $this->different++ : $this->matches++;
                    continue;
                }
                $guidField = $this->handler($container, $area, true)->getGuidField();
                $rows = $reader->table($area)->get([$value], $key) ?? [];
                if ($rows === []) {
                    $this->different++;
                }
                foreach ($rows as $record) {
                    if (!isset($targets[$area][$guidField][$record->{$guidField} ?? ''])) {
                        $this->unknown++;
                    }
                }
            }
            $this->unknown += count($assets);
        } catch (\Throwable) {
            // Unsupported or unavailable verification must never repeat the completed command.
            $this->unknown++;
        }
        // A native no-op warning is eligible only when fresh reads proved every targeted
        // branch, index and dependency. A missing SHA with different bytes still fails.
        $inSyncWarnings = $messages['inSyncWarnings'] ?? 0;
        $this->different += max(0, $skippedPushes - $inSyncWarnings);
        $status = $this->different > 0 || $messages['warnings'] > $inSyncWarnings ? 'partial'
            : ($this->unknown > 0 || $this->matches < 1 ? 'unverified' : 'verified');
        return ['status' => $status, 'selectedCount' => count($selectors), 'matchedCount' => $this->matches,
            'differentCount' => $this->different, 'unverifiedCount' => $this->unknown, ...$messages];
    }

    private function checkImport(Get $handler, object $record, string $guid, ?object $customRepo): void
    {
        $grep = clone self::property($handler, 'grep');
        $tracker = new ReflectionProperty($grep, 'tracker');
        $tracker->setValue($grep, clone $tracker->getValue($grep));
        $grep->paths = array_map(self::withoutIndex(...), $grep->paths ?? []);
        $grep->setBranchField('read_branch');
        $repo = $customRepo === null ? null : self::withoutIndex($customRepo);
        if ($repo !== null && !$grep->validRepo($repo)) {
            $this->different++;
            return;
        }
        $this->reserveRead();
        $upstream = $grep->get($guid, ['remote'], $repo);
        if (!is_object($upstream)) {
            $this->different++;
            return;
        }
        $this->dependencies($upstream);
        $this->compare($handler->mapItem($record), $handler->mapItem($upstream));
    }

    private function checkPush(Set $handler, object $row): void
    {
        $expected = $handler->mapItem(clone $row);
        $property = new ReflectionProperty($handler, 'resolver');
        if ($property->isInitialized($handler) && ($original = $property->getValue($handler)) !== null) {
            if ($original::class !== 'VDM\\Joomla\\Componentbuilder\\Package\\Dependency\\Resolver') {
                $this->unknown++;
                return;
            }
            $resolver = clone $original;
            $tracker = new ReflectionProperty($resolver, 'tracker');
            $tracker->setValue($resolver, clone $tracker->getValue($resolver));
            $items = new ReflectionProperty($resolver, 'items');
            $items->setValue($resolver, new ReadOnlyItems($items->getValue($resolver)));
            foreach ($resolver->extract($expected) ?? [] as $key => $value) {
                $expected->{$key} = $value;
            }
        }
        $this->dependencies($expected);
        $git = self::property($handler, 'git');
        $grep = self::property($handler, 'grep');
        $matched = 0;
        foreach ($handler->repos as $repo) {
            $branch = $repo->write_branch ?? '';
            if ($branch === '' || $branch === 'default' || !(new ReflectionMethod($handler, 'targetRepo'))->invoke($handler, $row, $repo)) {
                continue;
            }
            $matched++;
            $this->reserveRead();
            $git->setTarget($repo->target ?? 'gitea');
            try {
                $grep->loadApi($git, $repo->base ?? null, $repo->token ?? null);
                $path = (new ReflectionMethod($handler, 'index_map_IndexSettingsPath'))->invoke($handler, $expected);
                $remote = $git->get($repo->organisation, $repo->repository, $path, $branch);
                $index = $git->get($repo->organisation, $repo->repository, $handler->getIndexPath(), $branch);
                $entry = $index->{$expected->{$handler->getGuidField()}} ?? null;
                $wanted = $handler->getIndexItem($expected);
                $settings = clone $expected;
                if (!is_object($entry) || !is_array($wanted) || ($entry->settings ?? null) !== ($wanted['settings'] ?? null)
                    || ($entry->path ?? null) !== ($wanted['path'] ?? null)) {
                    $this->different++;
                }
                if ($handler::class === 'VDM\\Joomla\\Componentbuilder\\Power\\Remote\\Set') {
                    $path = (new ReflectionMethod($handler, 'index_map_PowerPath'))->invoke($handler, $expected);
                    $code = $git->get($repo->organisation, $repo->repository, $path, $branch);
                    if (!is_string($code) || !hash_equals((string) ($expected->main_class_code ?? ''), $code)) {
                        $this->different++;
                    }
                    unset($settings->main_class_code, $settings->extends_name, $settings->implement_names);
                }
                $this->compare($settings, $remote);
            } finally {
                $git->reset_();
            }
        }
        if ($matched === 0) {
            $this->different++;
        }
    }

    private static function withoutIndex(object $repo): object
    {
        $copy = clone $repo;
        unset($copy->index);
        return $copy;
    }

    private function dependencies(object $item): void
    {
        foreach ((array) ($item->{'@dependencies'} ?? []) as $dependency) {
            $this->dependencies[self::canonical($dependency)] = (array) $dependency;
            if (count($this->dependencies) > 500) {
                throw new ActionException('JCB_VERIFY_LIMIT', 'Too many package dependencies to verify.');
            }
        }
    }

    private function compare(mixed $local, mixed $remote): void
    {
        if (!is_object($local) || !is_object($remote)) {
            $this->different++;
            return;
        }
        $documents = [];
        foreach ([$local, $remote] as $document) {
            $document = clone $document;
            if (property_exists($local, '@dependencies') || property_exists($remote, '@dependencies')) {
                $dependencies = array_map(self::canonical(...), (array) ($document->{'@dependencies'} ?? []));
                sort($dependencies);
                $document->{'@dependencies'} = $dependencies;
            }
            $documents[] = hash('sha256', self::canonical($document));
        }
        hash_equals(...$documents) ? $this->matches++ : $this->different++;
    }

    private static function canonical(mixed $value): string
    {
        if (is_object($value) || (is_array($value) && !array_is_list($value))) {
            $entries = (array) $value;
            ksort($entries, SORT_STRING);
            return 'object:' . serialize(array_map(self::canonical(...), $entries));
        }
        if (is_array($value)) {
            return 'array:' . serialize(array_map(self::canonical(...), $value));
        }
        return serialize($value);
    }

    private function reserveRead(): void
    {
        if (++$this->reads > 500) {
            throw new ActionException('JCB_VERIFY_LIMIT', 'Native read-back exceeded its verification limit.');
        }
    }

    private function handler(object $container, string $entity, bool $push): Get|Set
    {
        $area = Factory::getArea($entity);
        if ($area === null) {
            throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'Unknown JCB verification entity.');
        }
        return $this->instance($container, $area . ($push ? '.Remote.Set' : '.Remote.Get'));
    }

    private function instance(object $container, string $key): object
    {
        $resource = $container->getResource($key);
        $instance = $resource instanceof ContainerResource ? self::property($resource, 'instance') : null;
        if (!is_object($instance)) {
            throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'Missing initialized native verification service.');
        }
        return $instance;
    }

    private static function property(object $instance, string $name): mixed
    {
        return (new ReflectionProperty($instance, $name))->getValue($instance);
    }
}
