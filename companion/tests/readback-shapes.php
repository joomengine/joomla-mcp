<?php

declare(strict_types=1);

use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;

function articleReadbackAction(object $model, string $operation): CoreEntityAction
{
    $entity = array_values(array_filter(CoreEntityCatalogue::all(), static fn ($entity): bool => $entity->id === 'content.articles'))[0];
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            return $this->model;
        }
    };

    return new CoreEntityAction($entity, $operation, $provider);
}

function articleReadbackModel(): object
{
    return new class {
        public int $tableLoads = 0;
        public mixed $returnedId = 41;
        public array $saved = [];
        public array $item = [
            'metadata' => [],
            'attribs' => ['nested' => [], 'list' => [], 'numeric' => ['a', 'b']],
            'images' => [],
            'urls' => ['url' => 'https://example.test'],
        ];
        public array $stored = [
            'metadata' => '{}',
            'attribs' => '{"nested":{},"list":[],"numeric":{"0":"a","1":"b"}}',
            'images' => '[]',
            'urls' => '{"url":"https://example.test"}',
            'password' => 'must-not-leak',
        ];

        public function setState(string $key, mixed $value): void
        {
        }

        public function getState(string $key, int $default = 0): int
        {
            return 41;
        }

        public function getItem(int $id): object
        {
            return (object) (['id' => $this->returnedId] + $this->item);
        }

        public function getTotal(): int
        {
            return 1;
        }

        public function getItems(): array
        {
            return [$this->getItem(41)];
        }

        public function getTable(): object
        {
            return new class ($this) extends stdClass {
                public function __construct(private object $model)
                {
                }

                public function load(int $id): bool
                {
                    ++$this->model->tableLoads;

                    foreach ($this->model->stored as $field => $raw) {
                        $this->{$field} = $raw;
                    }

                    return true;
                }
            };
        }

        public function save(array $payload): bool
        {
            $this->saved = $payload;

            return true;
        }
    };
}

test('native single-item read restores stored object and list shapes lost by Registry toArray', static function (): void {
    $model = articleReadbackModel();
    $result = articleReadbackAction($model, 'get')->execute(['id' => 41]);
    $wire = json_decode(json_encode($result, JSON_THROW_ON_ERROR), false, 64, JSON_THROW_ON_ERROR);
    expect($wire->item->metadata instanceof stdClass, 'Stored {} was reported as [].');
    expect($wire->item->attribs->nested instanceof stdClass && $wire->item->attribs->list === [], 'Nested object/list shapes were lost.');
    expect($wire->item->attribs->numeric instanceof stdClass, 'A numeric-key mapping became a list.');
    expect($wire->item->images === [], 'Stored [] was fabricated as {}.');
    expect($model->tableLoads === 1, 'The single-item read did not use one fixed native table load.');
    expect(!str_contains(json_encode($result, JSON_THROW_ON_ERROR), 'must-not-leak'), 'Table rehydration bypassed the readable field allowlist.');
});

test('native saved read-back restores stored shapes without changing the approved object input', static function (): void {
    $model = articleReadbackModel();
    $approved = json_decode('{"title":"Shape test","metadata":{},"attribs":{"nested":{},"list":[],"numeric":{"0":"a","1":"b"}}}', false, 64, JSON_THROW_ON_ERROR);
    $before = json_encode($approved, JSON_THROW_ON_ERROR);
    $result = articleReadbackAction($model, 'create')->execute(['data' => $approved, 'dryRun' => false, '_edgeConfirmed' => true]);
    expect($result['item']['metadata'] instanceof stdClass, 'Saved empty mapping did not survive read-back.');
    expect(json_encode($result['item']['attribs'], JSON_THROW_ON_ERROR) === json_encode($approved->attribs, JSON_THROW_ON_ERROR), 'Saved nested mapping differs from approved intent.');
    expect(json_encode($approved, JSON_THROW_ON_ERROR) === $before, 'Read-back normalization changed the approved input.');
    expect($model->saved['metadata'] === [], 'Joomla native binding did not receive its expected array.');
    expect($model->tableLoads === 1, 'Saved read-back loaded the native table more than once.');
});

