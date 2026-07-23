<?php

declare(strict_types=1);

defined('_JEXEC') || define('_JEXEC', 1);

spl_autoload_register(static function (string $class): void {
    $prefix = 'VDM\\Plugin\\Console\\JoomlaMcp\\';

    if (!str_starts_with($class, $prefix)) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $path = dirname(__DIR__) . '/plugin/src/' . str_replace('\\', '/', $relative) . '.php';

    if (is_file($path)) {
        require $path;
    }
});

function test(string $name, callable $callback): void
{
    try {
        $callback();
        file_put_contents('php://stdout', "PASS {$name}\n", FILE_APPEND);
    } catch (Throwable $throwable) {
        file_put_contents('php://stderr', "FAIL {$name}: {$throwable->getMessage()}\n", FILE_APPEND);
        $GLOBALS['failures']++;
    }
}

function expect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

/** @return array<string, mixed> */
function jsonObject(string $json): array
{
    $value = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
    expect(is_array($value), 'Expected a JSON object.');

    return $value;
}
