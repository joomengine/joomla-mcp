<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use VDM\Joomla\Componentbuilder\Table;
use VDM\Joomla\Database\Load;
use VDM\Joomla\Utilities\StringHelper;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

final readonly class DefinitionState
{
    public function __construct(private Load $load, private Table $metadata)
    {
    }

    /** Bind the existing definition graph, including repository settings and user-editable code, without returning it. */
    public function fingerprint(): string
    {
        $tables = $this->metadata->tables();
        if ($tables === [] || count($tables) > 128) {
            throw new ActionException('JCB_GRAPH_UNAVAILABLE', 'Cannot verify the installed JCB definition tables.');
        }
        sort($tables);
        $digest = hash_init('sha256');
        $total = $bytes = 0;
        foreach ($tables as $table) {
            if (!preg_match('/^[a-z][a-z0-9_]{0,63}$/D', $table)) {
                throw new ActionException('JCB_GRAPH_UNAVAILABLE', 'Unrecognized native JCB entity metadata.');
            }
            hash_update($digest, $table . "\0");
            $lastId = 0;
            do {
                $rows = $this->load->rows(['all' => 'a.*'], ['a' => '#__componentbuilder_' . $table],
                    ['id' => ['operator' => '>', 'value' => $lastId]], ['id' => 'ASC'], 64) ?? [];
                foreach ($rows as $row) {
                    $lastId = (int) $row['id'];
                    unset($row['checked_out'], $row['checked_out_time']);
                    $record = serialize($row);
                    $bytes += strlen($record);
                    if (++$total > 100000 || $bytes > 134217728) {
                        throw new ActionException('JCB_GRAPH_LIMIT', 'JCB definitions exceed the command preflight limit.');
                    }
                    hash_update($digest, $record);
                }
            } while (count($rows) === 64);
        }
        $extension = $this->load->row(['manifest_cache', 'params', 'enabled'], ['a' => '#__extensions'],
            ['type' => 'component', 'element' => 'com_componentbuilder']);
        if ($extension === null) {
            throw new ActionException('JCB_GRAPH_UNAVAILABLE', 'Installed JCB configuration could not be read.');
        }
        hash_update($digest, serialize($extension));
        return hash_final($digest);
    }

    public function hasRepository(string $guid): bool
    {
        if (!$this->metadata->exist('repository', 'guid')) {
            return false;
        }
        $repositories = $this->load->rows(['organisation', 'repository', 'published'],
            ['a' => '#__componentbuilder_repository'], ['guid' => $guid], null, 2) ?? [];
        if (count($repositories) !== 1) {
            return false;
        }
        $row = reset($repositories);
        // Native Grep treats empty coordinates as invalid and falls back to its default repositories.
        // Reject that case before dispatching a command approved for one explicit repository.
        return (int) $row['published'] >= 1 && !empty(trim((string) $row['organisation']))
            && !empty(trim((string) $row['repository']));
    }

    /** Bind the selected GUIDs to the identifiers and versions JCB writes into component manifests. */
    public function componentManifests(array $guids): array
    {
        if (count($guids) > 32) {
            throw new ActionException('INVALID_INPUT', 'Select at most 32 components per compiler job.');
        }
        $rows = $this->load->rows(['guid', 'name_code', 'component_version'], ['a' => '#__componentbuilder_joomla_component'],
            ['guid' => ['operator' => 'IN', 'value' => $guids]], null, 33) ?? [];
        $expected = [];
        $found = [];
        foreach ($rows as $row) {
            $code = StringHelper::safe((string) $row['name_code']);
            $version = preg_replace('/^v/i', '', (string) $row['component_version']);
            if (!preg_match('/^[a-z][a-z0-9_]{0,149}$/D', $code) || !is_string($version)
                || $version === '' || strlen($version) > 128 || isset($expected[$code])) {
                throw new ActionException('INVALID_INPUT', 'The selected components must have distinct verifiable native manifest identities.');
            }
            $expected[$code] = $version;
            $found[] = strtolower((string) $row['guid']);
        }
        if (array_diff(array_map('strtolower', $guids), $found) !== []) {
            throw new ActionException('INVALID_INPUT', 'Every selected component GUID must identify an installed JCB definition.');
        }
        return $expected;
    }
}
