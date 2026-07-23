<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

use RuntimeException;

final class ActionException extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
    ) {
        parent::__construct($message);
    }
}
