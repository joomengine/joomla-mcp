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

addFileDeterministically($package, $root . '/pkg_joomlamcp.xml', 'pkg_joomlamcp.xml');
addFileDeterministically($package, $pluginZipPath, 'plg_console_joomlamcp.zip');
addFileDeterministically($package, $projectLicense, 'LICENSE.txt');

if (!$package->close()) {
    throw new RuntimeException(sprintf('Could not finalize "%s".', $packageZipPath));
}

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
        addFileDeterministically($zip, $path, $localName);
    }

    ksort($additionalFiles, SORT_STRING);

    foreach ($additionalFiles as $path => $localName) {
        addFileDeterministically($zip, $path, $localName);
    }

    if (!$zip->close()) {
        throw new RuntimeException(sprintf('Could not finalize "%s".', $destination));
    }
}

function addFileDeterministically(ZipArchive $zip, string $path, string $localName): void
{
    if (!is_file($path)) {
        throw new RuntimeException(sprintf('ZIP input "%s" does not exist.', $path));
    }
    if (!$zip->addFile($path, $localName)) {
        throw new RuntimeException(sprintf('Could not add "%s" to ZIP as "%s".', $path, $localName));
    }

    // ZIP uses the DOS epoch as its portable minimum. Normalizing every entry
    // makes companion checksums stable across fresh checkouts and reruns.
    if (!$zip->setMtimeName($localName, 315532800)) {
        throw new RuntimeException(sprintf('Could not normalize ZIP timestamp for "%s".', $localName));
    }
    if (!$zip->setCompressionName($localName, ZipArchive::CM_DEFLATE, 9)) {
        throw new RuntimeException(sprintf('Could not set ZIP compression for "%s".', $localName));
    }
    if (!$zip->setExternalAttributesName(
        $localName,
        ZipArchive::OPSYS_UNIX,
        (0100644 << 16),
    )) {
        throw new RuntimeException(sprintf('Could not normalize ZIP permissions for "%s".', $localName));
    }
}
