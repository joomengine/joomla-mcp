<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Joomla;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

final readonly class JoomlaModelProvider implements ModelProviderInterface
{
    public function __construct(private object $application)
    {
    }

    public function administrator(string $component, string $modelName): object
    {
        if (!method_exists($this->application, 'bootComponent')) {
            throw new ActionException('JOOMLA_RUNTIME_UNAVAILABLE', 'The Joomla component runtime is unavailable.');
        }

        try {
            $componentInstance = $this->application->bootComponent($component);
        } catch (Throwable) {
            throw new ActionException('COMPONENT_UNAVAILABLE', sprintf('Component "%s" is unavailable.', $component));
        }

        if (!is_object($componentInstance) || !method_exists($componentInstance, 'getMVCFactory')) {
            throw new ActionException('COMPONENT_UNAVAILABLE', sprintf('Component "%s" is unavailable.', $component));
        }

        try {
            $model = $componentInstance->getMVCFactory()->createModel(
                $modelName,
                'Administrator',
                ['ignore_request' => true],
            );
        } catch (Throwable) {
            throw new ActionException('MODEL_UNAVAILABLE', sprintf('Joomla model "%s.%s" is unavailable.', $component, $modelName));
        }

        if (!is_object($model)) {
            throw new ActionException('MODEL_UNAVAILABLE', sprintf('Joomla model "%s.%s" is unavailable.', $component, $modelName));
        }

        return $model;
    }
}
