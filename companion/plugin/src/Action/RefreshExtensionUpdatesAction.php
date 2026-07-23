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
 * Adapts the native update:extensions:check sequence: UpdateModel::purge(),
 * UpdateModel::findUpdates(), then a fresh Joomla model read-back.
 */
final readonly class RefreshExtensionUpdatesAction implements ActionInterface
{
    public function __construct(private ModelProviderInterface $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'extensions.updates.refresh',
            'Refresh stable extension-update metadata through Joomla UpdateModel.',
            'write',
            [['action' => 'core.manage', 'asset' => 'com_installer']],
            [
                'type' => 'object',
                'properties' => [
                    'dryRun' => ['type' => 'boolean', 'default' => true],
                    '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
                ],
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'required' => ['applied', 'dryRun', 'channel', 'preState', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'channel' => ['type' => 'string', 'const' => 'stable'],
                    'networkAccess' => ['type' => 'boolean'],
                    'preState' => ['type' => 'object'],
                    'postState' => ['type' => 'object'],
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
        Input::rejectUnknown($input, ['dryRun', '_edgeConfirmed']);
        $before = $this->count();
        $plan = [
            'applied' => false,
            'dryRun' => true,
            'channel' => 'stable',
            'preState' => ['availableUpdateCount' => $before],
            'networkAccess' => true,
            'recovery' => ['automaticRollback' => false, 'retry' => 'extensions.updates.refresh'],
            'requiresEdgeConfirmation' => true,
        ];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Extension update refresh requires signed MCP edge confirmation.');
        }

        $model = $this->models->administrator('com_installer', 'Update');

        if (!method_exists($model, 'purge') || !method_exists($model, 'findUpdates')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Installer Update model is incompatible.');
        }

        try {
            if ($model->purge() !== true || $model->findUpdates() !== true) {
                throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla did not complete the extension update refresh.');
            }
        } catch (ActionException $exception) {
            throw $exception;
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not refresh extension updates.');
        }

        $after = $this->count();

        return [
            'applied' => true,
            'dryRun' => false,
            'channel' => 'stable',
            'preState' => ['availableUpdateCount' => $before],
            'postState' => ['availableUpdateCount' => $after],
            'verification' => ['readBackCompleted' => true],
            'recovery' => ['automaticRollback' => false, 'retry' => 'extensions.updates.refresh'],
        ];
    }

    private function count(): int
    {
        $model = $this->models->administrator('com_installer', 'Update');

        if (!method_exists($model, 'getTotal')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Installer Update model cannot report status.');
        }

        try {
            return max(0, (int) $model->getTotal());
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not count extension updates.');
        }
    }
}
