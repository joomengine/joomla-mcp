<?php

declare(strict_types=1);

/**
 * Generate the reviewed Node catalogue from JCB's literal route declarations,
 * native controllers, edit models and XML forms. Upstream PHP is read as text.
 * Usage: php scripts/jcb/generate-api-catalog.php <joomla-checkout> <plugins-checkout>
 */
const JCB_REVISION = 'aea703fc11d551d6847f3142ca74357cb73c23fe';
const PLUGINS_REVISION = '33df9f3afd1f87b94151b8c824654e00557c3258';
const SOURCE_DIGEST = '55182f3283e55ff14a966aae391e9d3866d3365ea7ec1d2db5004f55b1020d7b';
const ROUTER = 'plg_webservices_componentbuilderapiroutes/src/Extension/ComponentbuilderApiRoutes.php';

function readSource(string $path): string
{
    global $sourceHashes, $argv;
    $source = file_get_contents($path);
    if ($source === false) {
        throw new RuntimeException("Missing source: $path");
    }
    $componentPrefix = rtrim($argv[1], '/') . '/';
    $pluginPrefix = rtrim($argv[2], '/') . '/';
    $relative = str_starts_with($path, $componentPrefix)
        ? 'joomla/' . ltrim(substr($path, strlen($componentPrefix)), '/')
        : 'plugins/' . ltrim(substr($path, strlen($pluginPrefix)), '/');
    $sourceHashes[$relative] = hash('sha256', $source);
    return $source;
}

function truth(string $value): bool
{
    return in_array(strtolower($value), ['1', 'true', 'yes', 'required'], true);
}

/** Only literal PHP arrays, strings, integers and booleans are accepted. */
function literal(array $tokens, int &$i): mixed
{
    $token = $tokens[$i++] ?? null;
    if (is_array($token)) {
        return match ($token[0]) {
            T_CONSTANT_ENCAPSED_STRING => preg_replace("~\\\\(['\\\\\\\\])~", '$1', substr($token[1], 1, -1)),
            T_LNUMBER => intval($token[1]),
            T_STRING => match ($token[1]) { 'true' => true, 'false' => false, default => throw new RuntimeException('Unknown literal.') },
            default => throw new RuntimeException('Unexpected conditional-requirement token.')
        };
    }
    if ($token !== '[') {
        throw new RuntimeException('Expected literal array.');
    }
    $array = [];
    while (($tokens[$i] ?? null) !== ']') {
        $value = literal($tokens, $i);
        if (($tokens[$i][0] ?? null) === T_DOUBLE_ARROW) {
            $i++;
            $array[$value] = literal($tokens, $i);
        } else {
            $array[] = $value;
        }
        if (($tokens[$i] ?? null) === ',') {
            $i++;
        } elseif (($tokens[$i] ?? null) !== ']') {
            throw new RuntimeException('Invalid literal array separator.');
        }
    }
    $i++;
    return $array;
}

function conditions(string $model): array
{
    if (!preg_match('/protected\s+\$conditionalRequirements\s*=\s*(\[.*?\]);/s', $model, $m)) {
        return [];
    }
    $tokens = array_values(array_filter(token_get_all('<?php ' . $m[1]), static fn ($token) =>
        !is_array($token) || !in_array($token[0], [T_OPEN_TAG, T_WHITESPACE, T_COMMENT], true)));
    $i = 0;
    $result = literal($tokens, $i);
    if ($i !== count($tokens) || !is_array($result)) {
        throw new RuntimeException('Unexpected conditional policy expression.');
    }
    return $result;
}

