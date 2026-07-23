<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use JsonException;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final readonly class ListExtensionsAction implements ActionInterface
{
    public function __construct(
        private ModelProviderInterface $models,
        private string $actionName = 'extensions.list',
    )
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            $this->actionName,
            'List installed extension metadata through the Joomla Installer Manage model.',
            'read',
            [['action' => 'core.manage', 'asset' => 'com_installer']],
            [
                'type' => 'object',
                'properties' => [
                    'offset' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 1_000_000],
                    'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100],
                    'search' => ['type' => 'string', 'maxLength' => 200],
                    'type' => ['type' => 'string', 'enum' => ['', 'component', 'module', 'plugin', 'template', 'library', 'file', 'package', 'language']],
                ],
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'required' => ['items', 'page'],
                'properties' => [
                    'items' => ['type' => 'array', 'items' => ['type' => 'object']],
                    'page' => ['type' => 'object'],
                ],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, ['offset', 'limit', 'search', 'type']);
        $offset = Input::integer($input, 'offset', 0, 0, 1_000_000);
        $limit = Input::integer($input, 'limit', 20, 1, 100);
        $search = Input::text($input, 'search');
        $type = (string) Input::choice(
            $input,
            'type',
            '',
            ['', 'component', 'module', 'plugin', 'template', 'library', 'file', 'package', 'language'],
        );
        $model = $this->models->administrator('com_installer', 'Manage');

        if (!method_exists($model, 'setState') || !method_exists($model, 'getItems')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Installer Manage model is incompatible.');
        }

        $model->setState('list.start', $offset);
        $model->setState('list.limit', $limit);
        $model->setState('filter.search', $search);
        $model->setState('filter.type', $type);
        $rawItems = $model->getItems();

        if (!is_array($rawItems)) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla Installer Manage model returned an invalid result.');
        }

        $items = [];

        foreach ($rawItems as $item) {
            if (!is_object($item)) {
                continue;
            }

            $manifest = $this->manifest((string) ($item->manifest_cache ?? ''));
            $items[] = [
                'extensionId' => (int) ($item->extension_id ?? 0),
                'name' => (string) ($item->name ?? ''),
                'type' => (string) ($item->type ?? ''),
                'element' => (string) ($item->element ?? ''),
                'folder' => (string) ($item->folder ?? ''),
                'clientId' => (int) ($item->client_id ?? 0),
                'enabled' => (bool) ($item->enabled ?? false),
                'protected' => (bool) ($item->protected ?? false),
                'version' => isset($manifest['version']) && is_scalar($manifest['version'])
                    ? (string) $manifest['version']
                    : null,
            ];
        }

        $total = method_exists($model, 'getTotal') ? (int) $model->getTotal() : count($items);

        return [
            'items' => $items,
            'page' => ['offset' => $offset, 'limit' => $limit, 'count' => count($items), 'total' => $total],
        ];
    }

    /** @return array<string, mixed> */
    private function manifest(string $json): array
    {
        if ($json === '') {
            return [];
        }

        try {
            $value = json_decode($json, true, 16, JSON_THROW_ON_ERROR);

            return is_array($value) ? $value : [];
        } catch (JsonException) {
            return [];
        }
    }
}
