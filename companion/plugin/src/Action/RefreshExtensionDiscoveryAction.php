<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/** Adapts Joomla DiscoverModel::discover(), the implementation of extension:discover. */
final readonly class RefreshExtensionDiscoveryAction implements ActionInterface
{
    public function __construct(private ModelProviderInterface $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'extensions.discovered.refresh',
            'Refresh Joomla discovered-extension metadata through DiscoverModel::discover().',
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
                'required' => ['applied', 'dryRun', 'preState', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'operation' => ['type' => 'string'],
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
            'preState' => ['discoveredCount' => $before],
            'operation' => 'purge-and-rescan-discovered-extension-metadata',
            'recovery' => ['automaticRollback' => false, 'retry' => 'extensions.discovered.refresh'],
            'requiresEdgeConfirmation' => true,
        ];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        $this->confirm($input);
        $model = $this->models->administrator('com_installer', 'Discover');

        if (!method_exists($model, 'discover')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Installer Discover model is incompatible.');
        }

        try {
            $newlyDiscovered = $model->discover();
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not refresh discovered extensions.');
        }

        if (!is_int($newlyDiscovered) || $newlyDiscovered < 0) {
            throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned an invalid discovery count.');
        }

        $after = $this->count();

        return [
            'applied' => true,
            'dryRun' => false,
            'preState' => ['discoveredCount' => $before],
            'postState' => ['discoveredCount' => $after, 'newlyDiscovered' => $newlyDiscovered],
            'verification' => ['readBackCompleted' => true, 'nativeCount' => $newlyDiscovered],
            'recovery' => ['automaticRollback' => false, 'retry' => 'extensions.discovered.refresh'],
        ];
    }

    private function count(): int
    {
        $model = $this->models->administrator('com_installer', 'Discover');

        if (!method_exists($model, 'getTotal')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Installer Discover model cannot report status.');
        }

        try {
            return max(0, (int) $model->getTotal());
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not count discovered extensions.');
        }
    }

    /** @param array<string, mixed> $input */
    private function confirm(array $input): void
    {
        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Extension discovery refresh requires signed MCP edge confirmation.');
        }
    }
}
