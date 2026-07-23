<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\NativeOperationsInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/** Adapts Joomla's native site:down and site:up console commands. */
final readonly class SiteStateAction implements ActionInterface
{
    public function __construct(
        private NativeOperationsInterface $operations,
        private bool $write = false,
    ) {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            $this->write ? 'site.state.set' : 'site.state.get',
            $this->write
                ? 'Set and verify Joomla site offline state through site:down or site:up.'
                : 'Read Joomla site offline state from native configuration.',
            $this->write ? 'high' : 'read',
            [['action' => 'core.admin', 'asset' => 'com_config']],
            $this->write ? [
                'type' => 'object',
                'required' => ['offline'],
                'properties' => [
                    'offline' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean', 'default' => true],
                    '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
                ],
                'additionalProperties' => false,
            ] : ['type' => 'object', 'properties' => [], 'additionalProperties' => false],
            $this->write ? [
                'type' => 'object',
                'required' => ['applied', 'dryRun', 'requestedState', 'preState', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'requestedState' => ['type' => 'object'],
                    'preState' => ['type' => 'object'],
                    'postState' => ['type' => 'object'],
                    'verification' => ['type' => 'object'],
                    'recovery' => ['type' => 'object'],
                    'requiresEdgeConfirmation' => ['type' => 'boolean'],
                ],
                'additionalProperties' => false,
            ] : [
                'type' => 'object',
                'required' => ['offline'],
                'properties' => ['offline' => ['type' => 'boolean']],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        if (!$this->write) {
            Input::rejectUnknown($input, []);

            return ['offline' => $this->operations->siteOfflineState()];
        }

        Input::rejectUnknown($input, ['offline', 'dryRun', '_edgeConfirmed']);
        $offline = Input::boolean($input, 'offline', false);
        $before = $this->operations->siteOfflineState();
        $plan = [
            'applied' => false,
            'dryRun' => true,
            'requestedState' => ['offline' => $offline],
            'preState' => ['offline' => $before],
            'recovery' => ['action' => 'site.state.set', 'input' => ['offline' => $before]],
            'requiresEdgeConfirmation' => true,
        ];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Site state changes require signed MCP edge confirmation.');
        }

        $exitCode = $this->operations->setSiteOffline($offline);
        $after = $this->operations->siteOfflineState();

        if ($exitCode !== 0 || $after !== $offline) {
            throw new ActionException('POSTCONDITION_FAILED', 'Joomla did not verify the requested site state.');
        }

        return [
            'applied' => true,
            'dryRun' => false,
            'requestedState' => ['offline' => $offline],
            'preState' => ['offline' => $before],
            'postState' => ['offline' => $after],
            'verification' => ['nativeExitCode' => $exitCode, 'matchesRequestedState' => $after === $offline],
            'recovery' => ['action' => 'site.state.set', 'input' => ['offline' => $before]],
        ];
    }
}
