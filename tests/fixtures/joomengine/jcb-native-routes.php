<?php

declare(strict_types=1);

use Joomla\CMS\Event\Application\BeforeApiRouteEvent;
use Joomla\CMS\Router\ApiRouter;

require __DIR__ . '/jcb-bootstrap.php';
$router = new ApiRouter($app);
$app->bootPlugin('componentbuilderapiroutes', 'webservices')->onBeforeApiRoute(
    new BeforeApiRouteEvent('onBeforeApiRoute', ['subject' => $app, 'router' => $router])
);
$routes = [];
foreach ($router->getRoutes() as $route) {
    $defaults = $route->getDefaults();
    if (($defaults['component'] ?? '') !== 'com_componentbuilder') {
        throw new RuntimeException('JCB plugin registered a route for an unexpected component.');
    }
    foreach ($route->getMethods() as $verb) {
        $key = $verb . ' ' . $route->getPattern();
        if (isset($routes[$key]) || ($verb === 'GET' && ($defaults['public'] ?? null) !== false)) {
            throw new RuntimeException('Unexpected duplicate or publicly readable route from installed JCB plugin.');
        }
        $routes[$key] = $route->getController();
    }
}
echo json_encode($routes, JSON_THROW_ON_ERROR);
