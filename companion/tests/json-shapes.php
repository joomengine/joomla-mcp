<?php

declare(strict_types=1);

use VDM\Plugin\Console\JoomlaMcp\Action\SystemInfoAction;
use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionRegistry;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;
use VDM\Plugin\Console\JoomlaMcp\Joomla\JoomlaActionRegistryFactory;
use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;
use VDM\Plugin\Console\JoomlaMcp\Protocol\DescriptionService;
use VDM\Plugin\Console\JoomlaMcp\Protocol\DispatchService;
use VDM\Plugin\Console\JoomlaMcp\Protocol\RequestDecoder;

test('wire decoder distinguishes omitted input and empty object from every non-object', static function (): void {
    $decoder = new RequestDecoder();
    $envelope = '{"protocol":"joomla-mcp/1","id":17,"action":"system.info"';
    expect($decoder->decode($envelope . '}')['input'] === [], 'Omitted input was rejected.');
    expect($decoder->decode($envelope . ',"input":{}}')['input'] === [], 'Empty object was rejected.');

    foreach (['[]', 'null', '""', '0', 'true', 'false', '[{}]'] as $invalid) {
        try {
            $decoder->decode($envelope . ',"input":' . $invalid . '}');
            throw new RuntimeException('Non-object input was accepted: ' . $invalid);
        } catch (ActionException $exception) {
            expect($exception->errorCode === 'INVALID_REQUEST', 'Non-object input produced the wrong error.');
        }
    }

    $dispatcher = new DispatchService(new ActionRegistry([new SystemInfoAction()]), $GLOBALS['allow']);
    $omitted = jsonObject($dispatcher->handleJson($envelope . '}'));
    $explicit = jsonObject($dispatcher->handleJson($envelope . ',"input":{}}'));
    expect($omitted['ok'] === true && $omitted === $explicit, 'Omitted and explicit empty-object dispatch differ.');
});

test('nested JSON objects and arrays retain their types through decode validation and serialization', static function (): void {
    $action = new class implements ActionInterface {
        public function descriptor(): ActionDescriptor
        {
            return new ActionDescriptor('test.shapes', 'Return bounded nested shapes.', 'read', [], [
                'type' => 'object', 'properties' => ['data' => ['type' => 'object']],
            ], ['type' => 'object']);
        }

        public function execute(array $input): array
        {
            $result = [];

            foreach (Input::object($input, 'data') as $key => $value) {
                $result[$key] = Input::boundedValue($value, $key);
            }

            return $result;
        }
    };
    $dispatcher = new DispatchService(new ActionRegistry([$action]), $GLOBALS['allow']);
    $response = json_decode($dispatcher->handleJson(
        '{"protocol":"joomla-mcp/1","id":"shapes","action":"test.shapes","input":{"data":{"emptyObject":{},"emptyArray":[],"nested":{"object":{},"array":[]},"numericMap":{"0":{},"1":[]}}}}',
    ), false, 64, JSON_THROW_ON_ERROR);
    expect($response->ok === true, 'Nested shape dispatch failed.');
    expect($response->result->emptyObject instanceof stdClass, 'Empty object became an array.');
    expect($response->result->emptyArray === [], 'Empty array became an object.');
    expect($response->result->nested->object instanceof stdClass && $response->result->nested->array === [], 'Nested shapes changed.');
    expect($response->result->numericMap instanceof stdClass, 'Numeric-key mapping became a list.');
});

test('validated JSON parameter objects become native Joomla arrays only at model save', static function (): void {
    $model = new class {
        public array $saved = [];

        public function save(array $data): bool
        {
            $this->saved = $data;
            expect(is_array($data['params']), 'Native Joomla parameters received a JSON object instead of form data.');
            expect(is_array($data['params']['nested']), 'Nested native form mapping was not converted.');
            expect($data['params']['emptyObject'] === [] && $data['params']['emptyArray'] === [], 'Native empty collections were not converted.');

            return true;
        }
    };
    $provider = new class ($model) implements ModelProviderInterface {
        public function __construct(private object $model)
        {
        }

        public function administrator(string $component, string $modelName): object
        {
            return $this->model;
        }
    };
    // Use a parameter-bearing reviewed entity without any fixture writes.
    $entity = array_values(array_filter(CoreEntityCatalogue::all(), static fn ($entity): bool => $entity->id === 'banners.banners'))[0];
    $action = new CoreEntityAction($entity, 'create', $provider);
    $decoded = (new RequestDecoder())->decode(
        '{"protocol":"joomla-mcp/1","id":"save-shapes","action":"banners.banners.create","input":{"data":{"name":"Example","params":{"nested":{"option":1},"emptyObject":{},"emptyArray":[]}},"dryRun":false,"_edgeConfirmed":true}}',
    );
    expect($decoded['input']['data']->params->emptyObject instanceof stdClass, 'Shape was lost before model dispatch.');
    $action->execute($decoded['input']);
    expect($model->saved['params']['nested']['option'] === 1, 'Native map contents changed.');
});

/** Validate JSON Schema container keywords without associative JSON decoding. */
function assertSchemaContainers(mixed $schema): void
{
    expect($schema instanceof stdClass || is_bool($schema), 'A schema must be an object or boolean.');

    if (is_bool($schema)) {
        return;
    }

    foreach (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as $keyword) {
        if (!property_exists($schema, $keyword)) {
            continue;
        }

        expect($schema->{$keyword} instanceof stdClass, 'Schema mapping keyword became an array: ' . $keyword);

        foreach (get_object_vars($schema->{$keyword}) as $nested) {
            assertSchemaContainers($nested);
        }
    }

    foreach (['required', 'enum', 'allOf', 'anyOf', 'oneOf', 'prefixItems'] as $keyword) {
        if (property_exists($schema, $keyword)) {
            expect(is_array($schema->{$keyword}), 'Schema list keyword became an object: ' . $keyword);
        }
    }

    if (property_exists($schema, 'items')) {
        assertSchemaContainers($schema->items);
    }
}

test('complete companion description serializes schema mapping and list keywords correctly', static function (): void {
    $registry = (new JoomlaActionRegistryFactory(new stdClass()))->create();
    $description = json_decode((new DescriptionService($registry, $GLOBALS['allow']))->toJson(), false, 64, JSON_THROW_ON_ERROR);
    expect(count($description->actions) === 231, 'Schema audit omitted catalogue actions.');

    foreach ($description->actions as $action) {
        assertSchemaContainers($action->inputSchema);
        assertSchemaContainers($action->outputSchema);
    }

    $system = array_values(array_filter($description->actions, static fn ($action): bool => $action->name === 'system.info'))[0];
    expect($system->inputSchema->properties instanceof stdClass, 'system.info advertises properties as an array.');
    expect(get_object_vars($system->inputSchema->properties) === [], 'system.info unexpectedly accepts properties.');
});
