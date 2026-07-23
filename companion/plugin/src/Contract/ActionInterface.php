<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Contract;

use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;

interface ActionInterface
{
    public function descriptor(): ActionDescriptor;

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    public function execute(array $input): array;
}
