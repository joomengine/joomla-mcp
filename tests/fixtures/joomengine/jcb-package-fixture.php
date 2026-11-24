<?php

declare(strict_types=1);

use Joomla\Database\DatabaseInterface;

// The pinned sibling acceptance suite uses the same local Gitea contents
// fixture and a component with a dependent component_updates definition.
require __DIR__ . '/jcb-bootstrap.php';
require getcwd() . '/RepositoryFixture.php';

[$file, $guid, $repoGuid] = $argv;
foreach ([$guid, $repoGuid] as $value) {
    if (!preg_match('/^[a-f0-9-]{36}$/D', $value)) {
        throw new RuntimeException('Expected disposable UUIDs.');
    }
}
$db = $container->get(DatabaseInterface::class);
$local = new RepositoryFixture();
$saved = $db->setQuery('SELECT id,published FROM #__componentbuilder_repository WHERE target=4')->loadAssocList();
$description = static function () use ($db, $guid): ?string {
    $value = $db->setQuery('SELECT short_description FROM #__componentbuilder_joomla_component WHERE guid=' . $db->quote($guid))->loadResult();
    return $value === null ? null : (string) $value;
};
$setDescription = static function (string $value) use ($db, $guid): void {
    $db->setQuery('UPDATE #__componentbuilder_joomla_component SET short_description=' . $db->quote($value) . ' WHERE guid=' . $db->quote($guid))->execute();
};
$deleteOwned = static function () use ($db, $guid): void {
    $db->setQuery('DELETE FROM #__componentbuilder_component_updates WHERE joomla_component=' . $db->quote($guid))->execute();
    $db->setQuery('DELETE FROM #__componentbuilder_joomla_component WHERE guid=' . $db->quote($guid))->execute();
};
$send = static function (array $result): void {
    echo json_encode($result, JSON_THROW_ON_ERROR) . PHP_EOL;
    flush();
};
try {
    $db->setQuery('UPDATE #__componentbuilder_repository SET published=0 WHERE target=4')->execute();
    $row = (object) ['guid'=>$repoGuid, 'system_name'=>'MCP disposable loopback packages', 'type'=>1,
        'base'=>$local->url(), 'organisation'=>'joomla', 'repository'=>'packages', 'target'=>4,
        'read_branch'=>'fixture', 'write_branch'=>'fixture', 'access_repo'=>0, 'token'=>'', 'username'=>'',
        'author_name'=>'MCP Fixture', 'author_email'=>'mcp@example.invalid', 'published'=>1, 'ordering'=>99999];
    $db->insertObject('#__componentbuilder_repository', $row, 'id');
    foreach (['index/joomla-component.json', 'index/component-updates.json'] as $index) {
        $local->write($index, '{}');
    }
    $row = (object) ['guid'=>$guid, 'name'=>'McpPackageFixture', 'name_code'=>'mcppackagefixture',
        'system_name'=>'MCP Package Fixture', 'short_description'=>'revision one', 'description'=>'Disposable definition',
        'component_version'=>'1.0.0', 'add_powers'=>0, 'preferred_joomla_version'=>6, 'author'=>'MCP Fixture',
        'email'=>'mcp@example.invalid', 'website'=>'https://example.invalid', 'companyname'=>'MCP Fixture',
        'license'=>'GNU/GPL', 'copyright'=>'Disposable fixture', 'published'=>1, 'params'=>'{}'];
    $db->insertObject('#__componentbuilder_joomla_component', $row, 'id');
    $row = (object) ['joomla_component'=>$guid, 'version_update'=>json_encode(['version_update0'=>[
        'version'=>'1.0.1', 'sql'=>'', 'url'=>'https://example.invalid/disposable.zip']], JSON_THROW_ON_ERROR),
        'published'=>1, 'params'=>'{}'];
    $db->insertObject('#__componentbuilder_component_updates', $row, 'id');
    $send(['ready'=>true]);
    while (($line = fgets(STDIN)) !== false) {
        switch (trim($line)) {
            case 'inspect':
            case 'remote-revision':
                $index = json_decode($local->read('index/joomla-component.json'), true, 64, JSON_THROW_ON_ERROR);
                $childIndex = json_decode($local->read('index/component-updates.json'), true, 64, JSON_THROW_ON_ERROR);
                $path = $index[$guid]['settings'];
                $remote = json_decode($local->read($path), true, 64, JSON_THROW_ON_ERROR);
                $child = json_decode($local->read($childIndex[$guid]['settings']), true, 64, JSON_THROW_ON_ERROR);
                if (trim($line) === 'remote-revision') {
                    $remote['short_description'] = 'revision two';
                    $local->write($path, json_encode($remote, JSON_THROW_ON_ERROR));
                }
                $hasLocalChild = (bool) $db->setQuery('SELECT id FROM #__componentbuilder_component_updates WHERE joomla_component=' . $db->quote($guid))->loadResult();
                $send(['nativeLocal'=>$description(), 'nativeRemote'=>$remote['short_description'],
                    'linkedRemote'=>$remote['guid'] === $guid && $child['joomla_component'] === $guid && !empty($remote['@dependencies']),
                    'linkedLocal'=>$hasLocalChild]);
                break;
            case 'delete-local':
                $deleteOwned();
                $send(['deleted'=>$description() === null]);
                break;
            case 'local-revision':
                $setDescription('local revision');
                $send(['changed'=>$description() === 'local revision']);
                break;
            case 'reject-writes':
                $setDescription('revision rejected by controlled repository');
                $local->rejectWrites(true);
                $send(['sha256'=>$local->fingerprint(), 'requests'=>count($local->requests())]);
                break;
            case 'fingerprint':
                $send(['sha256'=>$local->fingerprint(), 'requests'=>count($local->requests())]);
                break;
            case 'requests':
                $requests = $local->requests();
                $send(['methods'=>array_values(array_unique(array_column($requests, 'method'))),
                    'branches'=>array_values(array_unique(array_column($requests, 'branch')))]);
                break;
            default:
                throw new RuntimeException('Unknown disposable repository fixture operation.');
        }
    }
} finally {
    $deleteOwned();
    $db->setQuery('DELETE FROM #__componentbuilder_repository WHERE guid=' . $db->quote($repoGuid))->execute();
    foreach ($saved as $row) {
        $db->setQuery('UPDATE #__componentbuilder_repository SET published=' . (int) $row['published'] . ' WHERE id=' . (int) $row['id'])->execute();
    }
    $local->close();
}
