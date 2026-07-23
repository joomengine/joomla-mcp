<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Action;

use JsonSerializable;
use Throwable;
use VDM\Plugin\Console\JoomlaMcp\Contract\ActionInterface;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionDescriptor;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\CoreEntityDefinition;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

/**
 * Executes one operation for one fixed CoreEntityDefinition.
 *
 * This is generic implementation code, not a generic public interface: every
 * component, model, field, default, ACL, and operation is selected from the
 * reviewed CoreEntityCatalogue before a request reaches this class.
 */
final readonly class CoreEntityAction implements ActionInterface
{
    private const OPERATIONS = ['list', 'get', 'create', 'update', 'delete', 'state'];
    private const STATES = [-2, 0, 1, 2];

    public function __construct(
        private CoreEntityDefinition $entity,
        private string $operation,
        private ModelProviderInterface $models,
    ) {
        if (!in_array($operation, self::OPERATIONS, true)) {
            throw new \InvalidArgumentException(sprintf('Unsupported core entity operation "%s".', $operation));
        }

        if ($operation === 'state' && !$entity->supportsState) {
            throw new \InvalidArgumentException(sprintf('Entity "%s" has no state operation.', $entity->id));
        }
    }

    public function descriptor(): ActionDescriptor
    {
        $aclAction = match ($this->operation) {
            'list', 'get' => 'core.manage',
            'create' => 'core.create',
            'update' => 'core.edit',
            'delete' => 'core.delete',
            'state' => 'core.edit.state',
        };
        $acl = [['action' => 'core.manage', 'asset' => $this->entity->component]];

        if ($aclAction !== 'core.manage') {
            $acl[] = ['action' => $aclAction, 'asset' => $this->entity->component];
        }

        return new ActionDescriptor(
            $this->entity->actionName($this->operation),
            sprintf('%s %s through fixed Joomla administrator models.', ucfirst($this->operation), $this->entity->label),
            $this->risk(),
            $acl,
            $this->inputSchema(),
            $this->outputSchema(),
        );
    }

    public function execute(array $input): array
    {
        return match ($this->operation) {
            'list' => $this->list($input),
            'get' => $this->get($input),
            'create' => $this->create($input),
            'update' => $this->update($input),
            'delete' => $this->delete($input),
            'state' => $this->state($input),
        };
    }

    /** @param array<string, mixed> $input */
    private function list(array $input): array
    {
        Input::rejectUnknown($input, ['offset', 'limit', 'search', 'state', 'order', 'direction']);
        $offset = Input::integer($input, 'offset', 0, 0, 1_000_000);
        $limit = Input::integer($input, 'limit', 20, 1, 100);
        $search = Input::text($input, 'search');
        $orderingFields = $this->orderingFields();
        $orderDefault = $orderingFields[0] ?? $this->entity->readFields[0];
        $order = (string) Input::choice($input, 'order', $orderDefault, $orderingFields === [] ? [$orderDefault] : $orderingFields);
        $direction = (string) Input::choice($input, 'direction', 'ASC', ['ASC', 'DESC']);
        $model = $this->model($this->entity->listModel, ['setState', 'getItems']);

        $this->setModelState($model);
        $model->setState('list.start', $offset);
        $model->setState('list.limit', $limit);
        $model->setState('list.ordering', $order);
        $model->setState('list.direction', $direction);

        if ($search !== '') {
            $model->setState('filter.search', $search);
        }

        if (array_key_exists('state', $input)) {
            $model->setState(
                $this->entity->stateFilter,
                Input::choice($input, 'state', 1, self::STATES),
            );
        }

        try {
            $rawItems = $model->getItems();
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not list %s.', $this->entity->label));
        }

        if (!is_array($rawItems)) {
            throw new ActionException('MODEL_RESULT_INVALID', sprintf('The Joomla %s model returned an invalid list.', $this->entity->label));
        }

        $items = [];

        foreach ($rawItems as $item) {
            if (is_object($item) || is_array($item)) {
                $items[] = $this->normalise($item);
            }
        }

        try {
            $total = method_exists($model, 'getTotal') ? (int) $model->getTotal() : count($items);
        } catch (Throwable) {
            $total = count($items);
        }

        return [
            'entity' => $this->entity->id,
            'items' => $items,
            'page' => [
                'offset' => $offset,
                'limit' => $limit,
                'count' => count($items),
                'total' => max(0, $total),
            ],
        ];
    }

    /** @param array<string, mixed> $input */
    private function get(array $input): array
    {
        Input::rejectUnknown($input, ['id']);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $model = $this->model($this->entity->itemModel, ['getItem']);
        $this->setModelState($model);

        try {
            $item = $model->getItem($id);
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not get %s %d.', $this->entity->label, $id));
        }

        if (!is_object($item) && !is_array($item)) {
            throw new ActionException('NOT_FOUND', sprintf('%s %d was not found.', ucfirst($this->entity->label), $id));
        }

        $record = $this->normalise($item);
        $returnedId = $record[$this->entity->primaryKey] ?? $record['id'] ?? null;

        if ($returnedId !== null && (int) $returnedId !== $id) {
            throw new ActionException('NOT_FOUND', sprintf('%s %d was not found.', ucfirst($this->entity->label), $id));
        }

        return ['entity' => $this->entity->id, 'item' => $record];
    }

    /** @param array<string, mixed> $input */
    private function create(array $input): array
    {
        Input::rejectUnknown($input, ['data', 'dryRun', '_edgeConfirmed']);
        $data = $this->data($input);

        if ($data === []) {
            throw new ActionException('INVALID_INPUT', 'Create data must contain at least one allowed field.');
        }

        $plan = $this->writePlan('create', null, array_keys($data));

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        $this->requireEdgeConfirmation($input);
        $model = $this->model($this->entity->itemModel, ['save']);
        $this->setModelState($model);
        $payload = array_merge($data, $this->entity->defaults);
        $this->save($model, $payload);
        $id = $this->savedId($model, null);

        return $this->applied('create', $id, $this->readSaved($model, $id));
    }

    /** @param array<string, mixed> $input */
    private function update(array $input): array
    {
        Input::rejectUnknown($input, ['id', 'data', 'dryRun', '_edgeConfirmed']);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $data = $this->data($input);

        if ($data === []) {
            throw new ActionException('INVALID_INPUT', 'Update data must contain at least one allowed field.');
        }

        $plan = $this->writePlan('update', $id, array_keys($data));

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        $this->requireEdgeConfirmation($input);
        $model = $this->model($this->entity->itemModel, ['save']);
        $this->setModelState($model);
        $payload = array_merge($data, $this->entity->defaults);
        $payload[$this->entity->primaryKey] = $id;
        $this->save($model, $payload);

        return $this->applied('update', $id, $this->readSaved($model, $id));
    }

    /** @param array<string, mixed> $input */
    private function delete(array $input): array
    {
        Input::rejectUnknown($input, ['id', 'dryRun', '_edgeConfirmed']);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $plan = $this->writePlan('delete', $id, []);

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        $this->requireEdgeConfirmation($input);
        $model = $this->model($this->entity->itemModel, ['delete']);
        $this->setModelState($model);
        $ids = [$id];

        try {
            $deleted = $model->delete($ids);
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not delete %s %d.', $this->entity->label, $id));
        }

        if ($deleted !== true) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla did not delete %s %d.', $this->entity->label, $id));
        }

        return $this->applied('delete', $id, null);
    }

    /** @param array<string, mixed> $input */
    private function state(array $input): array
    {
        Input::rejectUnknown($input, ['id', 'state', 'dryRun', '_edgeConfirmed']);
        $id = Input::integer($input, 'id', 0, 1, 2_147_483_647);
        $state = (int) Input::choice($input, 'state', 1, self::STATES);
        $plan = $this->writePlan('state', $id, ['state']) + ['state' => $state];

        if (Input::boolean($input, 'dryRun', true)) {
            return $plan;
        }

        $this->requireEdgeConfirmation($input);
        $model = $this->model($this->entity->itemModel, ['publish']);
        $this->setModelState($model);
        $ids = [$id];

        try {
            $changed = $model->publish($ids, $state);
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not change the state of %s %d.', $this->entity->label, $id));
        }

        if ($changed !== true) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla did not change the state of %s %d.', $this->entity->label, $id));
        }

        $item = $this->verifyState($id, $state);

        return $this->applied('state', $id, $item) + ['state' => $state];
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    private function data(array $input): array
    {
        $data = Input::object($input, 'data');
        $unknown = array_diff(array_keys($data), $this->entity->writeFields);

        if ($unknown !== []) {
            throw new ActionException(
                'INVALID_INPUT',
                sprintf('Field "%s" is not writable for %s.', (string) reset($unknown), $this->entity->id),
            );
        }

        $result = [];

        foreach ($data as $field => $value) {
            if (in_array($field, $this->entity->sensitiveFields, true)
                && (!is_string($value) || $value === '' || strlen($value) > 4_096 || str_contains($value, "\0"))) {
                throw new ActionException('INVALID_INPUT', sprintf('Sensitive field "%s" has an invalid value.', $field));
            }

            $result[$field] = Input::boundedValue($value, 'data.' . $field);
        }

        return $result;
    }

    /** @param list<string> $methods */
    private function model(string $name, array $methods): object
    {
        $model = $this->models->administrator($this->entity->component, $name);

        foreach ($methods as $method) {
            if (!method_exists($model, $method)) {
                throw new ActionException(
                    'MODEL_INCOMPATIBLE',
                    sprintf('The Joomla %s model does not support %s.', $this->entity->label, $this->operation),
                );
            }
        }

        return $model;
    }

    private function setModelState(object $model): void
    {
        if ($this->entity->modelState === []) {
            return;
        }

        if (!method_exists($model, 'setState')) {
            throw new ActionException('MODEL_INCOMPATIBLE', sprintf('The Joomla %s model cannot accept its fixed context.', $this->entity->label));
        }

        foreach ($this->entity->modelState as $key => $value) {
            $model->setState($key, $value);
        }
    }

    /** @param object|array<string, mixed> $item @return array<string, mixed> */
    private function normalise(object|array $item): array
    {
        $source = is_object($item) ? get_object_vars($item) : $item;
        $result = [];

        foreach ($this->entity->readFields as $field) {
            $result[$field] = $this->safeOutput($source[$field] ?? null);
        }

        return $result;
    }

    private function safeOutput(mixed $value, int $depth = 0): mixed
    {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value) || is_string($value)) {
            return $value;
        }

        if ($depth >= 6) {
            return null;
        }

        if ($value instanceof JsonSerializable) {
            try {
                return $this->safeOutput($value->jsonSerialize(), $depth + 1);
            } catch (Throwable) {
                return null;
            }
        }

        if (is_object($value)) {
            $value = get_object_vars($value);
        }

        if (!is_array($value) || count($value) > 1_000) {
            return null;
        }

        $result = [];

        foreach ($value as $key => $nested) {
            if (!is_int($key) && !is_string($key)) {
                continue;
            }

            $result[$key] = $this->safeOutput($nested, $depth + 1);
        }

        return $result;
    }

    /** @param array<string, mixed> $payload */
    private function save(object $model, array $payload): void
    {
        try {
            $saved = $model->save($payload);
        } catch (Throwable) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla could not save %s.', $this->entity->label));
        }

        if ($saved !== true) {
            throw new ActionException('MODEL_OPERATION_FAILED', sprintf('Joomla did not save %s.', $this->entity->label));
        }
    }

    private function savedId(object $model, ?int $fallback): ?int
    {
        if (!method_exists($model, 'getState')) {
            return $fallback;
        }

        try {
            $id = (int) $model->getState(strtolower($this->entity->itemModel) . '.id', $fallback ?? 0);

            return $id > 0 ? $id : $fallback;
        } catch (Throwable) {
            return $fallback;
        }
    }

    /** @return array<string, mixed>|null */
    private function readSaved(object $model, ?int $id): ?array
    {
        if ($id === null || !method_exists($model, 'getItem')) {
            return null;
        }

        try {
            $item = $model->getItem($id);

            return is_object($item) || is_array($item) ? $this->normalise($item) : null;
        } catch (Throwable) {
            return null;
        }
    }

    /** @return array<string, mixed> */
    private function verifyState(int $id, int $expected): array
    {
        // Use a new fixed Joomla item model after publish so a cached object can
        // never turn a native return value into a false applied=true result.
        $model = $this->model($this->entity->itemModel, ['getItem']);
        $this->setModelState($model);

        try {
            $item = $model->getItem($id);
        } catch (Throwable) {
            throw new ActionException(
                'POSTCONDITION_FAILED',
                sprintf('Joomla changed %s %d but its state could not be verified.', $this->entity->label, $id),
            );
        }

        if (!is_object($item) && !is_array($item)) {
            throw new ActionException(
                'POSTCONDITION_FAILED',
                sprintf('Joomla changed %s %d but returned no verification record.', $this->entity->label, $id),
            );
        }

        $record = $this->normalise($item);
        $returnedId = $record[$this->entity->primaryKey] ?? $record['id'] ?? null;
        $actual = $record[$this->entity->stateField] ?? null;

        if ((int) $returnedId !== $id
            || (!is_int($actual) && !(is_string($actual) && preg_match('/^-?\d+$/', $actual)))
            || (int) $actual !== $expected) {
            throw new ActionException(
                'POSTCONDITION_FAILED',
                sprintf('Joomla did not verify the requested state for %s %d.', $this->entity->label, $id),
            );
        }

        return $record;
    }

    /** @param array<string, mixed> $input */
    private function requireEdgeConfirmation(array $input): void
    {
        if (Input::boolean($input, '_edgeConfirmed', false) !== true) {
            throw new ActionException(
                'CONFIRMATION_REQUIRED',
                'Execution requires confirmation from the signed MCP edge apply flow.',
            );
        }
    }

    /** @param list<string> $fields @return array<string, mixed> */
    private function writePlan(string $operation, ?int $id, array $fields): array
    {
        return [
            'entity' => $this->entity->id,
            'operation' => $operation,
            'applied' => false,
            'dryRun' => true,
            'id' => $id,
            'fields' => $fields,
            'requiresEdgeConfirmation' => true,
        ];
    }

    /** @param array<string, mixed>|null $item @return array<string, mixed> */
    private function applied(string $operation, ?int $id, ?array $item): array
    {
        return [
            'entity' => $this->entity->id,
            'operation' => $operation,
            'applied' => true,
            'dryRun' => false,
            'id' => $id,
            'item' => $item,
        ];
    }

    private function risk(): string
    {
        return match ($this->operation) {
            'list', 'get' => 'read',
            'delete' => 'high',
            default => $this->entity->highRisk ? 'high' : 'write',
        };
    }

    /** @return array<string, mixed> */
    private function inputSchema(): array
    {
        if ($this->operation === 'list') {
            return [
                'type' => 'object',
                'properties' => [
                    'offset' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 1_000_000],
                    'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100],
                    'search' => ['type' => 'string', 'maxLength' => 200],
                    'state' => ['type' => 'integer', 'enum' => self::STATES],
                    'order' => ['type' => 'string', 'enum' => $this->orderingFields()],
                    'direction' => ['type' => 'string', 'enum' => ['ASC', 'DESC']],
                ],
                'additionalProperties' => false,
            ];
        }

        if ($this->operation === 'get') {
            return $this->idSchema();
        }

        $properties = [
            'dryRun' => ['type' => 'boolean', 'default' => true],
            '_edgeConfirmed' => ['type' => 'boolean', 'writeOnly' => true],
        ];
        $required = [];

        if (in_array($this->operation, ['update', 'delete', 'state'], true)) {
            $properties['id'] = ['type' => 'integer', 'minimum' => 1, 'maximum' => 2_147_483_647];
            $required[] = 'id';
        }

        if (in_array($this->operation, ['create', 'update'], true)) {
            $fieldSchemas = [];

            foreach ($this->entity->writeFields as $field) {
                $fieldSchemas[$field] = [
                    'type' => ['string', 'integer', 'number', 'boolean', 'array', 'object', 'null'],
                    'writeOnly' => in_array($field, $this->entity->sensitiveFields, true),
                ];
            }

            $properties['data'] = [
                'type' => 'object',
                'minProperties' => 1,
                'properties' => $fieldSchemas,
                'additionalProperties' => false,
            ];
            $required[] = 'data';
        }

        if ($this->operation === 'state') {
            $properties['state'] = ['type' => 'integer', 'enum' => self::STATES];
            $required[] = 'state';
        }

        return [
            'type' => 'object',
            'required' => $required,
            'properties' => $properties,
            'additionalProperties' => false,
        ];
    }

    /** @return array<string, mixed> */
    private function idSchema(): array
    {
        return [
            'type' => 'object',
            'required' => ['id'],
            'properties' => ['id' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 2_147_483_647]],
            'additionalProperties' => false,
        ];
    }

    /** @return list<string> */
    private function orderingFields(): array
    {
        $fields = array_values(array_unique(array_intersect(
            ['id', $this->entity->primaryKey, 'title', 'name', 'ordering', 'state', 'published', 'created', 'modified'],
            $this->entity->readFields,
        )));

        return $fields === [] ? [$this->entity->readFields[0]] : $fields;
    }

    /** @return array<string, mixed> */
    private function outputSchema(): array
    {
        if ($this->operation === 'list') {
            return [
                'type' => 'object',
                'required' => ['entity', 'items', 'page'],
                'properties' => [
                    'entity' => ['const' => $this->entity->id],
                    'items' => ['type' => 'array', 'items' => ['type' => 'object']],
                    'page' => ['type' => 'object'],
                ],
                'additionalProperties' => false,
            ];
        }

        if ($this->operation === 'get') {
            return [
                'type' => 'object',
                'required' => ['entity', 'item'],
                'properties' => [
                    'entity' => ['const' => $this->entity->id],
                    'item' => ['type' => 'object'],
                ],
                'additionalProperties' => false,
            ];
        }

        return [
            'type' => 'object',
            'required' => ['entity', 'operation', 'applied', 'dryRun'],
            'properties' => [
                'entity' => ['const' => $this->entity->id],
                'operation' => ['const' => $this->operation],
                'applied' => ['type' => 'boolean'],
                'dryRun' => ['type' => 'boolean'],
                'id' => ['type' => ['integer', 'null']],
                'fields' => ['type' => 'array', 'items' => ['type' => 'string']],
                'requiresEdgeConfirmation' => ['type' => 'boolean'],
                'state' => ['type' => 'integer'],
                'item' => ['type' => ['object', 'null']],
            ],
            'additionalProperties' => false,
        ];
    }
}
