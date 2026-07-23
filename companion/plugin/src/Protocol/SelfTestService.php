<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Protocol;

use RuntimeException;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;

final readonly class SelfTestService
{
    private const MINIMUM_ACTIONS = 231;

    public function __construct(
        private ActionRegistry $registry,
        private CapabilityResolverInterface $capabilities,
    ) {
    }

    /** @return array<string, mixed> */
    public function evaluate(): array
    {
        try {
            $description = json_decode(
                (new DescriptionService($this->registry, $this->capabilities))->toJson(),
                true,
                64,
                JSON_THROW_ON_ERROR,
            );
            $dispatch = json_decode(
                (new DispatchService($this->registry, $this->capabilities))->handleJson(
                    '{"protocol":"joomla-mcp/1","id":"companion-self-test","action":"system.info","input":{}}',
                ),
                true,
                64,
                JSON_THROW_ON_ERROR,
            );

            if (!is_array($description) || ($description['protocol'] ?? null) !== RequestDecoder::PROTOCOL) {
                throw new RuntimeException('Description protocol check failed.');
            }

            $actions = $description['actions'] ?? null;

            if (!is_array($actions) || count($actions) < self::MINIMUM_ACTIONS) {
                throw new RuntimeException('Companion catalogue check failed.');
            }

            if (!is_array($dispatch) || ($dispatch['protocol'] ?? null) !== RequestDecoder::PROTOCOL || ($dispatch['ok'] ?? null) !== true) {
                throw new RuntimeException('Companion dispatch check failed.');
            }

            $runtime = $dispatch['result'] ?? null;

            if (!is_array($runtime) || !is_string($runtime['joomlaVersion'] ?? null) || !is_string($runtime['phpVersion'] ?? null)) {
                throw new RuntimeException('Companion runtime check failed.');
            }

            return [
                'protocol' => RequestDecoder::PROTOCOL,
                'ok' => true,
                'companion' => $description['companion'] ?? null,
                'checks' => [
                    'pluginEnabled' => true,
                    'catalogue' => ['ok' => true, 'actionCount' => count($actions)],
                    'dispatch' => ['ok' => true, 'action' => 'system.info', 'result' => $runtime],
                ],
            ];
        } catch (Throwable) {
            return [
                'protocol' => RequestDecoder::PROTOCOL,
                'ok' => false,
                'error' => [
                    'code' => 'SELF_TEST_FAILED',
                    'message' => 'The Joomla MCP companion self-test failed.',
                ],
            ];
        }
    }
}
