<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Domain;

/** Complete omitted native field-create form values without replacing explicit data. */
final class FieldCreateDefaults
{
    /** Joomla 6.1.4 administrator/components/com_fields/forms/field.xml defaults. */
    private const PARAMS = ['show_on' => '', 'showlabel' => '1', 'display' => '2', 'display_readonly' => '2', 'searchindex' => '0'];

    /**
     * Empty parameter groups disappear during native form filtering, so an
     * omitted params value needs the real form defaults for its non-null column.
     *
     * @param array<string, mixed> $data Validated native create data.
     * @return array<string, mixed> Completed detached form values.
     */
    public static function complete(array $data): array
    {
        return $data + ['default_value' => '', 'description' => '', 'params' => self::PARAMS];
    }
}
