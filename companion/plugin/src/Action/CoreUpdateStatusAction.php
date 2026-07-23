<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final readonly class CoreUpdateStatusAction implements ActionInterface
{
    public function __construct(private ModelProviderInterface $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'core.update.status',
            'Return cached Joomla core update status without downloading or installing an update.',
            'read',
            [['action' => 'core.manage', 'asset' => 'com_joomlaupdate']],
            ['type' => 'object', 'properties' => [], 'additionalProperties' => false],
            [
                'type' => 'object',
                'required' => ['installed', 'latest', 'hasUpdate'],
                'properties' => [
                    'installed' => ['type' => 'string'],
                    'latest' => ['type' => ['string', 'null']],
                    'hasUpdate' => ['type' => 'boolean'],
                ],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, []);
        $model = $this->models->administrator('com_joomlaupdate', 'Update');

        if (!method_exists($model, 'getUpdateInformation')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Update model is incompatible.');
        }

        try {
            $information = $model->getUpdateInformation();
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', 'Joomla could not read core update status.');
        }

        if (!is_array($information)) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla Update model returned invalid status.');
        }

        return [
            'installed' => is_string($information['installed'] ?? null)
                ? $information['installed']
                : (defined('JVERSION') ? (string) JVERSION : 'unknown'),
            'latest' => is_string($information['latest'] ?? null) ? $information['latest'] : null,
            'hasUpdate' => ($information['hasUpdate'] ?? false) === true,
        ];
    }
}
