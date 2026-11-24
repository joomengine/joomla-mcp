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
$guid = '6618d863-8751-4476-931a-5599fb9da7bb';
$privacyGroup = '2d8677ea-cda3-48d3-828d-da656c52dbe1';
$definition = (int) $db->setQuery('SELECT id FROM #__componentbuilder_joomla_plugin WHERE published=1'
    . ' AND guid=' . $db->quote($guid) . ' AND joomla_plugin_group=' . $db->quote($privacyGroup))->loadResult();
$target = $db->setQuery("SELECT extension_id,params FROM #__extensions WHERE enabled=1 AND type='plugin'"
    . " AND folder='content' AND element='componentbuilderprivacytabs'")->loadObject();
if ($definition < 1 || !$target) {
    throw new RuntimeException('The disposable site lacks the stock JCB privacy definition or its content plugin.');
}
$params = json_decode((string) $target->params, false, 64, JSON_THROW_ON_ERROR);
if (!is_object($params)) {
    $params = (object) $params;
}
if ((int) ($params->plugin ?? 0) > 0 && (int) $params->plugin !== $definition) {
    throw new RuntimeException('The fixture already selected a different global privacy definition.');
}
$params->plugin = $definition;
$update = (object) ['extension_id' => (int) $target->extension_id,
    'params' => json_encode($params, JSON_THROW_ON_ERROR)];
$db->updateObject('#__extensions', $update, 'extension_id');
$stored = json_decode((string) $db->setQuery('SELECT params FROM #__extensions WHERE extension_id='
    . (int) $target->extension_id)->loadResult(), true, 64, JSON_THROW_ON_ERROR);
if ((int) ($stored['plugin'] ?? 0) !== $definition) {
    throw new RuntimeException('The fixture global privacy selection did not persist.');
}
echo json_encode(['definitionGuid' => $guid, 'configured' => true], JSON_THROW_ON_ERROR);
