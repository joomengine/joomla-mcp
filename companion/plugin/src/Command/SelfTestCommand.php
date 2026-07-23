<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Command;

defined('_JEXEC') or die;

use JsonException;
use Joomla\Console\Command\AbstractCommand;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;
use VDM\Plugin\Console\JoomlaMcp\Protocol\SelfTestService;

final class SelfTestCommand extends AbstractCommand
{
    protected static $defaultName = 'joomla:mcp:self-test';

    public function __construct(
        private readonly ActionRegistry $registry,
        private readonly CapabilityResolverInterface $capabilities,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->setDescription('Verify the installed Joomla MCP companion catalogue and fixed system.info dispatch.');
        $this->addOption('format', null, InputOption::VALUE_REQUIRED, 'Output format. Only json is supported.', 'json');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        if ($input->getOption('format') !== 'json') {
            $this->write('{"protocol":"joomla-mcp/1","ok":false,"error":{"code":"INVALID_FORMAT","message":"Self-test format must be json."}}');

            return 2;
        }

        $result = (new SelfTestService($this->registry, $this->capabilities))->evaluate();

        try {
            $this->write(json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        } catch (JsonException) {
            $this->write('{"protocol":"joomla-mcp/1","ok":false,"error":{"code":"ENCODING_FAILED","message":"Self-test encoding failed."}}');

            return 1;
        }

        return ($result['ok'] ?? false) === true ? 0 : 1;
    }

    private function write(string $line): void
    {
        fwrite(STDOUT, $line . PHP_EOL);
    }
}
