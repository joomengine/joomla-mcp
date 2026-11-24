<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use Joomla\CMS\Component\ComponentHelper;
use Throwable;
use VDM\Joomla\Componentbuilder\Factory as JcbFactory;

final class InstalledCommands
{
    /** Resolve after Joomla has finished firing the console registration event. */
    public static function actions(object $application, int $actorId): iterable
    {
        if (!method_exists($application, 'getAllCommands') || !ComponentHelper::isEnabled('com_componentbuilder')) {
            return;
        }
        $found = [];
        foreach ($application->getAllCommands() as $command) {
            $name = $command->getName();
            if (!is_string($name) || isset($found[$name])
                || !preg_match('/^componentbuilder:(compile|get|init|pull|push|reset):([a-z][a-z0-9_]{0,63})$/D', $name, $match)) {
                continue;
            }
            $found[$name] = true;
            [, $verb, $area] = $match;
            $compiler = $verb === 'compile';
            $class = 'VDM\\Joomla\\Componentbuilder\\Console\\' . ($compiler ? 'Compiler' : 'Package\\' . ucfirst($verb));
            if ($command::class !== $class || ($compiler && $area !== 'component')) {
                continue;
            }
            try {
                $properties = CommandOptions::properties($command->getDefinition(), $compiler);
                $entity = $compiler ? 'joomla_component' : (new \ReflectionProperty($class, 'entity'))->getValue($command);
                if ($properties === [] || !is_string($entity) || !preg_match('/^[a-z][a-z0-9_]{0,63}$/D', $entity)) {
                    continue;
                }
                if (!$compiler) {
                    $factory = JcbFactory::getEntityFactory($entity);
                    $nativeArea = JcbFactory::getArea($entity);
                    if ($factory === null || $nativeArea === null
                        || !$factory::getContainer()->has($nativeArea . '.Remote.' . ($verb === 'push' ? 'Set' : 'Get'))) {
                        continue;
                    }
                }
                yield new CommandAction($application, $command, $actorId, $verb, $area, $entity, $properties);
            } catch (Throwable) {
                // A changed or unresolvable native implementation cannot become an executable action.
                continue;
            }
        }
    }
}
