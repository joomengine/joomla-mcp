<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Command;

defined('_JEXEC') or die;

use Joomla\CMS\Application\ConsoleApplication;
use Joomla\Console\Command\AbstractCommand;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Protocol\RequestDecoder;

final class CliInventoryCommand extends AbstractCommand
{
    private const MAX_COMMANDS = 512;

    protected static $defaultName = 'joomla:mcp:cli-inventory';

    public function __construct(private readonly ConsoleApplication $console)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->setDescription('Describe the installed Joomla CLI registry as bounded machine-readable JSON.');
        $this->addOption('format', null, InputOption::VALUE_REQUIRED, 'Output format. Only json is supported.', 'json');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        if ($input->getOption('format') !== 'json') {
            $this->write('{"protocol":"joomla-mcp/1","ok":false,"error":{"code":"INVALID_FORMAT","message":"CLI inventory format must be json."}}');

            return 2;
        }

        try {
            $commands = [];

            foreach ($this->console->getAllCommands() as $command) {
                $name = $command->getName();

                if ($name === '' || isset($commands[$name])) {
                    continue;
                }

                if (count($commands) >= self::MAX_COMMANDS) {
                    throw new \RuntimeException('Installed command count exceeds the inventory limit.');
                }

                $commands[$name] = $this->describe($command);
            }

            ksort($commands, SORT_STRING);
            $namespaces = [];

            foreach (array_keys($commands) as $name) {
                $separator = strpos($name, ':');

                if ($separator !== false) {
                    $namespaces[] = substr($name, 0, $separator);
                }
            }

            $namespaces = array_values(array_unique($namespaces));
            sort($namespaces, SORT_STRING);
            $this->write(json_encode([
                'protocol' => RequestDecoder::PROTOCOL,
                'ok' => true,
                'runtime' => [
                    'joomlaVersion' => defined('JVERSION') ? (string) JVERSION : 'unknown',
                    'phpVersion' => PHP_VERSION,
                ],
                'commandCount' => count($commands),
                'namespaces' => $namespaces,
                'commands' => array_values($commands),
            ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));

            return 0;
        } catch (Throwable) {
            $this->write('{"protocol":"joomla-mcp/1","ok":false,"error":{"code":"CLI_INVENTORY_FAILED","message":"The installed Joomla CLI registry could not be described."}}');

            return 1;
        }
    }

    /** @return array<string, mixed> */
    private function describe(AbstractCommand $command): array
    {
        $arguments = array_map(
            static fn (InputArgument $argument): array => [
                'name' => $argument->getName(),
                'description' => $argument->getDescription(),
                'required' => $argument->isRequired(),
                'array' => $argument->isArray(),
            ],
            array_values($command->getDefinition()->getArguments()),
        );
        $options = array_map(
            static function (InputOption $option): array {
                $shortcut = $option->getShortcut();

                return [
                    'name' => $option->getName(),
                    'shortcuts' => $shortcut === null || $shortcut === ''
                        ? []
                        : (is_array($shortcut) ? array_values($shortcut) : explode('|', $shortcut)),
                    'description' => $option->getDescription(),
                    'acceptsValue' => $option->acceptValue(),
                    'valueRequired' => $option->isValueRequired(),
                    'valueOptional' => $option->isValueOptional(),
                    'array' => $option->isArray(),
                ];
            },
            array_values($command->getDefinition()->getOptions()),
        );
        $aliases = $command->getAliases();
        sort($aliases, SORT_STRING);

        return [
            'name' => $command->getName(),
            'description' => $command->getDescription(),
            'aliases' => array_values($aliases),
            'hidden' => $command->isHidden(),
            'arguments' => $arguments,
            'options' => $options,
        ];
    }

    private function write(string $line): void
    {
        fwrite(STDOUT, $line . PHP_EOL);
    }
}