test('bounded native object and JsonSerializable output keeps mappings and arrays distinct', static function (): void {
    $model = articleReadbackModel();
    $model->item['metadata'] = new class implements JsonSerializable {
        public function jsonSerialize(): object
        {
            return (object) ['empty' => new stdClass(), 'list' => [], 'numeric' => (object) ['0' => 'a', '1' => 'b']];
        }
    };
    $model->stored = [];
    $result = articleReadbackAction($model, 'get')->execute(['id' => 41]);
    $metadata = json_decode(json_encode($result['item']['metadata'], JSON_THROW_ON_ERROR), false, 64, JSON_THROW_ON_ERROR);
    expect($metadata instanceof stdClass && $metadata->empty instanceof stdClass, 'JsonSerializable mappings became arrays.');
    expect($metadata->list === [] && $metadata->numeric instanceof stdClass, 'Mapping/list output shapes changed.');

    $model->item['metadata'] = (object) array_fill(0, 1_001, 'too-many');
    expect(articleReadbackAction($model, 'get')->execute(['id' => 41])['item']['metadata'] === null, 'Oversized object bypassed output bounds.');
});

test('stored JSON recovery retains native evidence on malformed oversized or scalar fields', static function (): void {
    $model = articleReadbackModel();
    $model->item = ['metadata' => ['native' => 'metadata'], 'attribs' => ['native' => 'attribs'], 'images' => ['native' => 'images']];
    $model->stored = ['metadata' => '{invalid', 'attribs' => str_repeat(' ', 524_289), 'images' => 'null'];
    $item = articleReadbackAction($model, 'get')->execute(['id' => 41])['item'];
    expect($item['metadata'] === $model->item['metadata'], 'Malformed JSON invented a new mapping shape.');
    expect($item['attribs'] === $model->item['attribs'], 'Oversized stored JSON bypassed bounds.');
    expect($item['images'] === $model->item['images'], 'Scalar Registry data invented a container shape.');
});

test('stored shape recovery preserves native redactions and transformed values', static function (): void {
    $model = articleReadbackModel();
    $model->item['metadata'] = ['visible' => 'public'];
    $model->item['attribs'] = ['count' => 1];
    $model->stored['metadata'] = '{"visible":"public","privateToken":"hidden-value-must-not-leak"}';
    $model->stored['attribs'] = '{"count":"1"}';
    $result = articleReadbackAction($model, 'get')->execute(['id' => 41]);
    expect($result['item']['metadata'] === ['visible' => 'public'], 'Raw table content undid the native model redaction.');
    expect($result['item']['attribs'] === ['count' => 1], 'Shape recovery replaced a native value or scalar type.');
    expect(!str_contains(json_encode($result, JSON_THROW_ON_ERROR), 'hidden-value-must-not-leak'), 'Hidden raw member leaked.');

    $model->item['attribs'] = ['second' => [], 'first' => ['nested' => []]];
    $model->stored['attribs'] = '{"first":{"nested":{}},"second":[]}';
    $wire = json_decode(json_encode(articleReadbackAction($model, 'get')->execute(['id' => 41]), JSON_THROW_ON_ERROR), false, 64, JSON_THROW_ON_ERROR);
    expect($wire->item->attribs->first->nested instanceof stdClass, 'Equivalent named mappings with different key order could not recover shape.');
    expect($wire->item->attribs->second === [], 'Key-order-independent recovery changed a list.');
});

test('native list reads never load per-record tables and wrong item IDs never rehydrate', static function (): void {
    $model = articleReadbackModel();
    $model->item['metadata'] = new stdClass();
    $result = articleReadbackAction($model, 'list')->execute(['offset' => 0, 'limit' => 1]);
    expect($result['items'][0]['metadata'] instanceof stdClass, 'An actual list object became a list.');
    expect($model->tableLoads === 0, 'List reads introduced a native table lookup for each row.');
    $model->item['metadata'] = [];

    foreach ([null, 41.5, '41suffix', 0] as $invalidId) {
        $model->returnedId = $invalidId;

        try {
            articleReadbackAction($model, 'get')->execute(['id' => 41]);
        } catch (ActionException $exception) {
            expect($exception->errorCode === 'NOT_FOUND', 'Invalid native identity changed the existing get error behavior.');
        }

        expect($model->tableLoads === 0, 'Missing or malformed native identity reached stored field recovery.');
    }

    $model->returnedId = 42;

    try {
        articleReadbackAction($model, 'get')->execute(['id' => 41]);
        throw new RuntimeException('Wrong native item ID was accepted.');
    } catch (ActionException $exception) {
        expect($exception->errorCode === 'NOT_FOUND', 'Wrong native item ID produced an unexpected error.');
    }

    expect($model->tableLoads === 0, 'Wrong native item ID reached stored field recovery.');
});
