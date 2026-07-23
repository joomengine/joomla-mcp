<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final class SystemInfoAction implements ActionInterface
{
    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'system.info',
            'Return non-secret Joomla and PHP runtime versions.',
            'read',
            [],
            ['type' => 'object', 'properties' => [], 'additionalProperties' => false],
            [
                'type' => 'object',
                'required' => ['joomlaVersion', 'phpVersion'],
                'properties' => [
                    'joomlaVersion' => ['type' => 'string'],
                    'phpVersion' => ['type' => 'string'],
                ],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, []);

        return [
            'joomlaVersion' => defined('JVERSION') ? (string) JVERSION : 'unknown',
            'phpVersion' => PHP_VERSION,
        ];
    }
}
