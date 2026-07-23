<?php

declare(strict_types=1);

$root = __DIR__;
$pluginRoot = $root . '/plugin';
$dist = $root . '/dist';
$version = '0.6.0';
$projectLicense = dirname($root) . '/LICENSE';

if (!class_exists(ZipArchive::class)) {
    file_put_contents('php://stderr', "The PHP zip extension is required to build the Joomla companion package.\n");
    exit(1);
}

if (!is_dir($dist) && !mkdir($dist, 0775, true) && !is_dir($dist)) {
    throw new RuntimeException(sprintf('Could not create build directory "%s".', $dist));
}

$pluginZipPath = $dist . '/plg_console_joomlamcp.zip';
$packageZipPath = $dist . '/pkg_joomlamcp-' . $version . '.zip';

if (!is_file($projectLicense)) {
    throw new RuntimeException('The project LICENSE file is required to build the companion package.');
}

buildDirectoryZip($pluginRoot, $pluginZipPath, [$projectLicense => 'LICENSE.txt']);

$package = new ZipArchive();

if ($package->open($packageZipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    throw new RuntimeException(sprintf('Could not create "%s".', $packageZipPath));
}

$package->addFile($root . '/pkg_joomlamcp.xml', 'pkg_joomlamcp.xml');
$package->addFile($pluginZipPath, 'plg_console_joomlamcp.zip');
$package->addFile($projectLicense, 'LICENSE.txt');
$package->close();

verifyZipEntries($pluginZipPath, ['joomlamcp.xml', 'script.php', 'LICENSE.txt']);
verifyZipEntries($packageZipPath, ['pkg_joomlamcp.xml', 'plg_console_joomlamcp.zip', 'LICENSE.txt']);

file_put_contents('php://stdout', $packageZipPath . PHP_EOL);

/** @param list<string> $requiredEntries */
function verifyZipEntries(string $path, array $requiredEntries): void
{
    $zip = new ZipArchive();

    if ($zip->open($path) !== true) {
        throw new RuntimeException(sprintf('Could not verify "%s".', $path));
    }

    foreach ($requiredEntries as $entry) {
        if ($zip->locateName($entry, ZipArchive::FL_NOCASE) === false) {
            $zip->close();
            throw new RuntimeException(sprintf('Required entry "%s" is missing from "%s".', $entry, $path));
        }
    }

    $zip->close();
}

/** @param array<string, string> $additionalFiles */
function buildDirectoryZip(string $source, string $destination, array $additionalFiles = []): void
{
    $sourceReal = realpath($source);

    if ($sourceReal === false) {
        throw new RuntimeException(sprintf('Source directory "%s" does not exist.', $source));
    }

    $paths = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($sourceReal, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY,
    );

    foreach ($iterator as $file) {
        if ($file->isLink() || !$file->isFile()) {
            continue;
        }

        $paths[] = $file->getPathname();
    }

    sort($paths, SORT_STRING);
    $zip = new ZipArchive();

    if ($zip->open($destination, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        throw new RuntimeException(sprintf('Could not create "%s".', $destination));
    }

    foreach ($paths as $path) {
        $localName = str_replace(DIRECTORY_SEPARATOR, '/', substr($path, strlen($sourceReal) + 1));
        $zip->addFile($path, $localName);
    }

    foreach ($additionalFiles as $path => $localName) {
        $zip->addFile($path, $localName);
    }

    $zip->close();
}
