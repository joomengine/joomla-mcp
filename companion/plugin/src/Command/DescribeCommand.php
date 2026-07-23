<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Command;

defined('_JEXEC') or die;

use Joomla\Console\Command\AbstractCommand;
use JsonException;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;
use VDM\Plugin\Console\JoomlaMcp\Protocol\DescriptionService;

final class DescribeCommand extends AbstractCommand
{
    protected static $defaultName = 'joomla:mcp:describe';

    public function __construct(
        private readonly ActionRegistry $registry,
        private readonly CapabilityResolverInterface $capabilities,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        // Joomla Framework Console setters return void, unlike Symfony's
        // fluent Command API. Keep every configuration call independent.
        $this->setDescription('Describe allowlisted Joomla MCP actions and effective ACL as JSON.');
        $this->addOption('format', null, InputOption::VALUE_REQUIRED, 'Output format. Only json is supported.', 'json');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        if ($input->getOption('format') !== 'json') {
            $this->write('{"protocol":"joomla-mcp/1","ok":false,"error":{"code":"INVALID_FORMAT","message":"Describe format must be json."}}');

            return 2;
        }

        try {
            $this->write((new DescriptionService($this->registry, $this->capabilities))->toJson());

            return 0;
        } catch (JsonException) {
            $this->write('{"protocol":"joomla-mcp/1","ok":false,"error":{"code":"ENCODING_FAILED","message":"Description encoding failed."}}');

            return 1;
        }
    }

    private function write(string $line): void
    {
        // Write protocol data directly so the edge can keep the JSON payload
        // separate from Joomla's interactive and ANSI console output.
        fwrite(STDOUT, $line . PHP_EOL);
    }
}
