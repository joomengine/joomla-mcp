<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Protocol;

use JsonException;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

final class RequestDecoder
{
    public const PROTOCOL = 'joomla-mcp/1';
    public const MAX_BYTES = 1_048_576;

    /**
     * @return array{protocol: string, id: int|string|null, action: string, input: array<string, mixed>}
     */
    public function decode(string $json): array
    {
        if (strlen($json) > self::MAX_BYTES) {
            throw new ActionException('REQUEST_TOO_LARGE', 'The request exceeds 1048576 bytes.');
        }

        try {
            $request = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new ActionException('INVALID_JSON', 'The request is not valid JSON.');
        }

        if (!is_array($request) || array_is_list($request)) {
            throw new ActionException('INVALID_REQUEST', 'The request must be a JSON object.');
        }

        $unknown = array_diff(array_keys($request), ['protocol', 'id', 'action', 'input']);

        if ($unknown !== []) {
            throw new ActionException(
                'INVALID_REQUEST',
                sprintf('Unknown request member "%s".', (string) reset($unknown)),
            );
        }

        if (($request['protocol'] ?? null) !== self::PROTOCOL) {
            throw new ActionException('INVALID_PROTOCOL', sprintf('Protocol must be "%s".', self::PROTOCOL));
        }

        $id = $request['id'] ?? null;

        if (!is_string($id) && !is_int($id)) {
            throw new ActionException('INVALID_REQUEST', 'Request id must be a string or integer.');
        }

        $action = $request['action'] ?? null;

        if (!is_string($action) || $action === '' || strlen($action) > 128) {
            throw new ActionException('INVALID_REQUEST', 'Action must be a non-empty string of at most 128 bytes.');
        }

        $input = $request['input'] ?? [];

        if (!is_array($input) || array_is_list($input) && $input !== []) {
            throw new ActionException('INVALID_REQUEST', 'Input must be a JSON object.');
        }

        /** @var array<string, mixed> $input */
        return [
            'protocol' => self::PROTOCOL,
            'id' => $id,
            'action' => $action,
            'input' => $input,
        ];
    }
}
