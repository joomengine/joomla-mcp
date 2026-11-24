<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use FilesystemIterator;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use ReflectionMethod;
use ReflectionProperty;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use ZipArchive;

/** Read-back only: hashes of the native file/folder on disk versus fresh bytes from its selected branch. */
final class FileComparison
{
    private int $bytes = 0;
    private int $reads = 0;

    public function matches(array $dependency, object $service, object $normalize, bool $push, ?object $configured, bool $retained): bool
    {
        $folder = ($dependency['entity'] ?? '') === 'folder';
        $key = $dependency['key'] ?? '';
        $path = $dependency['value'] ?? '';
        $target = $dependency['target'] ?? '';
        if (!in_array($dependency['entity'] ?? '', ['file', 'folder'], true) || !is_string($key)
            || !preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:\.[a-z0-9]{1,16})?$/Di', $key)
            || !is_string($path) || strlen($path) > 4096 || str_contains($path, "\0") || str_contains($path, '://')
            || !in_array($target, ['custom', 'compiler', 'image', 'images', 'full'], true)) {
            throw new ActionException('JCB_VERIFY_FILE', 'Unsupported native file dependency.');
        }
        $native = $normalize->full($path, $target);
        $actualPath = is_string($native) ? realpath($native) : false;
        $root = realpath(JPATH_ROOT);
        if ($root === false || $actualPath === false || !str_starts_with($actualPath, $root . DIRECTORY_SEPARATOR)
            || is_link($native)) {
            throw new ActionException('JCB_VERIFY_FILE', 'The native file reference lies outside the installation.');
        }
        $local = $folder ? $this->localDirectory($actualPath, $push) : $this->localFile($actualPath);
        if (!$push && $retained) {
            return true;
        }
        $grep = clone (new ReflectionProperty($service, 'grep'))->getValue($service);
        $git = (new ReflectionProperty($grep, 'contents'))->getValue($grep);
        $grep->setBranchField($push ? 'write_branch' : 'read_branch');
        $repos = $push ? $service->repos : ($configured === null ? $grep->paths : [$configured]);
        $verified = 0;
        foreach ($repos as $entry) {
            $repo = clone $entry;
            if ($push && (empty($repo->write_branch) || $repo->write_branch === 'default'
                || !(new ReflectionMethod($service, 'targetRepo'))->invoke($service, (object) $dependency, $repo))) {
                continue;
            }
            if (!$push && !$grep->validRepo($repo)) {
                throw new ActionException('JCB_VERIFY_SOURCE', 'The native read repository is unavailable.');
            }
            if (++$this->reads > 500) {
                throw new ActionException('JCB_VERIFY_LIMIT', 'Too many file repository readbacks.');
            }
            $branch = $push ? $repo->write_branch : ($repo->read_branch ?? (new ReflectionProperty($grep, 'branch_name'))->getValue($grep));
            $git->setTarget($repo->target ?? 'gitea');
            try {
                $grep->loadApi($git, $repo->base ?? null, $repo->token ?? null);
                $index = $git->get($repo->organisation, $repo->repository, $service->getIndexPath(), $branch);
                $item = $index->{$key} ?? null;
                if (!$push && $item === null) {
                    continue;
                }
                $remotePath = $item->path ?? null;
                if (!is_string($remotePath) || !$this->safeName($remotePath)
                    || ($push && $remotePath !== (new ReflectionMethod($service, 'index_map_IndexSettingsPath'))->invoke($service, (object) $dependency))) {
                    return false;
                }
                $meta = $git->metadata($repo->organisation, $repo->repository, $remotePath, $branch);
                if (!is_int($meta->size ?? null) || ($meta->type ?? 'file') !== 'file') {
                    return false;
                }
                $this->reserve($meta->size);
                $data = ($meta->encoding ?? '') === 'base64' && is_string($meta->content ?? null)
                    ? base64_decode($meta->content, true)
                    : $git->get($repo->organisation, $repo->repository, $remotePath, $branch);
                if (!is_string($data) || strlen($data) !== $meta->size
                    || $local !== ($folder ? $this->archive($data) : hash('sha256', $data))) {
                    return false;
                }
                $verified++;
                if (!$push) {
                    break;
                }
            } finally {
                $git->reset_();
            }
        }
        return $verified > 0;
    }

    private function safeName(string $relative): bool
    {
        return $relative !== '' && strlen($relative) <= 4096 && $relative[0] !== '/'
            && !str_contains($relative, '\\') && !preg_match('/[:\x00-\x1f\x7f]/', $relative)
            && !array_intersect(explode('/', $relative), ['.', '..']);
    }

    private function localFile(string $path): string
    {
        if (!is_file($path) || is_link($path) || ($size = filesize($path)) === false) {
            throw new ActionException('JCB_VERIFY_FILE', 'A native dependency is not a regular file.');
        }
        $this->reserve($size);
        $bytes = file_get_contents($path, false, null, 0, $size + 1);
        if (!is_string($bytes) || strlen($bytes) !== $size) {
            throw new ActionException('JCB_VERIFY_FILE', 'A native file changed during read-back.');
        }
        return hash('sha256', $bytes);
    }

    private function localDirectory(string $dir, bool $push): array
    {
        $source = new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS);
        $filter = new \RecursiveCallbackFilterIterator($source, static function ($entry) use ($push): bool {
            $name = $entry->getFilename();
            return !$push || (!in_array($name, ['.svn', 'CVS', '.DS_Store', '__MACOSX'], true) && !str_contains($name, '~'));
        });
        $files = [];
        $seen = 0;
        foreach (new RecursiveIteratorIterator($filter, RecursiveIteratorIterator::SELF_FIRST) as $entry) {
            $name = substr($entry->getPathname(), strlen($dir) + 1);
            if (++$seen > 10000 || !$this->safeName($name) || $entry->isLink()) {
                throw new ActionException('JCB_VERIFY_FILE', 'A folder exceeds its bounded regular-file contract.');
            }
            if (!$entry->isDir()) {
                $files[$name] = $this->localFile($entry->getPathname());
            }
        }
        ksort($files);
        return $files;
    }

    private function archive(string $bytes): array
    {
        $temp = tmpfile();
        if ($temp === false) {
            throw new ActionException('JCB_VERIFY_FILE', 'Archive read-back storage unavailable.');
        }
        $zip = new ZipArchive();
        try {
            if (fwrite($temp, $bytes) !== strlen($bytes) || !fflush($temp)
                || $zip->open(stream_get_meta_data($temp)['uri'], ZipArchive::RDONLY | ZipArchive::CHECKCONS) !== true) {
                throw new ActionException('JCB_VERIFY_FILE', 'Invalid remote folder archive.');
            }
            try {
                if ($zip->numFiles > 10000) {
                    throw new ActionException('JCB_VERIFY_LIMIT', 'Too many archive entries.');
                }
                $files = $seen = [];
                for ($i = 0; $i < $zip->numFiles; $i++) {
                    $info = $zip->statIndex($i);
                    $name = $info['name'] ?? '';
                    if (!$this->safeName($name) || isset($seen[$name])
                        || !$zip->getExternalAttributesIndex($i, $os, $attributes)
                        || ($os === 3 && (($attributes >> 16) & 0170000) === 0120000)) {
                        throw new ActionException('JCB_VERIFY_FILE', 'Unsafe or duplicated archive entry.');
                    }
                    $seen[$name] = true;
                    if (str_ends_with($name, '/')) {
                        continue;
                    }
                    $this->reserve($info['size']);
                    $content = $zip->getFromIndex($i, $info['size'] + 1);
                    if (!is_string($content) || strlen($content) !== $info['size']) {
                        throw new ActionException('JCB_VERIFY_FILE', 'Archive entry could not be verified.');
                    }
                    $files[$name] = hash('sha256', $content);
                }
                ksort($files);
                return $files;
            } finally {
                $zip->close();
            }
        } finally {
            fclose($temp);
        }
    }

    private function reserve(int $length): void
    {
        if ($length < 0 || $length > 33554432 || ($this->bytes += $length) > 134217728) {
            throw new ActionException('JCB_VERIFY_LIMIT', 'File read-back exceeded the byte budget.');
        }
    }
}
