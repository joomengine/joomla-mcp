<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final readonly class FixedModelListAction implements ActionInterface
{
    /** @param list<string> $fields */
    public function __construct(
        private string $name,
        private string $description,
        private string $component,
        private string $modelName,
        private array $fields,
        private ModelProviderInterface $models,
        private string $getter = 'getItems',
    ) {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            $this->name,
            $this->description,
            'read',
            [['action' => 'core.manage', 'asset' => $this->component]],
            [
                'type' => 'object',
                'properties' => [
                    'offset' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 1_000_000],
                    'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100],
                    'search' => ['type' => 'string', 'maxLength' => 200],
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
        Input::rejectUnknown($input, ['offset', 'limit', 'search']);
        $offset = Input::integer($input, 'offset', 0, 0, 1_000_000);
        $limit = Input::integer($input, 'limit', 20, 1, 100);
        $search = Input::text($input, 'search');
        $model = $this->models->administrator($this->component, $this->modelName);

        if (!method_exists($model, 'setState') || !method_exists($model, $this->getter)) {
            throw new ActionException('MODEL_INCOMPATIBLE', sprintf('The Joomla model for "%s" is incompatible.', $this->name));
        }

        $model->setState('list.start', $offset);
        $model->setState('list.limit', $limit);
        $model->setState('filter.search', $search);

        try {
            $rawItems = $model->{$this->getter}();
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not execute "%s".', $this->name));
        }

        if (!is_array($rawItems)) {
            throw new ActionException('MODEL_RESULT_INVALID', sprintf('The Joomla model for "%s" returned an invalid list.', $this->name));
        }

        $items = [];

        foreach ($rawItems as $item) {
            if (!is_object($item) && !is_array($item)) {
                continue;
            }

            $source = is_object($item) ? get_object_vars($item) : $item;
            $normalised = [];

            foreach ($this->fields as $field) {
                $value = $source[$field] ?? null;
                $normalised[$field] = is_scalar($value) || $value === null ? $value : null;
            }

            $items[] = $normalised;
        }

        try {
            $total = method_exists($model, 'getTotal') ? (int) $model->getTotal() : count($items);
        } catch (Throwable) {
            $total = count($items);
        }

        return [
            'items' => $items,
            'page' => ['offset' => $offset, 'limit' => $limit, 'count' => count($items), 'total' => max(0, $total)],
        ];
    }
}
