<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

use InvalidArgumentException;

final readonly class CoreEntityDefinition
{
    /**
     * @param list<string>                   $readFields
     * @param list<string>                   $writeFields
     * @param array<string, scalar|array>    $defaults
     * @param array<string, scalar|array>    $modelState
     * @param list<string>                   $sensitiveFields
     */
    public function __construct(
        public string $id,
        public string $label,
        public string $component,
        public string $listModel,
        public string $itemModel,
        public array $readFields,
        public array $writeFields,
        public array $defaults = [],
        public array $modelState = [],
        public string $stateFilter = 'filter.published',
        public bool $supportsState = true,
        public bool $highRisk = false,
        public array $sensitiveFields = [],
        public string $primaryKey = 'id',
        public string $stateField = 'published',
    ) {
        if (!preg_match('/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/', $id)) {
            throw new InvalidArgumentException(sprintf('Invalid core entity id "%s".', $id));
        }

        if (!preg_match('/^com_[a-z0-9_]+$/', $component)) {
            throw new InvalidArgumentException(sprintf('Invalid core component "%s".', $component));
        }

        if ($readFields === [] || $writeFields === []) {
            throw new InvalidArgumentException(sprintf('Entity "%s" must declare explicit fields.', $id));
        }

        if (array_diff($sensitiveFields, $writeFields) !== []) {
            throw new InvalidArgumentException(sprintf('Entity "%s" has an unknown sensitive field.', $id));
        }

        if (!preg_match('/^[a-z][a-z0-9_]*$/', $primaryKey)) {
            throw new InvalidArgumentException(sprintf('Entity "%s" has an invalid primary key.', $id));
        }

        if ($supportsState && !in_array($stateField, $readFields, true)) {
            throw new InvalidArgumentException(sprintf('Entity "%s" has no readable state field "%s".', $id, $stateField));
        }
    }

    public function actionName(string $operation): string
    {
        return $this->id . '.' . $operation;
    }

    public function itemAsset(int $id): string
    {
        return $this->component . '.' . strtolower($this->itemModel) . '.' . $id;
    }
}
