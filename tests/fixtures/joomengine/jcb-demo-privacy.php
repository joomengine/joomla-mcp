<?php

declare(strict_types=1);

use Joomla\Database\DatabaseInterface;

// Demo J6's Look admin view requests Joomla Privacy Suite integration. JCB's
// stock content plugin stores a site-local numeric JCB definition ID.
if (PHP_SAPI !== 'cli' || getcwd() !== '/tmp/joomla-mcp-jcb-fixture') {
    throw new RuntimeException('Run this setup only from the disposable JCB fixture.');
}
require __DIR__ . '/jcb-bootstrap.php';
$db = $container->get(DatabaseInterface::class);
$demo = '1c20aec5-bf1a-44e7-9deb-d1c920ca591d';
$releaseGuid = '6618d863-8751-4476-931a-5599fb9da7bb';
$releaseGroup = '2d8677ea-cda3-48d3-828d-da656c52dbe1';
$target = $db->setQuery("SELECT extension_id,enabled,params FROM #__extensions WHERE type='plugin'"
    . " AND folder='content' AND element='componentbuilderprivacytabs'")->loadObject();
if (!$target) {
    throw new RuntimeException('The Component Builder Privacy Tabs content plugin is missing from the fixture.');
}
// Read the component's actual package selection. Different installed JCB data
// sets may give its privacy plugin and group different GUIDs or numeric IDs.
$links = $db->setQuery('SELECT addjoomla_plugins FROM #__componentbuilder_component_plugins'
    . ' WHERE joomla_component=' . $db->quote($demo))->loadColumn();
if (!$links) {
    throw new RuntimeException('Demo J6 has no installed component-to-plugin selection.');
}
$selected = [];
foreach ($links as $value) {
    foreach (json_decode($value, true, 64, JSON_THROW_ON_ERROR) as $link) {
        $id = (string) ($link['plugin'] ?? '');
        if (preg_match('/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/Di', $id)) {
            $predicate = 'p.guid=' . $db->quote($id);
        } elseif (ctype_digit($id) && (int) $id > 0) {
            $predicate = 'p.id=' . (int) $id;
        } else {
            continue;
        }
        // The JCB group name is the machine Joomla plugin folder appearing in
        // the compiled manifest. Only a definition selected by Demo qualifies.
        $row = $db->setQuery('SELECT p.id,p.guid,p.published,g.guid AS groupGuid FROM #__componentbuilder_joomla_plugin AS p'
            . ' JOIN #__componentbuilder_joomla_plugin_group AS g ON (g.guid=p.joomla_plugin_group'
            . ' OR CAST(g.id AS CHAR)=p.joomla_plugin_group) WHERE ' . $predicate
            . ' AND g.name=' . $db->quote('privacy'))->loadObject();
        if ($row && (int) $row->id > 0) {
            $selected[(int) $row->id] = $row;
        }
    }
}
if (count($selected) !== 1) {
    throw new RuntimeException('Expected exactly one installed privacy-group definition selected by Demo J6; found ' . count($selected) . '.');
}
$row = reset($selected);
$definition = (int) $row->id;
$guid = (string) $row->guid;
$params = json_decode((string) ($target->params ?: '{}'), false, 64, JSON_THROW_ON_ERROR);
if (!is_object($params)) {
    $params = (object) $params;
}
if ((int) ($params->plugin ?? 0) > 0 && (int) $params->plugin !== $definition) {
    throw new RuntimeException('The fixture already selected a different global privacy definition.');
}
$params->plugin = $definition;
$update = (object) ['extension_id' => (int) $target->extension_id, 'enabled' => 1,
    'params' => json_encode($params, JSON_THROW_ON_ERROR)];
$db->updateObject('#__extensions', $update, 'extension_id');
$stored = json_decode((string) $db->setQuery('SELECT params FROM #__extensions WHERE extension_id='
    . (int) $target->extension_id)->loadResult(), true, 64, JSON_THROW_ON_ERROR);
if ((int) ($stored['plugin'] ?? 0) !== $definition) {
    throw new RuntimeException('The fixture global privacy selection did not persist.');
}
echo json_encode(['definitionGuid' => $guid, 'definitionPublication' => (int) $row->published,
    'contentPluginWasEnabled' => (bool) $target->enabled, 'releaseDefinitionGuidMatches' => $guid === $releaseGuid,
    'releaseGroupGuidMatches' => (string) $row->groupGuid === $releaseGroup, 'configured' => true], JSON_THROW_ON_ERROR);
