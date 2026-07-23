<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Contract;

interface ModelProviderInterface
{
    public function administrator(string $component, string $modelName): object;
}
