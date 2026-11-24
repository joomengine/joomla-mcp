<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

use Closure;
use InvalidArgumentException;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;

final class ActionRegistry
{
    /** @var array<string, ActionInterface> */
    private array $actions = [];

    /** @param iterable<ActionInterface> $actions */
    public function __construct(iterable $actions = [], private ?Closure $installedActions = null)
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
        if (!isset($this->actions[$name])) {
            $this->addInstalledActions();
        }

        return $this->actions[$name] ?? throw new ActionException(
            'UNKNOWN_ACTION',
            sprintf('Action "%s" is not registered.', $name),
        );
    }

    /** @return list<ActionInterface> */
    public function all(): array
    {
        $this->addInstalledActions();
        return array_values($this->actions);
    }
    private function addInstalledActions(): void
    {
        if ($this->installedActions === null) {
            return;
        }
        $discover = $this->installedActions;
        $this->installedActions = null;
        foreach ($discover() as $action) {
            $this->add($action);
        }
    }
}
