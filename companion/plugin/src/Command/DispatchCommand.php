<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Command;

defined('_JEXEC') or die;

use Joomla\Console\Command\AbstractCommand;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;
use VDM\Plugin\Console\JoomlaMcp\Protocol\DispatchService;
use VDM\Plugin\Console\JoomlaMcp\Protocol\RequestDecoder;

final class DispatchCommand extends AbstractCommand
{
    private const MAX_NDJSON_REQUESTS = 1_000;

    protected static $defaultName = 'joomla:mcp:dispatch';

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
        $this->setDescription('Dispatch allowlisted Joomla MCP actions from JSON or NDJSON on stdin.');
        $this->addOption('input', null, InputOption::VALUE_REQUIRED, 'Input source. Only - (stdin) is supported.', '-');
        $this->addOption('format', null, InputOption::VALUE_REQUIRED, 'Input/output framing: json or ndjson.', 'json');
    }

    protected function doExecute(InputInterface $input, OutputInterface $output): int
    {
        if ($input->getOption('input') !== '-') {
            $this->write($this->commandError('INVALID_INPUT_SOURCE', 'Input source must be stdin (-).'));

            return 2;
        }

        $format = $input->getOption('format');

        if (!is_string($format) || !in_array($format, ['json', 'ndjson'], true)) {
            $this->write($this->commandError('INVALID_FORMAT', 'Format must be json or ndjson.'));

            return 2;
        }

        $dispatcher = new DispatchService($this->registry, $this->capabilities);

        if ($format === 'json') {
            $payload = stream_get_contents(STDIN, RequestDecoder::MAX_BYTES + 1);
            $this->write($dispatcher->handleJson(is_string($payload) ? $payload : ''));

            return 0;
        }

        $count = 0;

        while (($line = fgets(STDIN, RequestDecoder::MAX_BYTES + 2)) !== false) {
            if (++$count > self::MAX_NDJSON_REQUESTS) {
                $this->write($this->commandError('REQUEST_LIMIT', 'NDJSON request limit exceeded.'));

                return 2;
            }

            if (trim($line) === '') {
                continue;
            }

            $this->write($dispatcher->handleJson($line));

            if (strlen($line) > RequestDecoder::MAX_BYTES) {
                // Stop instead of treating the remainder of an oversized line as another request.
                return 2;
            }
        }

        return 0;
    }

    private function commandError(string $code, string $message): string
    {
        return json_encode([
            'protocol' => RequestDecoder::PROTOCOL,
            'id' => null,
            'ok' => false,
            'error' => ['code' => $code, 'message' => $message],
        ], JSON_UNESCAPED_SLASHES) ?: '{"protocol":"joomla-mcp/1","id":null,"ok":false,"error":{"code":"ENCODING_FAILED","message":"Response encoding failed."}}';
    }

    private function write(string $line): void
    {
        // Write protocol data directly so the edge can keep the JSON payload
        // separate from Joomla's interactive and ANSI console output.
        fwrite(STDOUT, $line . PHP_EOL);
    }
}
