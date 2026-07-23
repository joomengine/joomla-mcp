<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;
use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaModelProvider;

final readonly class ListArticlesAction implements ActionInterface
{
    private const FIELDS = [
        'id', 'title', 'alias', 'state', 'catid', 'access', 'language',
        'created', 'modified', 'publish_up', 'publish_down',
    ];

    public function __construct(private JoomlaModelProvider $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'content.articles.list',
            'List article metadata through the Joomla administrator Articles model.',
            'read',
            [['action' => 'core.manage', 'asset' => 'com_content']],
            [
                'type' => 'object',
                'properties' => [
                    'offset' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 1_000_000],
                    'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100],
                    'search' => ['type' => 'string', 'maxLength' => 200],
                    'state' => ['type' => 'integer', 'enum' => [-2, 0, 1, 2]],
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
        Input::rejectUnknown($input, ['offset', 'limit', 'search', 'state']);
        $offset = Input::integer($input, 'offset', 0, 0, 1_000_000);
        $limit = Input::integer($input, 'limit', 20, 1, 100);
        $search = Input::text($input, 'search');
        $state = Input::choice($input, 'state', 1, [-2, 0, 1, 2]);
        $model = $this->models->administrator('com_content', 'Articles');

        if (!method_exists($model, 'setState') || !method_exists($model, 'getItems')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Articles model is incompatible.');
        }

        $model->setState('list.start', $offset);
        $model->setState('list.limit', $limit);
        $model->setState('filter.published', $state);

        if ($search !== '') {
            $model->setState('filter.search', $search);
        }

        $rawItems = $model->getItems();

        if (!is_array($rawItems)) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla Articles model returned an invalid result.');
        }

        $items = [];

        foreach ($rawItems as $item) {
            if (is_object($item)) {
                $items[] = $this->normalise($item);
            }
        }
        $total = method_exists($model, 'getTotal') ? (int) $model->getTotal() : count($items);

        return [
            'items' => $items,
            'page' => [
                'offset' => $offset,
                'limit' => $limit,
                'count' => count($items),
                'total' => $total,
            ],
        ];
    }

    /** @return array<string, int|string|null> */
    private function normalise(object $item): array
    {
        $result = [];

        foreach (self::FIELDS as $field) {
            $value = $item->{$field} ?? null;
            $result[$field] = is_int($value) || is_string($value) ? $value : null;
        }

        return $result;
    }
}
