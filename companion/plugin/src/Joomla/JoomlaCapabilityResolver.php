<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Joomla;

use Joomla\CMS\User\UserFactoryInterface;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;

final class JoomlaCapabilityResolver implements CapabilityResolverInterface
{
    private ?object $actor = null;

    public function __construct(
        private readonly UserFactoryInterface $users,
        private readonly int $actorUserId,
    ) {
    }

    public function actor(): array
    {
        return [
            'id' => $this->actorUserId > 0 ? $this->actorUserId : null,
            'configured' => $this->actorUserId > 0,
        ];
    }

    public function resolve(ActionDescriptor $descriptor): array
    {
        $requirements = [];
        $allowed = true;

        foreach ($descriptor->acl as $requirement) {
            $granted = $this->authorise($requirement['action'], $requirement['asset']);
            $requirements[] = $requirement + ['allowed' => $granted];
            $allowed = $allowed && $granted;
        }

        return ['allowed' => $allowed, 'requirements' => $requirements];
    }

    private function authorise(string $action, string $asset): bool
    {
        if ($this->actorUserId <= 0) {
            return false;
        }

        try {
            $this->actor ??= $this->users->loadUserById($this->actorUserId);

            return method_exists($this->actor, 'authorise')
                && $this->actor->authorise($action, $asset) === true;
        } catch (Throwable) {
            return false;
        }
    }
}
