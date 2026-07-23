<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\NativeOperationsInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/** Adapts Joomla TasksRunCommand and TasksStateCommand for one explicit task. */
final readonly class SchedulerTaskAction implements ActionInterface
{
    private const SNAPSHOT_FIELDS = [
        'id', 'title', 'type', 'state', 'last_exit_code', 'locked', 'last_execution',
        'next_execution', 'times_executed', 'times_failed', 'priority', 'note',
    ];

    public function __construct(
        private string $operation,
        private ModelProviderInterface $models,
        private NativeOperationsInterface $operations,
    ) {
        if (!in_array($operation, ['run', 'state'], true)) {
            throw new \InvalidArgumentException('Unsupported scheduler operation.');
        }
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'scheduler.tasks.' . ($this->operation === 'state' ? 'state.set' : 'run'),
            $this->operation === 'state'
                ? 'Change one Joomla scheduled task through scheduler:state.'
                : 'Run one explicit Joomla scheduled task through scheduler:run.',
            'high',
            $this->operation === 'state' ? [
                ['action' => 'core.manage', 'asset' => 'com_scheduler'],
                ['action' => 'core.edit.state', 'asset' => 'com_scheduler'],
            ] : [['action' => 'core.manage', 'asset' => 'com_scheduler']],
            [
                'type' => 'object',
                'required' => $this->operation === 'state' ? ['id', 'state'] : ['id'],
                'properties' => array_filter([
                    'id' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 2_147_483_647],
                    'state' => $this->operation === 'state' ? ['type' => 'integer', 'enum' => [-2, 0, 1]] : null,
                    'dryRun' => ['type' => 'boolean', 'default' => true],
                    '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
                ]),
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'required' => ['applied', 'dryRun', 'operation', 'preState', 'requestedState', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'operation' => ['type' => 'string', 'enum' => ['run', 'state']],
                    'preState' => ['type' => 'object'],
                    'postState' => ['type' => ['object', 'null']],
                    'requestedState' => ['type' => ['object', 'null']],
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
        $allowed = $this->operation === 'state'
            ? ['id', 'state', 'dryRun', '_edgeConfirmed']
            : ['id', 'dryRun', '_edgeConfirmed'];
        Input::rejectUnknown($input, $allowed);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $state = $this->operation === 'state'
            ? (int) Input::choice($input, 'state', 0, [-2, 0, 1])
            : null;
        $before = $this->snapshot($id);

        if ($before === null) {
            throw new ActionException('NOT_FOUND', sprintf('Scheduled task %d was not found.', $id));
        }

        $plan = [
            'applied' => false,
            'dryRun' => true,
            'operation' => $this->operation,
            'preState' => $before,
            'requestedState' => $state === null ? null : ['state' => $state],
            'recovery' => $state === null
                ? ['automaticRollback' => false, 'reason' => 'Task side effects are task-defined.']
                : ['action' => 'scheduler.tasks.state.set', 'input' => ['id' => $id, 'state' => (int) ($before['state'] ?? 0)]],
            'requiresEdgeConfirmation' => true,
        ];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Scheduler operations require signed MCP edge confirmation.');
        }

        $exitCode = $this->operation === 'state'
            ? $this->operations->setSchedulerTaskState($id, (int) $state)
            : $this->operations->runSchedulerTask($id);
        $after = $this->snapshot($id);
        $matches = $this->operation === 'state'
            ? $after !== null && (int) ($after['state'] ?? 999) === $state
            : $exitCode === 0;

        if ($this->operation === 'state' && ($exitCode !== 0 || !$matches)) {
            throw new ActionException('POSTCONDITION_FAILED', 'Joomla did not verify the requested scheduler task state.');
        }

        return [
            'applied' => $exitCode === 0,
            'dryRun' => false,
            'operation' => $this->operation,
            'preState' => $before,
            'postState' => $after,
            'requestedState' => $state === null ? null : ['state' => $state],
            'verification' => ['nativeExitCode' => $exitCode, 'matchesExpectedOutcome' => $matches],
            'recovery' => $state === null
                ? ['automaticRollback' => false, 'reason' => 'Task side effects are task-defined.']
                : ['action' => 'scheduler.tasks.state.set', 'input' => ['id' => $id, 'state' => (int) ($before['state'] ?? 0)]],
        ];
    }

    /** @return array<string, int|string|bool|null>|null */
    private function snapshot(int $id): ?array
    {
        $model = $this->models->administrator('com_scheduler', 'Task');

        if (!method_exists($model, 'getItem')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Scheduler Task model cannot verify tasks.');
        }

        try {
            $item = $model->getItem($id);
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not read scheduled task %d.', $id));
        }

        if (!is_object($item) && !is_array($item)) {
            return null;
        }

        $source = is_object($item) ? get_object_vars($item) : $item;

        if ((int) ($source['id'] ?? 0) !== $id) {
            return null;
        }

        $snapshot = [];

        foreach (self::SNAPSHOT_FIELDS as $field) {
            $value = $source[$field] ?? null;
            $snapshot[$field] = is_scalar($value) || $value === null ? $value : null;
        }

        return $snapshot;
    }
}
