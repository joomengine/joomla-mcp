<?php

declare(strict_types=1);

use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\CoreEntityDefinition;
use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;

/** The model preserves submitted values, including NULL, like Joomla's field table. */
function fieldDefaultModel(): object
{
    return new class {
        public array $saved = [];
        public array $state = [];
        public array $stored = ['id' => 41, 'title' => 'Existing field', 'default_value' => 'Existing default'];

        public function setState(string $key, mixed $value): void
        {
            $this->state[$key] = $value;
        }

        public function getState(string $key, int $default = 0): int
        {
            return 41;
        }

        public function getItem(int $id): object
        {
            return (object) $this->stored;
        }

        public function save(array $data): bool
        {
            $this->saved = $data;
            // The table binds fields present in the native save payload.
            $this->stored = array_merge(['id' => 41, 'default_value' => null], $data);

            return true;
        }
    };
}

function fieldDefaultAction(CoreEntityDefinition $entity, string $operation, object $model): CoreEntityAction
{
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

$fieldEntities = array_values(array_filter(
    CoreEntityCatalogue::all(),
    static fn (CoreEntityDefinition $entity): bool => str_starts_with($entity->id, 'fields.'),
));

test('all six native custom-field contexts are covered', static function () use ($fieldEntities): void {
    expect(count($fieldEntities) === 6, 'The regression suite must cover all six reviewed field contexts.');
});

foreach ($fieldEntities as $entity) {
    test($entity->id . ' creates use an empty omitted default and preserve explicit values', static function () use ($entity): void {
        $model = fieldDefaultModel();
        $action = fieldDefaultAction($entity, 'create', $model);
        $data = ['title' => 'New field', 'type' => 'text'];
        $preview = $action->execute(['data' => $data]);
        expect(in_array('default_value', $preview['fields'], true), 'The planned fields omit the derived empty default.');
        expect($model->saved === [], 'A field preview invoked persistence.');
        expect(!array_key_exists('default_value', $data), 'Planning mutated the caller data.');

        try {
            $action->execute(['data' => $data, 'dryRun' => false]);
            throw new RuntimeException('An unconfirmed field create was accepted.');
        } catch (ActionException $exception) {
            expect($exception->errorCode === 'CONFIRMATION_REQUIRED', 'Field create bypassed confirmation enforcement.');
        }
        expect($model->saved === [], 'An unconfirmed field create persisted data.');

        $result = $action->execute(['data' => $data, 'dryRun' => false, '_edgeConfirmed' => true]);
        expect($model->saved['default_value'] === '', 'The native save payload omitted the empty default.');
        expect($result['item']['default_value'] === '', 'Read-back did not retain the empty default.');
        expect($model->saved['context'] === $entity->defaults['context'], 'The fixed field context changed.');

        foreach (['', '0', 'Chosen default', '["one","two"]', 'one,two', null, 0, false, ['one', 'two']] as $value) {
            $action->execute([
                'data' => $data + ['default_value' => $value],
                'dryRun' => false,
                '_edgeConfirmed' => true,
            ]);
            expect(array_key_exists('default_value', $model->saved), 'An explicit default key was removed.');
            expect($model->saved['default_value'] === $value, 'An explicit default value was replaced.');
        }
    });

    test($entity->id . ' updates preserve omitted defaults and explicit clearing', static function () use ($entity): void {
        $model = fieldDefaultModel();
        $action = fieldDefaultAction($entity, 'update', $model);
        $input = ['id' => 41, 'data' => ['title' => 'Renamed field']];
        $preview = $action->execute($input);
        expect(!in_array('default_value', $preview['fields'], true), 'A partial update gained an unintended default.');
        expect($model->saved === [], 'An update preview persisted a field.');

        foreach (['Existing default', null] as $existing) {
            $model->stored['default_value'] = $existing;
            $action->execute($input + ['dryRun' => false, '_edgeConfirmed' => true]);
            expect($model->saved['default_value'] === $existing, 'A partial update overwrote the stored default.');
        }
        $action->execute([
            'id' => 41,
            'data' => ['default_value' => ''],
            'dryRun' => false,
            '_edgeConfirmed' => true,
        ]);
        expect($model->saved['default_value'] === '', 'An explicit default clear was not preserved.');
    });
}

test('field default creation fallback does not affect groups or unrelated entities', static function (): void {
    foreach (CoreEntityCatalogue::all() as $entity) {
        if (!in_array($entity->id, ['field-groups.content-articles', 'content.articles'], true)) {
            continue;
        }
        $model = fieldDefaultModel();
        $action = fieldDefaultAction($entity, 'create', $model);
        $action->execute(['data' => ['title' => 'New item'], 'dryRun' => false, '_edgeConfirmed' => true]);
        expect(!array_key_exists('default_value', $model->saved), 'A non-field entity gained a default value.');
    }
});

test('field creation still rejects empty data before deriving its fallback', static function () use ($fieldEntities): void {
    $model = fieldDefaultModel();
    $action = fieldDefaultAction($fieldEntities[0], 'create', $model);
    try {
        $action->execute(['data' => []]);
        throw new RuntimeException('Empty field create data was accepted.');
    } catch (ActionException $exception) {
        expect($exception->errorCode === 'INVALID_INPUT', 'Unexpected empty field data error.');
    }
    expect($model->saved === [], 'Empty field data reached persistence.');
});
