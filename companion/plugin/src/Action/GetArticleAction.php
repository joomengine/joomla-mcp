<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;
use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaModelProvider;

final readonly class GetArticleAction implements ActionInterface
{
    private const FIELDS = [
        'id', 'title', 'alias', 'introtext', 'fulltext', 'state', 'catid',
        'access', 'language', 'created', 'created_by', 'modified', 'modified_by',
        'publish_up', 'publish_down', 'metadesc', 'metakey',
    ];

    public function __construct(private JoomlaModelProvider $models)
    {
    }

    public function descriptor(): ActionDescriptor
    {
        return new ActionDescriptor(
            'content.articles.get',
            'Get one article through the Joomla administrator Article model.',
            'read',
            [['action' => 'core.manage', 'asset' => 'com_content']],
            [
                'type' => 'object',
                'required' => ['id'],
                'properties' => ['id' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 2_147_483_647]],
                'additionalProperties' => false,
            ],
            [
                'type' => 'object',
                'properties' => [
                    'id' => ['type' => ['integer', 'null']],
                    'title' => ['type' => ['string', 'null']],
                    'alias' => ['type' => ['string', 'null']],
                    'introtext' => ['type' => ['string', 'null']],
                    'fulltext' => ['type' => ['string', 'null']],
                    'state' => ['type' => ['integer', 'string', 'null']],
                    'catid' => ['type' => ['integer', 'string', 'null']],
                    'access' => ['type' => ['integer', 'string', 'null']],
                    'language' => ['type' => ['string', 'null']],
                    'created' => ['type' => ['string', 'null']],
                    'created_by' => ['type' => ['integer', 'string', 'null']],
                    'modified' => ['type' => ['string', 'null']],
                    'modified_by' => ['type' => ['integer', 'string', 'null']],
                    'publish_up' => ['type' => ['string', 'null']],
                    'publish_down' => ['type' => ['string', 'null']],
                    'metadesc' => ['type' => ['string', 'null']],
                    'metakey' => ['type' => ['string', 'null']],
                ],
                'additionalProperties' => false,
            ],
        );
    }

    public function execute(array $input): array
    {
        Input::rejectUnknown($input, ['id']);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $model = $this->models->administrator('com_content', 'Article');

        if (!method_exists($model, 'getItem')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla Article model is incompatible.');
        }

        $item = $model->getItem($id);

        if (!is_object($item) || (int) ($item->id ?? 0) !== $id) {
            throw new ActionException('NOT_FOUND', sprintf('Article %d was not found.', $id));
        }

        $result = [];

        foreach (self::FIELDS as $field) {
            $value = $item->{$field} ?? null;
            $result[$field] = is_int($value) || is_string($value) ? $value : null;
        }

        return $result;
    }
}
