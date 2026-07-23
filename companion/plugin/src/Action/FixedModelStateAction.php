<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/**
 * State adapter for a factory-selected Joomla list model.
 *
 * Instances are registered only for ManageModel::publish() and
 * UpdatesitesModel::publish(); there is no caller-selected model or method.
 */
final readonly class FixedModelStateAction implements ActionInterface
{
    /** @param list<string> $readFields */
    public function __construct(
        private string $name,
        private string $description,
        private string $component,
        private string $modelName,
        private string $idField,
        private array $readFields,
        private ModelProviderInterface $models,
    ) {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            $this->name,
            $this->description,
            'high',
            [
                ['action' => 'core.manage', 'asset' => $this->component],
                ['action' => 'core.edit.state', 'asset' => $this->component],
            ],
            [
                'type' => 'object',
                'required' => ['id', 'enabled'],
                'properties' => [
                    'id' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 2_147_483_647],
                    'enabled' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean', 'default' => true],
                    '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
                ],
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'required' => ['applied', 'dryRun', 'id', 'requestedState', 'preState', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'id' => ['type' => 'integer'],
                    'requestedState' => ['type' => 'object'],
                    'preState' => ['type' => 'object'],
                    'postState' => ['type' => ['object', 'null']],
                    'verification' => ['type' => 'object'],
                    'recovery' => ['type' => 'object'],
                    'requiresEdgeConfirmation' => ['type' => 'boolean'],
                ],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, ['id', 'enabled', 'dryRun', '_edgeConfirmed']);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $enabled = Input::boolean($input, 'enabled', false);
        $before = $this->snapshot($id);

        if ($before === null) {
            throw new ActionException('NOT_FOUND', sprintf('Joomla record %d was not found for "%s".', $id, $this->name));
        }

        $plan = [
            'applied' => false,
            'dryRun' => true,
            'id' => $id,
            'requestedState' => ['enabled' => $enabled],
            'preState' => $before,
            'recovery' => [
                'action' => $this->name,
                'input' => ['id' => $id, 'enabled' => (bool) ($before['enabled'] ?? false)],
            ],
            'requiresEdgeConfirmation' => true,
        ];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', sprintf('Action "%s" requires signed MCP edge confirmation.', $this->name));
        }

        $model = $this->models->administrator($this->component, $this->modelName);

        if (!method_exists($model, 'publish')) {
            throw new ActionException('MODEL_INCOMPATIBLE', sprintf('The Joomla model for "%s" cannot change state.', $this->name));
        }

        $ids = [$id];

        try {
            $completed = $model->publish($ids, $enabled ? 1 : 0) === true;
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not execute "%s".', $this->name));
        }

        if (!$completed) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla rejected "%s".', $this->name));
        }

        $after = $this->snapshot($id);
        $verified = $after !== null && (bool) ($after['enabled'] ?? !$enabled) === $enabled;

        if (!$verified) {
            throw new ActionException(
                'POSTCONDITION_FAILED',
                sprintf('Joomla did not verify the requested state for "%s".', $this->name),
            );
        }

        return [
            'applied' => true,
            'dryRun' => false,
            'id' => $id,
            'requestedState' => ['enabled' => $enabled],
            'preState' => $before,
            'postState' => $after,
            'verification' => ['readBackCompleted' => $after !== null, 'matchesRequestedState' => $verified],
            'recovery' => [
                'action' => $this->name,
                'input' => ['id' => $id, 'enabled' => (bool) ($before['enabled'] ?? false)],
            ],
        ];
    }

    /** @return array<string, int|string|bool|null>|null */
    private function snapshot(int $id): ?array
    {
        $model = $this->models->administrator($this->component, $this->modelName);

        if (!method_exists($model, 'setState') || !method_exists($model, 'getItems')) {
            throw new ActionException('MODEL_INCOMPATIBLE', sprintf('The Joomla model for "%s" cannot be verified.', $this->name));
        }

        $model->setState('list.start', 0);
        $model->setState('list.limit', 2);
        $model->setState('filter.search', 'id:' . $id);

        try {
            $items = $model->getItems();
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not verify "%s".', $this->name));
        }

        if (!is_array($items)) {
            throw new ActionException('MODEL_RESULT_INVALID', sprintf('Joomla returned invalid verification data for "%s".', $this->name));
        }

        foreach ($items as $item) {
            if (!is_object($item) && !is_array($item)) {
                continue;
            }

            $source = is_object($item) ? get_object_vars($item) : $item;

            if ((int) ($source[$this->idField] ?? 0) !== $id) {
                continue;
            }

            $snapshot = [];

            foreach ($this->readFields as $field) {
                $value = $source[$field] ?? null;
                $snapshot[$field] = is_scalar($value) || $value === null ? $value : null;
            }

            $snapshot['enabled'] = (bool) ($source['enabled'] ?? false);

            return $snapshot;
        }

        return null;
    }
}
