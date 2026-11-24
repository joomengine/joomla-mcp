<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Jcb;

use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Domain\Input;

final class CommandOptions
{
    private const GUID = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
    private const ENUMS = [
        'add-placeholders' => ['0', '1', '2'], 'debug-line-nr' => ['0', '1', '2'],
        'minify' => ['0', '1', '2'], 'powers' => ['0', '1', '2'],
        'joomla-version' => ['3', '4', '5', '6'], 'indentation-value' => ['1', '2', '4'],
        'add-build-date' => ['1', '2', '3'],
    ];

    /** Restrict public options to typed forms present in the native command definition. */
    public static function properties(object $definition, bool $compiler): array
    {
        $candidates = $compiler
            ? ['component', 'components', ...array_keys(self::ENUMS), 'build-date', 'options']
            : ['items', 'repo', 'force', 'resolve'];
        $properties = [];
        foreach ($definition->getArguments() as $argument) {
            if ($argument->getName() !== 'command') {
                return [];
            }
        }
        foreach ($candidates as $name) {
            if (!$definition->hasOption($name)) {
                continue;
            }
            $mode = $definition->getOption($name);
            $flag = in_array($name, ['force', 'resolve'], true);
            if ($mode->isArray() || $mode->acceptValue() === $flag) {
                return [];
            }
            $properties[$name] = match (true) {
                $flag => ['type' => 'boolean'],
                $name === 'component', $name === 'repo' => ['type' => 'string', 'pattern' => '^' . self::GUID . '$'],
                isset(self::ENUMS[$name]) => ['type' => 'string', 'enum' => self::ENUMS[$name]],
                $name === 'options' => ['type' => 'string', 'maxLength' => 4096,
                    'description' => 'Inline JSON object of the supported compiler settings. Explicit CLI options win.'],
                $name === 'build-date' => ['type' => 'string', 'pattern' => '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'],
                default => ['type' => 'string', 'minLength' => 1, 'maxLength' => 32768,
                    'description' => 'Explicit selectors as CSV, newlines or a JSON list. File references are unavailable.'],
            };
        }

        return isset($properties[$compiler ? 'components' : 'items']) ? $properties : [];
    }

    /** Canonicalize only inline selections. Native commands may otherwise interpret strings as server files. */
    public static function normalize(mixed $raw, array $properties, string $verb): array
    {
        $options = $raw instanceof \stdClass ? get_object_vars($raw) : $raw;
        if (!is_array($options) || $options === [] || array_is_list($options)) {
            throw new ActionException('INVALID_INPUT', 'JCB command options must be a nonempty object.');
        }
        Input::rejectUnknown($options, array_keys($properties));
        if (array_key_exists('options', $options)) {
            $bundle = $options['options'];
            $bundle = is_string($bundle) && strlen($bundle) <= 4096 ? json_decode($bundle, false, 4) : null;
            if (!$bundle instanceof \stdClass) {
                throw new ActionException('INVALID_INPUT', 'A compiler option bundle must be an inline JSON object.');
            }
            $settings = [];
            foreach ($bundle as $name => $value) {
                $name = strtolower(str_replace('_', '-', trim($name)));
                if (!array_key_exists($name, $properties) || (!isset(self::ENUMS[$name]) && $name !== 'build-date')
                    || (!is_string($value) && !is_int($value)) || isset($settings[$name])) {
                    throw new ActionException('INVALID_INPUT', 'Unsupported or duplicate compiler bundle setting.');
                }
                $settings[$name] = (string) $value;
            }
            unset($options['options']);
            $options += $settings;
        }
        $selectors = [];
        foreach ($options as $name => $value) {
            $spec = $properties[$name];
            if ($spec['type'] === 'boolean') {
                Input::boolean($options, $name, false);
                continue;
            }
            if (!is_string($value) || $value === '' || strlen($value) > 32768 || str_contains($value, "\0")) {
                throw new ActionException('INVALID_INPUT', 'JCB option requires bounded nonempty text.');
            }
            if (isset($spec['enum']) && !in_array($value, $spec['enum'], true)) {
                throw new ActionException('INVALID_INPUT', 'Unknown JCB option value.');
            }
            if (isset($spec['pattern']) && preg_match('~' . $spec['pattern'] . '~D', $value) !== 1) {
                throw new ActionException('INVALID_INPUT', 'Malformed JCB option value.');
            }
            if ($name === 'build-date' && !checkdate((int) substr($value, 5, 2), (int) substr($value, 8, 2), (int) substr($value, 0, 4))) {
                throw new ActionException('INVALID_INPUT', 'Expected a calendar date.');
            }
            if ($name === 'component' || $name === 'components' || $name === 'items') {
                $value = trim($value);
                if ($name === 'component') {
                    $items = [$value];
                } elseif (str_starts_with($value, '{')) {
                    $object = json_decode($value, false, 4);
                    $keys = $name === 'components' ? ['components', 'items'] : ['items'];
                    $members = $object instanceof \stdClass ? get_object_vars($object) : [];
                    $items = count($members) === 1 && in_array(array_key_first($members), $keys, true)
                        ? reset($members) : null;
                } else {
                    $items = str_starts_with($value, '[') ? json_decode($value, true, 4) : preg_split('/[,\r\n]+/', $value);
                }
                if (!is_array($items) || !array_is_list($items) || $items === [] || count($items) > 500) {
                    throw new ActionException('INVALID_INPUT', 'Select between one and 500 items.');
                }
                $pattern = in_array($verb, ['compile', 'push'], true) ? self::GUID : '[a-zA-Z0-9][a-zA-Z0-9_.-]{0,190}';
                foreach ($items as $item) {
                    $item = is_int($item) || is_string($item) ? trim((string) $item) : '';
                    if (strtolower($item) === 'all' || !preg_match('~^' . $pattern . '$~D', $item)) {
                        throw new ActionException('INVALID_INPUT', 'Invalid selector for this JCB operation.');
                    }
                    $selectors[] = $item;
                }
            }
        }
        $selectors = array_values(array_unique($selectors));
        if ($selectors === [] || count($selectors) > 500) {
            throw new ActionException('INVALID_INPUT', 'Select between one and 500 items.');
        }
        unset($options['component']);
        $options[$verb === 'compile' ? 'components' : 'items'] = json_encode($selectors, JSON_THROW_ON_ERROR);
        ksort($options);
        return $options;
    }
}
