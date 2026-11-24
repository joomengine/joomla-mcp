<?php

declare(strict_types=1);

use Joomla\CMS\Application\ConsoleApplication;
use Joomla\CMS\Factory;
use Joomla\CMS\Session\Session;
use Joomla\Session\SessionInterface;

define('_JEXEC', 1);
define('JPATH_BASE', '/var/www/html');
require JPATH_BASE . '/includes/defines.php';
require JPATH_BASE . '/includes/framework.php';
$container = Factory::getContainer();
$container->alias('session', 'session.cli')->alias(Session::class, 'session.cli')
    ->alias(\Joomla\Session\Session::class, 'session.cli')->alias(SessionInterface::class, 'session.cli');
$app = $container->get(ConsoleApplication::class);
Factory::$application = $app;
$app->createExtensionNamespaceMap();
if ($app->get('sitename') !== 'JoomEngine MCP for Joomla Integration Fixture') {
    throw new RuntimeException('Expected the disposable JoomEngine fixture.');
}
