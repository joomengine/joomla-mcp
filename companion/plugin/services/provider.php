<?php

declare(strict_types=1);

defined('_JEXEC') or die;

use Joomla\CMS\Extension\PluginInterface;
use Joomla\CMS\Factory;
use Joomla\CMS\Plugin\PluginHelper;
use Joomla\CMS\User\UserFactoryInterface;
use Joomla\DI\Container;
use Joomla\DI\ServiceProviderInterface;
use Joomla\Event\DispatcherInterface;
use VDM\Plugin\Console\JoomlaMcp\Extension\JoomlaMcpPlugin;

return new class implements ServiceProviderInterface {
    public function register(Container $container): void
    {
        $container->set(
            PluginInterface::class,
            static function (Container $container): PluginInterface {
                $plugin = new JoomlaMcpPlugin(
                    $container->get(DispatcherInterface::class),
                    (array) PluginHelper::getPlugin('console', 'joomlamcp'),
                    $container->get(UserFactoryInterface::class),
                );
                $plugin->setApplication(Factory::getApplication());

                return $plugin;
            },
        );
    }
};
