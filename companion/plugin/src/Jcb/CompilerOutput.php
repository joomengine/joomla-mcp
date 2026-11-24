<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use ZipArchive;

final class CompilerOutput
{
    public static function directory(): string
    {
        $configured = getenv('JOOMLA_MCP_JCB_ARTIFACT_DIR');
        $path = is_string($configured) && $configured !== '' ? realpath($configured) : false;
        $root = realpath(JPATH_ROOT);
        if ($path === false || $root === false || $path !== $configured || $path === $root
            || str_starts_with($path, $root . DIRECTORY_SEPARATOR) || !is_dir($path)
            || (fileperms($path) & 0777) !== 0700 || !is_writable($path) || !class_exists(ZipArchive::class)) {
            throw new ActionException('JCB_ARTIFACT_STORAGE', 'Compilation requires a private job directory outside Joomla and PHP ZIP support.');
        }
        if (array_diff(scandir($path) ?: [], ['.', '..']) !== []) {
            throw new ActionException('JCB_ARTIFACT_STORAGE', 'The private compilation workspace must be empty.');
        }
        return $path;
    }

    /** The compiler's own outputPaths collection is the authority; never scan shared Joomla temp directories. */
    public static function verify(string $directory, array $paths): array
    {
        if ($paths === [] || count($paths) > 32) {
            throw new ActionException('JCB_ARCHIVE_MISSING', 'Expected one to 32 native compiler archives.');
        }
        $results = [];
        $total = 0;
        foreach (array_unique($paths) as $path) {
            $real = is_string($path) && !is_link($path) ? realpath($path) : false;
            if ($real === false || dirname($real) !== $directory || !is_file($real)
                || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.zip$/Di', basename($real))) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'A compiler result is outside the private archive boundary.');
            }
            $size = filesize($real);
            $zip = new ZipArchive();
            if ($size === false || $size < 1 || $size > 134217728 || ($total += $size) > 268435456
                || $zip->open($real, ZipArchive::CHECKCONS | ZipArchive::RDONLY) !== true) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'A compiler archive failed validation.');
            }
            $entries = $zip->numFiles;
            $zip->close();
            $hash = hash_file('sha256', $real);
            if ($entries < 1 || $hash === false || !chmod($real, 0600)) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'An empty or unreadable compiler archive was returned.');
            }
            $results[] = ['name' => basename($real), 'size' => $size, 'sha256' => $hash];
        }
        return $results;
    }
}
