<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Protocol;

use JsonException;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;

final readonly class DescriptionService
{
    public function __construct(
        private ActionRegistry $registry,
        private CapabilityResolverInterface $capabilities,
    ) {
    }

    /** @throws JsonException */
    public function toJson(): string
    {
        $actions = [];

        foreach ($this->registry->all() as $action) {
            $descriptor = $action->descriptor();
            $actions[] = array_merge(
                $descriptor->jsonSerialize(),
                ['effective' => $this->capabilities->resolve($descriptor)],
            );
        }

        return json_encode([
            'protocol' => RequestDecoder::PROTOCOL,
            'companion' => [
                'name' => 'pkg_joomlamcp',
                'version' => '0.7.0',
                'joomla' => defined('JVERSION') ? JVERSION : null,
                'php' => PHP_VERSION,
            ],
            'actor' => $this->capabilities->actor(),
            'actions' => $actions,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    }
}
