<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Joomla;

use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Output\NullOutput;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\NativeOperationsInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

/**
 * Machine-readable adapter over fixed Joomla 6.1+ core console commands.
 *
 * The command names mirror Joomla CMS libraries/src/Console. No caller can
 * supply a command name, argument name, shell fragment, PHP, or filesystem path.
 */
final readonly class JoomlaNativeOperations implements NativeOperationsInterface
{
    public function __construct(private object $application)
    {
    }

    public function siteOfflineState(): bool
    {
        // SiteUpCommand/SiteDownCommand persist configuration.php, while the
        // already-loaded JConfig class retains the pre-command value.
        if (defined('JPATH_CONFIGURATION')) {
            $configurationFile = JPATH_CONFIGURATION . '/configuration.php';
            $contents = @file_get_contents($configurationFile);

            if (is_string($contents)
                && preg_match(
                    '/public\\s+\\$offline\\s*=\\s*(true|false|0|1|[\'"]0[\'"]|[\'"]1[\'"])\\s*;/i',
                    $contents,
                    $match,
                ) === 1) {
                return in_array(strtolower(trim($match[1], '\'"')), ['true', '1'], true);
            }
        }

        if (!method_exists($this->application, 'get')) {
            throw new ActionException('JOOMLA_RUNTIME_UNAVAILABLE', 'Joomla site state is unavailable.');
        }

        return (bool) $this->application->get('offline', false);
    }

    public function setSiteOffline(bool $offline): int
    {
        // Native Joomla commands: SiteDownCommand / SiteUpCommand.
        return $this->run($offline ? 'site:down' : 'site:up');
    }

    public function garbageCollectSessions(string $application): int
    {
        // Native Joomla command: SessionGcCommand. The public action permits
        // only the two web-session services registered by Joomla for this use.
        if (!in_array($application, ['site', 'administrator'], true)) {
            throw new ActionException('INVALID_INPUT', 'Unsupported Joomla session application.');
        }

        return $this->run('session:gc', ['--application' => $application]);
    }

    public function garbageCollectSessionMetadata(): int
    {
        // Native Joomla command: SessionMetadataGcCommand.
        return $this->run('session:metadata:gc');
    }

    public function setSchedulerTaskState(int $id, int $state): int
    {
        // Native Joomla command: TasksStateCommand.
        if ($id < 1 || !in_array($state, [-2, 0, 1], true)) {
            throw new ActionException('INVALID_INPUT', 'Invalid scheduler task state transition.');
        }

        return $this->run('scheduler:state', ['--id' => $id, '--state' => $state]);
    }

    public function runSchedulerTask(int $id): int
    {
        // Native Joomla command: TasksRunCommand. Only one explicit task may run.
        if ($id < 1) {
            throw new ActionException('INVALID_INPUT', 'Invalid scheduler task identifier.');
        }

        return $this->run('scheduler:run', ['--id' => $id]);
    }

    /** @param array<string, int|string|bool> $arguments */
    private function run(string $name, array $arguments = []): int
    {
        if (!method_exists($this->application, 'hasCommand')
            || !method_exists($this->application, 'getCommand')
            || !$this->application->hasCommand($name)) {
            throw new ActionException('NATIVE_COMMAND_UNAVAILABLE', sprintf('Required Joomla command "%s" is unavailable.', $name));
        }

        try {
            $command = $this->application->getCommand($name);

            if (!is_object($command) || !method_exists($command, 'execute')) {
                throw new ActionException('NATIVE_COMMAND_UNAVAILABLE', sprintf('Required Joomla command "%s" is incompatible.', $name));
            }

            // Discard Joomla's human-oriented console output without retaining
            // an unbounded buffer. The action returns bounded structured data.
            return (int) $command->execute(new ArrayInput($arguments), new NullOutput());
        } catch (ActionException $exception) {
            throw $exception;
        } catch (Throwable) {
            throw new ActionException('NATIVE_COMMAND_FAILED', sprintf('Joomla command "%s" failed.', $name));
        }
    }
}
