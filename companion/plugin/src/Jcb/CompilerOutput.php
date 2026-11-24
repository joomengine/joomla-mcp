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
    public static function verify(string $directory, array $paths, array $expectedManifests): array
    {
        if ($paths === [] || count($paths) > 32) {
            throw new ActionException('JCB_ARCHIVE_MISSING', 'Expected one to 32 native compiler archives.');
        }
        $results = [];
        $matched = [];
        $total = 0;
        foreach (array_unique($paths) as $path) {
            $real = is_string($path) && !is_link($path) ? realpath($path) : false;
            if ($real === false || !str_starts_with($real, $directory . DIRECTORY_SEPARATOR) || !is_file($real)
                || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.zip$/Di', basename($real))) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'A compiler result is outside the private archive boundary.');
            }
            $size = filesize($real);
            $zip = new ZipArchive();
            if ($size === false || $size < 1 || $size > 134217728 || ($total += $size) > 268435456
                || $zip->open($real, ZipArchive::CHECKCONS | ZipArchive::RDONLY) !== true) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'A compiler archive failed validation.');
            }
            try {
                $entries = $zip->numFiles;
                foreach ($expectedManifests as $code => $version) {
                    if (self::containsComponent($zip, $code, $version)) {
                        if (isset($matched[$code])) {
                            throw new ActionException('JCB_ARCHIVE_INVALID', 'More than one archive claims the same selected component.');
                        }
                        $matched[$code] = true;
                    }
                }
            } finally {
                $zip->close();
            }
            $hash = hash_file('sha256', $real);
            if ($entries < 1 || $hash === false || !chmod($real, 0600)) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'An empty or unreadable compiler archive was returned.');
            }
            // Publish only a basename inside the worker's private root. Never replace another archive.
            $target = $directory . DIRECTORY_SEPARATOR . basename($real);
            if ($target !== $real && (!link($real, $target) || !unlink($real))) {
                throw new ActionException('JCB_ARCHIVE_INVALID', 'The compiler produced conflicting archive names.');
            }
            $results[] = ['name' => basename($real), 'size' => $size, 'sha256' => $hash];
        }
        if ($expectedManifests === [] || count($matched) !== count($expectedManifests)) {
            throw new ActionException('JCB_ARCHIVE_INVALID', 'The compiler archives did not match every requested component manifest.');
        }
        return $results;
    }

    private static function containsComponent(ZipArchive $zip, string $code, string $version): bool
    {
        $entry = $zip->statName($code . '.xml');
        if ($entry === false || $entry['size'] < 1 || $entry['size'] > 2097152) {
            return false;
        }
        $xml = $zip->getFromIndex($entry['index'], $entry['size']);
        if (!is_string($xml) || strlen($xml) !== $entry['size'] || stripos($xml, '<!DOCTYPE') !== false) {
            return false;
        }
        $manifest = new \DOMDocument();
        if (!$manifest->loadXML($xml, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING) || $manifest->doctype !== null) {
            return false;
        }
        $root = $manifest->documentElement;
        if ($root === null || $root->tagName !== 'extension' || $root->getAttribute('type') !== 'component') {
            return false;
        }
        $xpath = new \DOMXPath($manifest);
        return $xpath->evaluate('count(/extension/name)') === 1.0 && $xpath->evaluate('count(/extension/version)') === 1.0
            && trim($xpath->evaluate('string(/extension/name)')) === 'COM_' . strtoupper($code)
            && trim($xpath->evaluate('string(/extension/version)')) === $version;
    }
}
