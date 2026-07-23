<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Contract;

/**
 * Fixed adapters for Joomla's own console operations.
 *
 * Deliberately expose semantic methods instead of a command-name parameter so
 * callers can never turn the companion into a generic Joomla CLI passthrough.
 */
interface NativeOperationsInterface
{
    public function siteOfflineState(): bool;

    public function setSiteOffline(bool $offline): int;

    public function garbageCollectSessions(string $application): int;

    public function garbageCollectSessionMetadata(): int;

    public function setSchedulerTaskState(int $id, int $state): int;

    public function runSchedulerTask(int $id): int;
}
