<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

use InvalidArgumentException;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;

final class ActionRegistry
{
    /** @var array<string, ActionInterface> */
    private array $actions = [];

    /** @param iterable<ActionInterface> $actions */
    public function __construct(iterable $actions = [])
    {
        foreach ($actions as $action) {
            $this->add($action);
        }
    }

    public function add(ActionInterface $action): void
    {
        $name = $action->descriptor()->name;

        if (isset($this->actions[$name])) {
            throw new InvalidArgumentException(sprintf('Duplicate action "%s".', $name));
        }

        $this->actions[$name] = $action;
        ksort($this->actions);
    }

    public function get(string $name): ActionInterface
    {
        return $this->actions[$name] ?? throw new ActionException(
            'UNKNOWN_ACTION',
            sprintf('Action "%s" is not registered.', $name),
        );
    }

    /** @return list<ActionInterface> */
    public function all(): array
    {
        return array_values($this->actions);
    }
}
