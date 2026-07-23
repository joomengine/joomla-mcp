<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

final class Input
{
    private const MAX_COLLECTION_ITEMS = 1_000;
    private const MAX_NESTING_DEPTH = 6;
    private const MAX_VALUE_STRING_BYTES = 524_288;

    /**
     * @param array<string, mixed> $input
     * @param list<string>         $allowed
     */
    public static function rejectUnknown(array $input, array $allowed): void
    {
        $unknown = array_diff(array_keys($input), $allowed);

        if ($unknown !== []) {
            throw new ActionException(
                'INVALID_INPUT',
                sprintf('Unknown input member "%s".', (string) reset($unknown)),
            );
        }
    }

    /** @param array<string, mixed> $input */
    public static function integer(
        array $input,
        string $key,
        int $default,
        int $minimum,
        int $maximum,
    ): int {
        $value = $input[$key] ?? $default;

        if (!is_int($value) || $value < $minimum || $value > $maximum) {
            throw new ActionException(
                'INVALID_INPUT',
                sprintf('Input "%s" must be an integer from %d to %d.', $key, $minimum, $maximum),
            );
        }

        return $value;
    }

    /** @param array<string, mixed> $input */
    public static function text(array $input, string $key, string $default = '', int $maximum = 200): string
    {
        $value = $input[$key] ?? $default;

        if (!is_string($value) || strlen($value) > $maximum || str_contains($value, "\0")) {
            throw new ActionException(
                'INVALID_INPUT',
                sprintf('Input "%s" must be a string of at most %d bytes.', $key, $maximum),
            );
        }

        return $value;
    }

    /** @param array<string, mixed> $input */
    public static function boolean(array $input, string $key, bool $default): bool
    {
        $value = $input[$key] ?? $default;

        if (!is_bool($value)) {
            throw new ActionException('INVALID_INPUT', sprintf('Input "%s" must be a boolean.', $key));
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    public static function object(array $input, string $key): array
    {
        $value = $input[$key] ?? null;

        if (!is_array($value) || ($value !== [] && array_is_list($value))) {
            throw new ActionException('INVALID_INPUT', sprintf('Input "%s" must be an object.', $key));
        }

        foreach (array_keys($value) as $member) {
            if (!is_string($member) || !preg_match('/^[A-Za-z][A-Za-z0-9_]*$/', $member)) {
                throw new ActionException('INVALID_INPUT', sprintf('Input "%s" contains an invalid member name.', $key));
            }
        }

        if (count($value) > self::MAX_COLLECTION_ITEMS) {
            throw new ActionException('INVALID_INPUT', sprintf('Input "%s" has too many members.', $key));
        }

        return $value;
    }

    public static function boundedValue(mixed $value, string $key, int $depth = 0): mixed
    {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value)) {
            return $value;
        }

        if (is_string($value)) {
            if (strlen($value) > self::MAX_VALUE_STRING_BYTES || str_contains($value, "\0")) {
                throw new ActionException('INVALID_INPUT', sprintf('Input "%s" contains an invalid string value.', $key));
            }

            return $value;
        }

        if (!is_array($value) || $depth >= self::MAX_NESTING_DEPTH || count($value) > self::MAX_COLLECTION_ITEMS) {
            throw new ActionException('INVALID_INPUT', sprintf('Input "%s" contains an unsupported or oversized value.', $key));
        }

        $result = [];

        foreach ($value as $member => $nested) {
            if (!is_int($member) && (!is_string($member) || strlen($member) > 128 || str_contains($member, "\0"))) {
                throw new ActionException('INVALID_INPUT', sprintf('Input "%s" contains an invalid nested member.', $key));
            }

            $result[$member] = self::boundedValue($nested, $key, $depth + 1);
        }

        return $result;
    }

    /**
     * @param array<string, mixed> $input
     * @param list<int|string>     $allowed
     */
    public static function choice(array $input, string $key, int|string $default, array $allowed): int|string
    {
        $value = $input[$key] ?? $default;

        if (!is_int($value) && !is_string($value) || !in_array($value, $allowed, true)) {
            throw new ActionException(
                'INVALID_INPUT',
                sprintf('Input "%s" is not an allowed value.', $key),
            );
        }

        return $value;
    }
}