/** Return the named controls in one form, preserving group and subform boundaries. */
function fields(SimpleXMLElement $node): array
{
    $fields = [];
    foreach ($node->children() as $element) {
        $tag = $element->getName();
        $name = (string) $element['name'];
        if ($tag === 'fieldset') {
            $children = fields($element);
            if (array_intersect_key($fields, $children)) {
                throw new RuntimeException("Duplicate field in $name.");
            }
            $fields += $children;
            continue;
        }
        if (!in_array($tag, ['field', 'fields'], true)) {
            continue;
        }
        if (!preg_match('/^[a-zA-Z][a-zA-Z0-9_]*$/D', $name) || isset($fields[$name])) {
            throw new RuntimeException("Unexpected or duplicate field: $name");
        }
        if ($tag === 'fields') {
            $fields[$name] = ['type' => 'group', 'fields' => (object) fields($element)];
            continue;
        }
        $field = ['type' => strtolower((string) $element['type'])];
        foreach (['required', 'readonly', 'disabled', 'multiple'] as $attribute) {
            if (truth((string) $element[$attribute])) {
                $field[$attribute] = true;
            }
        }
        foreach (['filter', 'default', 'showon', 'validate', 'data-key-name', 'maxlength', 'min', 'max'] as $attribute) {
            if (isset($element[$attribute])) {
                $field[$attribute === 'data-key-name' ? 'relationshipKey' : $attribute] = (string) $element[$attribute];
            }
        }
        $options = $element->xpath('./option | ./group/option');
        if ($options) {
            $field['options'] = array_values(array_unique(array_map(static fn ($option) => (string) $option['value'], $options)));
        }
        if (in_array($field['type'], ['note', 'spacer', 'rules'], true) || $name === 'not_required' || strtolower($field['filter'] ?? '') === 'unset') {
            $field['requestOnly'] = true;
        }
        if ($field['type'] === 'subform') {
            if (!isset($element->form) || isset($element['formsource'])) {
                throw new RuntimeException("Review the native subform binding for $name.");
            }
            $field['fields'] = (object) fields($element->form);
            if (truth((string) $element->form['repeat'])) {
                $field['multiple'] = true;
            }
        }
        $fields[$name] = $field;
    }
    return $fields;
}

