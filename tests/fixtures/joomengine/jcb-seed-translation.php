<?php

declare(strict_types=1);

use Joomla\CMS\User\UserFactoryInterface;
use Joomla\Database\DatabaseInterface;

require __DIR__ . '/jcb-bootstrap.php';

$marker = $argv[1] ?? '';
if (PHP_SAPI !== 'cli' || getcwd() !== '/tmp/joomla-mcp-jcb-fixture'
    || !preg_match('/^jcbfixture[0-9a-f]{32}$/D', $marker)) {
    throw new RuntimeException('Expected an isolated translation fixture and unique run marker.');
}
$_SERVER['HTTP_HOST'] = '127.0.0.1';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['HTTPS'] = 'off';
define('JPATH_COMPONENT', JPATH_ADMINISTRATOR . '/components/com_componentbuilder');
define('JPATH_COMPONENT_ADMINISTRATOR', JPATH_COMPONENT);
$admin = $container->get(UserFactoryInterface::class)->loadUserByUsername('mcpfixture');
if ((int) $admin->id < 1 || !$admin->authorise('core.admin')) {
    throw new RuntimeException('The fixture administrator is unavailable.');
}
$app->loadIdentity($admin);
$db = $container->get(DatabaseInterface::class);
$source = 'MCP translation ' . $marker . ' %s';
$lookup = static function () use ($db, $source): array {
    $query = $db->createQuery()->select($db->quoteName('id'))->from($db->quoteName('#__componentbuilder_language_translation'))
        ->where($db->quoteName('source') . ' = ' . $db->quote($source));
    return array_map('intval', $db->setQuery($query)->loadColumn());
};
if ($lookup() !== []) {
    throw new RuntimeException('The native translation source must be unique to this fixture run.');
}
$model = $app->bootComponent('com_componentbuilder')->getMVCFactory()
    ->createModel('Language_translation', 'Administrator', ['ignore_request' => true]);
$model->setCurrentUser($admin);
// The API form disables source on create. Seed through the actual administrator
// model as the native JCB golden acceptance suite does; all later edits use MCP.
if (!$model->save(['id' => 0, 'source' => $source, 'translation' => [], 'components' => [],
    'modules' => [], 'plugins' => [], 'params' => [], 'access' => 1, 'published' => 1])) {
    throw new RuntimeException('JCB did not save its owned translation fixture.');
}
$id = (int) $model->getState('language_translation.id');
if ($id < 1 || $lookup() !== [$id]) {
    throw new RuntimeException('Native persistence did not preserve the translation source and identity.');
}
echo $id, PHP_EOL;
