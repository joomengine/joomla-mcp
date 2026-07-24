<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Protocol;

use JsonException;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\CapabilityResolverInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;

final readonly class DispatchService
{
    private const MAX_RESULT_BYTES = 8_388_608;

    public function __construct(
        private ActionRegistry $registry,
        private CapabilityResolverInterface $capabilities,
        private RequestDecoder $decoder = new RequestDecoder(),
    ) {
    }

    public function handleJson(string $json): string
    {
        $id = null;

        try {
            $request = $this->decoder->decode($json);
            $id = $request['id'];
            $action = $this->registry->get($request['action']);
            $effective = $this->capabilities->resolve($action->descriptor());

            if (!$effective['allowed']) {
                throw new ActionException('ACCESS_DENIED', 'The configured MCP actor lacks a required Joomla permission.');
            }

            $result = $this->executeWithoutOutput($action, $request['input']);

            try {
                $encodedResult = json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            } catch (JsonException) {
                throw new ActionException('RESULT_INVALID', 'The Joomla action returned a result that cannot be encoded.');
            }

            if (strlen($encodedResult) > self::MAX_RESULT_BYTES) {
                throw new ActionException('RESULT_TOO_LARGE', 'The Joomla action result exceeds 8388608 bytes.');
            }

            $response = [
                'protocol' => RequestDecoder::PROTOCOL,
                'id' => $id,
                'ok' => true,
                'result' => $result,
            ];
        } catch (ActionException $exception) {
            $response = $this->error($id, $exception->errorCode, $exception->getMessage());
        } catch (Throwable) {
            // Never leak paths, SQL, credentials, stack traces, or Joomla internals to MCP clients.
            $response = $this->error($id, 'ACTION_FAILED', 'The Joomla action failed.');
        }

        try {
            return json_encode($response, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        } catch (JsonException) {
            return '{"protocol":"joomla-mcp/1","id":null,"ok":false,"error":{"code":"ENCODING_FAILED","message":"Response encoding failed."}}';
        }
    }

    /**
     * Prevent incidental Joomla model or command output from corrupting the
     * one-JSON-object CLI protocol. The callback discards chunks as they are
     * produced so noisy actions cannot grow an unbounded in-memory buffer.
     *
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function executeWithoutOutput(ActionInterface $action, array $input): array
    {
        $initialLevel = ob_get_level();

        if (!ob_start(static fn(string $buffer): string => '', 4096)) {
            throw new ActionException('ACTION_FAILED', 'The Joomla action output could not be isolated.');
        }

        try {
            return $action->execute($input);
        } finally {
            while (ob_get_level() > $initialLevel) {
                ob_end_clean();
            }
        }
    }

    /** @return array<string, mixed> */
    private function error(int|string|null $id, string $code, string $message): array
    {
        return [
            'protocol' => RequestDecoder::PROTOCOL,
            'id' => $id,
            'ok' => false,
            'error' => ['code' => $code, 'message' => $message],
        ];
    }
}
