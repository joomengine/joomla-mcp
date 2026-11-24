<?php

declare(strict_types=1);

// Isolated acceptance fixture. This identity may log in to the Joomla API.
// JCB's per-record ACL still denies it access to JCB language definitions.
require __DIR__ . '/jcb-bootstrap.php';
require_once '/var/www/html/configuration.php';

$config = new JConfig();
if ($config->sitename !== 'JoomEngine MCP for Joomla Integration Fixture' || !preg_match('/^[A-Za-z0-9_]+$/D', $config->dbprefix)) {
    throw new RuntimeException('Expected the disposable JoomEngine fixture.');
}
$db = new PDO('mysql:host=' . explode(':', $config->host)[0] . ';dbname=' . $config->db, $config->user, $config->password, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$p = $config->dbprefix;
$row = $db->query("SELECT u.id AS user_id, g.id AS group_id FROM `{$p}users` u
    JOIN `{$p}user_usergroup_map` m ON m.user_id=u.id JOIN `{$p}usergroups` g ON g.id=m.group_id
    WHERE u.username='mcpjcbreader' AND g.title='Registered'")->fetch(PDO::FETCH_ASSOC);
if (!$row) {
    throw new RuntimeException('Expected the registered JCB ACL fixture identity.');
}
$user = (int) $row['user_id'];
$group = (int) $row['group_id'];
$db->beginTransaction();
$asset = $db->query("SELECT id, rules FROM `{$p}assets` WHERE parent_id=0")->fetch(PDO::FETCH_ASSOC);
$rules = json_decode($asset['rules'], false, 32, JSON_THROW_ON_ERROR);
$rules = (object) $rules;
$rules->{'core.login.api'} = (object) ($rules->{'core.login.api'} ?? []);
$rules->{'core.login.api'}->{(string) $group} = 1;
$db->prepare("UPDATE `{$p}assets` SET rules=? WHERE id=?")->execute([json_encode($rules, JSON_THROW_ON_ERROR), $asset['id']]);
$asset = $db->query("SELECT id, rules FROM `{$p}assets` WHERE name='com_componentbuilder'")->fetch(PDO::FETCH_ASSOC);
$rules = json_decode($asset['rules'], false, 32, JSON_THROW_ON_ERROR);
$rules = (object) $rules;
$rules->{'language.access'} = (object) ($rules->{'language.access'} ?? []);
$rules->{'language.access'}->{(string) $group} = 0;
$db->prepare("UPDATE `{$p}assets` SET rules=? WHERE id=?")->execute([json_encode($rules, JSON_THROW_ON_ERROR), $asset['id']]);
$plugin = $db->query("SELECT extension_id, params FROM `{$p}extensions` WHERE folder='user' AND element='token'")->fetch(PDO::FETCH_ASSOC);
$params = json_decode($plugin['params'] ?: '{}', true, 32, JSON_THROW_ON_ERROR);
$params['allowedUserGroups'] = array_values(array_unique(array_merge((array) ($params['allowedUserGroups'] ?? [8]), [$group])));
$db->prepare("UPDATE `{$p}extensions` SET params=? WHERE extension_id=?")->execute([json_encode($params, JSON_THROW_ON_ERROR), $plugin['extension_id']]);
$seed = random_bytes(32);
$db->prepare("DELETE FROM `{$p}user_profiles` WHERE user_id=? AND profile_key IN ('joomlatoken.token','joomlatoken.enabled')")->execute([$user]);
$profile = $db->prepare("INSERT INTO `{$p}user_profiles` (user_id, profile_key, profile_value, ordering) VALUES (?, ?, ?, ?)");
$profile->execute([$user, 'joomlatoken.token', base64_encode($seed), 1]);
$profile->execute([$user, 'joomlatoken.enabled', '1', 2]);
$db->commit();
\Joomla\CMS\Access\Access::clearStatics();
$actor = $container->get(\Joomla\CMS\User\UserFactoryInterface::class)->loadUserById($user);
if (!$actor->authorise('core.login.api') || $actor->authorise('language.access', 'com_componentbuilder')) {
    throw new RuntimeException('The test identity must be authorized to use Joomla Web Services and denied JCB language access.');
}
echo base64_encode('sha256:' . $user . ':' . hash_hmac('sha256', $seed, $config->secret));
