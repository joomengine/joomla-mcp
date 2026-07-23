<?php

declare(strict_types=1);

defined('_JEXEC') or die;

use Joomla\CMS\Factory;
use Joomla\CMS\Table\Extension;
use Joomla\Database\DatabaseInterface;

/**
 * Enables the console plugin after its first successful native Joomla install.
 *
 * Joomla stores newly installed non-editor plugins disabled by default. A
 * console integration which remains disabled cannot expose its installation
 * verification commands, so first install enables this exact plugin through
 * Joomla's Extension table API. Updates preserve the operator's current state.
 */
final class PlgConsoleJoomlaMcpInstallerScript
{
    public function postflight(string $type, object $parent): void
    {
        if ($type !== 'install') {
            return;
        }

        $database = Factory::getContainer()->get(DatabaseInterface::class);
        $extension = new Extension($database);
        $extensionId = (int) $extension->find([
            'type' => 'plugin',
            'folder' => 'console',
            'element' => 'joomlamcp',
        ]);

        if ($extensionId < 1 || !$extension->load($extensionId)) {
            throw new \RuntimeException('The installed JoomEngine MCP for Joomla console plugin could not be loaded.');
        }

        if ((int) $extension->enabled === 1) {
            return;
        }

        $extension->enabled = 1;

        if (!$extension->store()) {
            throw new \RuntimeException('The installed JoomEngine MCP for Joomla console plugin could not be enabled.');
        }
    }
}
