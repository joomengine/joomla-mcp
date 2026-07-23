<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final readonly class CleanCacheAction implements ActionInterface
{
    public function __construct(private ModelProviderInterface $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'cache.clean',
            'Clean an explicit bounded list of Joomla cache groups.',
            'write',
            [
                ['action' => 'core.manage', 'asset' => 'com_cache'],
                ['action' => 'core.delete', 'asset' => 'com_cache'],
            ],
            [
                'type' => 'object',
                'required' => ['groups'],
                'properties' => [
                    'groups' => [
                        'type' => 'array', 'minItems' => 1, 'maxItems' => 50, 'uniqueItems' => true,
                        'items' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 128, 'pattern' => '^[A-Za-z0-9_.-]+$'],
                    ],
                    'dryRun' => ['type' => 'boolean', 'default' => true],
                    '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
                ],
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'required' => ['applied', 'dryRun', 'groups'],
                'properties' => [
                    'applied' => ['type' => 'boolean'],
                    'dryRun' => ['type' => 'boolean'],
                    'groups' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'failed' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'requiresEdgeConfirmation' => ['type' => 'boolean'],
                ],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, ['groups', 'dryRun', '_edgeConfirmed']);
        $groups = $input['groups'] ?? null;

        if (!is_array($groups) || !array_is_list($groups) || $groups === [] || count($groups) > 50) {
            throw new ActionException('INVALID_INPUT', 'Input "groups" must be a non-empty list of at most 50 cache groups.');
        }

        $cleanGroups = [];

        foreach ($groups as $group) {
            if (!is_string($group) || strlen($group) > 128 || !preg_match('/^[A-Za-z0-9_.-]+$/', $group)) {
                throw new ActionException('INVALID_INPUT', 'Every cache group must use 1-128 safe name characters.');
            }

            $cleanGroups[$group] = true;
        }

        $cleanGroups = array_keys($cleanGroups);

        if (Input::boolean($input, 'dryRun', true)) {
            return [
                'applied' => false,
                'dryRun' => true,
                'groups' => $cleanGroups,
                'requiresEdgeConfirmation' => true,
            ];
        }

        if (Input::boolean($input, '_edgeConfirmed', false) !== true) {
            throw new ActionException('CONFIRMATION_REQUIRED', 'Cache cleaning requires confirmation from the signed MCP edge apply flow.');
        }

        $model = $this->models->administrator('com_cache', 'Cache');

        if (!method_exists($model, 'cleanlist')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Cache model is incompatible.');
        }

        try {
            $failed = $model->cleanlist($cleanGroups);
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not clean the selected cache groups.');
        }

        if (!is_array($failed)) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla Cache model returned an invalid result.');
        }

        $failed = array_values(array_intersect($cleanGroups, array_filter($failed, 'is_string')));

        return ['applied' => $failed === [], 'dryRun' => false, 'groups' => $cleanGroups, 'failed' => $failed];
    }
}
