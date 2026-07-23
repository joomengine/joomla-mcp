<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/** Adapts Joomla CacheModel::purge(), also used by core cache:clean expired. */
final readonly class PurgeExpiredCacheAction implements ActionInterface
{
    public function __construct(private ModelProviderInterface $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'cache.expired.purge',
            'Garbage-collect expired entries through Joomla CacheModel::purge().',
            'write',
            [
                ['action' => 'core.manage', 'asset' => 'com_cache'],
                ['action' => 'core.delete', 'asset' => 'com_cache'],
            ],
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
                'required' => ['applied', 'dryRun', 'scope', 'verification', 'recovery'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'scope' => ['type' => 'string', 'const' => 'expired-only'],
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

        if (Input::boolean($input, 'dryRun', true)) {
            return [
                'applied' => false,
                'dryRun' => true,
                'scope' => 'expired-only',
                'verification' => ['method' => 'Joomla CacheModel::purge return value', 'completed' => false],
                'recovery' => ['reversible' => false, 'reason' => 'Expired cache entries are disposable derived data.'],
                'requiresEdgeConfirmation' => true,
            ];
        }

        $this->confirm($input);
        $model = $this->models->administrator('com_cache', 'Cache');

        if (!method_exists($model, 'purge')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Cache model cannot purge expired entries.');
        }

        try {
            $completed = $model->purge() === true;
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not purge expired cache entries.');
        }

        if (!$completed) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla reported that expired cache purging failed.');
        }

        return [
            'applied' => true,
            'dryRun' => false,
            'scope' => 'expired-only',
            'verification' => ['method' => 'Joomla CacheModel::purge return value', 'completed' => true],
            'recovery' => ['reversible' => false, 'reason' => 'Expired cache entries are disposable derived data.'],
        ];
    }

    /** @param array<string, mixed> $input */
    private function confirm(array $input): void
    {
        if (!Input::boolean($input, '_edgeConfirmed', false)) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Expired-cache purging requires signed MCP edge confirmation.');
        }
    }
}
