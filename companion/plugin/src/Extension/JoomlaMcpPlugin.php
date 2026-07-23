<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Extension;

defined('_JEXEC') or die;

use Joomla\Application\ApplicationEvents;
use Joomla\CMS\Application\ConsoleApplication;
use Joomla\CMS\Plugin\CMSPlugin;
use Joomla\CMS\User\UserFactoryInterface;
use Joomla\Console\Command\AbstractCommand;
use Joomla\Event\DispatcherInterface;
use Joomla\Event\SubscriberInterface;
use RuntimeException;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Command\CliInventoryCommand;
use VDM\Plugin\Console\JoomlaMcp\Command\DescribeCommand;
use VDM\Plugin\Console\JoomlaMcp\Command\DispatchCommand;
use VDM\Plugin\Console\JoomlaMcp\Command\SelfTestCommand;
use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaActionRegistryFactory;
use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaCapabilityResolver;

final class JoomlaMcpPlugin extends CMSPlugin implements SubscriberInterface
{
    public function __construct(
        DispatcherInterface $dispatcher,
        array $config,
        private readonly UserFactoryInterface $users,
    ) {
        parent::__construct($dispatcher, $config);
    }

    public static function getSubscribedEvents(): array
    {
        return [ApplicationEvents::BEFORE_EXECUTE => 'registerCommands'];
    }

    public function registerCommands(): void
    {
        $application = $this->getApplication();

        if (!$application instanceof ConsoleApplication) {
            return;
        }

        $actorUserId = max(0, (int) $this->params->get('actor_user_id', 0));
        $capabilities = new JoomlaCapabilityResolver(
            $this->users,
            $actorUserId,
        );

        // Administrator models consult the application identity for their
        // record-level ACL checks. Use the same dedicated actor that describe
        // and dispatch use, while leaving an invalid/unset actor fail-closed.
        if ($actorUserId > 0 && method_exists($application, 'loadIdentity')) {
            try {
                $actor = $this->users->loadUserById($actorUserId);

                if (is_object($actor) && (int) ($actor->id ?? 0) === $actorUserId) {
                    $application->loadIdentity($actor);
                }
            } catch (Throwable) {
                // Capability resolution will deny every protected action.
            }
        }

        $registry = (new JoomlaActionRegistryFactory($application))->create();

        $this->registerVerified(
            $application,
            new DescribeCommand($registry, $capabilities),
            DescribeCommand::class,
        );
        $this->registerVerified(
            $application,
            new DispatchCommand($registry, $capabilities),
            DispatchCommand::class,
        );
        $this->registerVerified(
            $application,
            new SelfTestCommand($registry, $capabilities),
            SelfTestCommand::class,
        );
        $this->registerVerified(
            $application,
            new CliInventoryCommand($application),
            CliInventoryCommand::class,
        );
    }

    /** @param class-string<AbstractCommand> $expectedClass */
    private function registerVerified(ConsoleApplication $application, AbstractCommand $command, string $expectedClass): void
    {
        $name = $command->getName();

        if ($application->hasCommand($name)) {
            throw new RuntimeException(sprintf('Refusing to shadow existing Joomla command "%s".', $name));
        }

        $application->addCommand($command);
        $resolved = $application->getCommand($name);

        if (!$resolved instanceof $expectedClass) {
            throw new RuntimeException(sprintf('Joomla command "%s" resolved to an unexpected class.', $name));
        }
    }
}