/** Keep individual field declarations on a line where possible for readable diffs. */
function renderJson(mixed $value, int $depth = 0): string
{
    $compact = json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    if (strlen($compact) <= 180 || is_scalar($value)) {
        return $compact;
    }
    $object = is_object($value) || !array_is_list($value);
    $indent = str_repeat('  ', $depth);
    $parts = [];
    foreach ((array) $value as $key => $item) {
        $label = $object ? json_encode((string) $key, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . ': ' : '';
        $parts[] = $indent . '  ' . $label . renderJson($item, $depth + 1);
    }
    return ($object ? '{' : '[') . "\n" . implode(",\n", $parts) . "\n" . $indent . ($object ? '}' : ']');
}

function resource(string $root, string $list, ?string $item): array
{
    $listSource = readSource($root . '/api/src/Controller/' . ucfirst($list) . 'Controller.php');
    preg_match_all('/\$filters\[\x27(\w+)\x27\]/', $listSource, $filters);
    preg_match('/\$ordering\s*=\s*\[(.*?)\];/s', $listSource, $order);
    preg_match_all('/\x27(\w+)\x27\s*=>/', $order[1] ?? '', $columns);
    $data = ['listController' => $list, 'filters' => array_values(array_unique($filters[1])),
        'ordering' => $columns[1], 'paginated' => !str_contains($listSource, 'does not paginate')];
    if ($item === null) {
        return $data;
    }
    $itemSource = readSource($root . '/api/src/Controller/' . ucfirst($item) . 'Controller.php');
    if (!preg_match('/\$name = \x27(\w+)\x27;/', $itemSource, $binding)) {
        throw new RuntimeException("Missing explicit edit model for $item.");
    }
    $model = readSource($root . '/admin/src/Model/' . ucfirst($binding[1]) . 'Model.php');
    if (!preg_match('/\$this->loadForm\(\x27com_componentbuilder\.\w+\x27, \x27(\w+)\x27,/', $model, $form)) {
        throw new RuntimeException("Missing explicit edit form for $item.");
    }
    $xml = simplexml_load_string(readSource($root . '/admin/forms/' . $form[1] . '.xml'), options: LIBXML_NONET);
    if (!$xml instanceof SimpleXMLElement) {
        throw new RuntimeException("Invalid XML in form $form[1].");
    }
    $controls = fields($xml);
    if (isset($controls['guid']) && preg_match('/\$data\[\x27guid\x27\]\s*=\s*(?:\(string\)\s*)?GuidHelper::get\(\)/', $model)) {
        $controls['guid']['serverGenerated'] = true;
    }
    if ($item === 'language_translation' && ($controls['source']['disabled'] ?? false)
        && !preg_match('/setFieldAttribute\(\x27source\x27,\s*\x27disabled\x27,\s*(?:false|\x27false\x27)/', $model)) {
        $data['sourceCreateDisabled'] = true;
    }
    $data['model'] = $binding[1];
    $data['form'] = $form[1];
    $data['fields'] = (object) $controls;
    $data['conditionGroups'] = conditions($model);
    $data['dynamicRequired'] = $data['conditionGroups'] !== [] || preg_match('/setFieldAttribute\([^,]+,\s*\x27required\x27/', $model) === 1;
    return $data;
}

if ($argc !== 3) {
    fwrite(STDERR, "Pass local checkouts of extension-builder/joomla and extension-builder/plugins.\n");
    exit(2);
}
$sourceHashes = [];
$router = readSource($argv[2] . '/' . ROUTER);
$routes = [];
$resources = [];
$lists = [];
$items = [];
$reviewed = ['GET' => ['displayList', 'displayItem'], 'POST' => ['add'], 'PATCH' => ['edit'], 'DELETE' => ['delete']];
foreach (explode("\n", $router) as $line) {
    if (!str_contains($line, 'new \\Joomla\\Router\\Route(')) {
        continue;
    }
    if (!preg_match('~Route\(\[\x27([A-Z]+)\x27\], \x27(v1/componentbuilder/(\w+)(/[^\x27]+)?)\x27, \x27(\w+)\.(\w+)\x27, (.*), (\$\w+)\),\s*$~', $line, $matches)) {
        throw new RuntimeException('Review the changed route syntax: ' . $line);
    }
    [, $method, $path, $collection, $suffix, $controller, $task, $rules, $defaults] = $matches;
    $expectedRule = match ($suffix) {
        '' => '[]', '/:id' => "['id' => '(\\d+)']", '/guid/:guid' => "['guid' => '([0-9a-fA-F-]{36})']",
        default => throw new RuntimeException("Review the route identifier for $path."),
    };
    if (!in_array($task, $reviewed[$method] ?? [], true) || $rules !== $expectedRule
        || $defaults !== ($method === 'GET' ? '$getDefaults' : '$defaults') || isset($routes["$method $path"])) {
        throw new RuntimeException("Unreviewed route contract: $method $path");
    }
    $routes["$method $path"] = "$controller.$task";
    if ($task === 'displayList') {
        $lists[$collection] = $controller;
    }
    if ($task === 'add') {
        $items[$collection] = $controller;
    }
}
if (count($routes) !== 320 || count($lists) !== 53 || count($items) !== 51) {
    throw new RuntimeException('Route coverage changed. Review new methods and resources before regenerating.');
}
foreach ($lists as $collection => $controller) {
    $resources[$collection] = resource($argv[1], $controller, $items[$collection] ?? null);
}
ksort($sourceHashes, SORT_STRING);
$digest = hash_init('sha256');
foreach ($sourceHashes as $relative => $fileDigest) {
    hash_update($digest, $fileDigest . '  ' . $relative . "\n");
}
$actualDigest = hash_final($digest);
if ($actualDigest !== SOURCE_DIGEST) {
    throw new RuntimeException("JCB source changed ($actualDigest). Review the upstream changes and update both revisions and digest.");
}
$catalog = ['componentRevision' => JCB_REVISION, 'pluginsRevision' => PLUGINS_REVISION,
    'sourceDigest' => $actualDigest, 'router' => ROUTER, 'routes' => $routes, 'resources' => $resources];
$output = __DIR__ . '/../../src/jcb/api-catalog.json';
file_put_contents($output, renderJson($catalog) . "\n");
