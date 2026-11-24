<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use VDM\Joomla\Data\Items;
use VDM\Joomla\Interfaces\Data\ItemsInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

/** The native resolver may assign GUIDs. Verification allows its lookups only. */
final class ReadOnlyItems implements ItemsInterface
{
    private Items $reader;

    public function __construct(Items $reader)
    {
        $this->reader = clone $reader;
    }

    public function table(string $table): self
    {
        $this->reader->table($table);
        return $this;
    }

    public function get(array $values, string $key = 'guid'): ?array
    {
        return $this->reader->get($values, $key);
    }

    public function values(array $values, string $key = 'guid', string $get = 'id'): ?array
    {
        return $this->reader->values($values, $key, $get);
    }

    public function getTable(): string
    {
        return $this->reader->getTable();
    }

    public function ids(): array
    {
        throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'Read-back cannot consume native write tracking.');
    }

    public function set(array $items, string $key = 'guid'): bool
    {
        throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'Read-back cannot assign native identifiers.');
    }

    public function delete(array $values, string $key = 'guid'): bool
    {
        throw new ActionException('JCB_VERIFY_UNAVAILABLE', 'Read-back cannot delete native records.');
    }
}
