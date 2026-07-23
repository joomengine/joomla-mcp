<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\NativeOperationsInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/** Adapts Joomla SessionGcCommand and SessionMetadataGcCommand. */
final readonly class SessionGarbageCollectionAction implements ActionInterface
{
    public function __construct(
        private NativeOperationsInterface $operations,
        private bool $metadata = false,
    ) {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            $this->metadata ? 'sessions.metadata.gc' : 'sessions.data.gc',
            $this->metadata
                ? 'Delete expired Joomla session metadata through session:metadata:gc.'
                : 'Run Joomla session storage garbage collection through session:gc.',
            'high',
            [['action' => 'core.admin', 'asset' => 'com_config']],
            [
                'type' => 'object',
                'properties' => array_filter([
                    'application' => $this->metadata ? null : ['type' => 'string', 'enum' => ['site', 'administrator'], 'default' => 'site'],
                    'dryRun' => ['type' => 'boolean', 'default' => true],
                    '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
                ]),
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'required' => ['applied', 'dryRun', 'preState', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
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
        $allowed = $this->metadata ? ['dryRun', '_edgeConfirmed'] : ['application', 'dryRun', '_edgeConfirmed'];
        Input::rejectUnknown($input, $allowed);
        $application = $this->metadata
            ? null
            : (string) Input::choice($input, 'application', 'site', ['site', 'administrator']);
        $scope = $this->metadata ? 'expired-session-metadata' : 'expired-session-data';
        $plan = [
            'applied' => false,
            'dryRun' => true,
            'preState' => ['scope' => $scope, 'application' => $application, 'eligibleCount' => null],
            'recovery' => ['reversible' => false, 'reason' => 'Only expired session records are eligible.'],
            'requiresEdgeConfirmation' => true,
        ];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Session garbage collection requires signed MCP edge confirmation.');
        }

        $exitCode = $this->metadata
            ? $this->operations->garbageCollectSessionMetadata()
            : $this->operations->garbageCollectSessions((string) $application);

        return [
            'applied' => $exitCode === 0,
            'dryRun' => false,
            'preState' => ['scope' => $scope, 'application' => $application, 'eligibleCount' => null],
            'postState' => ['scope' => $scope, 'application' => $application],
            'verification' => ['nativeExitCode' => $exitCode, 'completed' => $exitCode === 0],
            'recovery' => ['reversible' => false, 'reason' => 'Only expired session records are eligible.'],
        ];
    }
}
