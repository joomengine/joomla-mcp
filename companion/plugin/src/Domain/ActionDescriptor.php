<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

use InvalidArgumentException;
use JsonSerializable;

final readonly class ActionDescriptor implements JsonSerializable
{
    /**
     * @param list<array{action: string, asset: string}> $acl
     * @param array<string, mixed>                       $inputSchema
     * @param array<string, mixed>                       $outputSchema
     */
    public function __construct(
        public string $name,
        public string $description,
        public string $risk,
        public array $acl,
        public array $inputSchema,
        public array $outputSchema,
    ) {
        if (!preg_match('/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/', $name)) {
            throw new InvalidArgumentException(sprintf('Invalid action name "%s".', $name));
        }

        if (!in_array($risk, ['read', 'write', 'high'], true)) {
            throw new InvalidArgumentException(sprintf('Invalid action risk "%s".', $risk));
        }
    }

    /** @return array<string, mixed> */
    public function jsonSerialize(): array
    {
        return [
            'name' => $this->name,
            'description' => $this->description,
            'risk' => $this->risk,
            'drivers' => ['cli-companion'],
            'joomla' => ['min' => '6.1.0', 'canary' => '7.0.0'],
            'acl' => $this->acl,
            'inputSchema' => $this->inputSchema,
            'outputSchema' => $this->outputSchema,
        ];
    }
}
