<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Joomla;

use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

/** Hidden template form values derived exclusively from installed native metadata. */
final class TemplateStyleInheritance
{
    /** @return array{parent: string, inheritable: int} */
    public static function resolve(ModelProviderInterface $models, mixed $template, int $client): array
    {
        if (!self::templateName($template) || !in_array($client, [0, 1], true)) {
            throw new ActionException('INVALID_INPUT', 'Template style creation requires a valid installed template name.');
        }
        $seen = [];
        $matches = 0;
        $inheritance = null;
        for ($page = 0; $page < 10; $page++) {
            // A fresh model avoids a cached page when its list state changes.
            $list = $models->administrator('com_templates', 'Styles');
            $list->setState('client_id', $client);
            $list->setState('list.start', $page * 100);
            $list->setState('list.limit', 100);
            $list->setState('list.ordering', 'a.id');
            $list->setState('list.direction', 'ASC');
            $items = $list->getItems();
            if (!is_array($items) || count($items) > 100) {
                throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned an invalid template style collection.');
            }
            foreach ($items as $item) {
                $item = (array) $item;
                $id = self::id($item['id'] ?? null);
                if (isset($seen[$id]) || !in_array($item['client_id'] ?? null, [$client, (string) $client], true)) {
                    throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned duplicate or incorrectly scoped template styles.');
                }
                $seen[$id] = true;
                if (($item['template'] ?? null) !== $template) {
                    continue;
                }
                if (++$matches > 20) {
                    throw new ActionException('LIMIT_EXCEEDED', 'Template inheritance discovery exceeds 20 matching styles.');
                }
                $model = $models->administrator('com_templates', 'Style');
                $source = (array) $model->getItem($id);
                if (self::id($source['id'] ?? null) !== $id || ($source['template'] ?? null) !== $template
                    || !in_array($source['client_id'] ?? null, [$client, (string) $client], true)) {
                    throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned a different template or client while resolving inheritance.');
                }
                $xml = $source['xml'] ?? null;
                if (!$xml instanceof \SimpleXMLElement || !isset($xml->name) || trim((string) $xml->name) === '') {
                    throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned missing or invalid template manifest metadata.');
                }
                if ((isset($xml['type']) && (string) $xml['type'] !== 'template')
                    || (isset($xml['client']) && (string) $xml['client'] !== ($client === 0 ? 'site' : 'administrator'))) {
                    throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned incorrectly scoped template manifest metadata.');
                }
                $parent = (string) $xml->parent;
                $raw = (string) $xml->inheritable;
                if (($parent !== '' && (!self::templateName($parent) || $parent === $template))
                    || !in_array($raw, ['', '0', '1'], true)
                    || count($xml->parent) > 1 || count($xml->inheritable) > 1
                    || count($xml->parent->children() ?? []) > 0 || count($xml->inheritable->children() ?? []) > 0
                    || count($xml->parent->attributes() ?? []) > 0 || count($xml->inheritable->attributes() ?? []) > 0) {
                    throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned invalid template inheritance metadata.');
                }
                $current = ['parent' => $parent, 'inheritable' => (int) $raw];
                if ($inheritance !== null && $inheritance !== $current) {
                    throw new ActionException('MODEL_RESULT_INVALID', 'Existing template styles have conflicting inheritance metadata.');
                }
                $inheritance = $current;
            }
            if (count($items) < 100) {
                if ($inheritance === null) {
                    throw new ActionException('NOT_FOUND', 'No existing style for this installed template and client was found; create refused.');
                }
                return $inheritance;
            }
        }
        throw new ActionException('LIMIT_EXCEEDED', 'Template inheritance discovery exceeds 10 pages; create refused.');
    }

    private static function templateName(mixed $value): bool
    {
        return is_string($value) && preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$/D', $value)
            && !str_contains($value, '..');
    }

    private static function id(mixed $value): int
    {
        if ((!is_int($value) && (!is_string($value) || !preg_match('/^[1-9][0-9]*$/D', $value)))
            || (int) $value < 1 || (string) (int) $value !== (string) $value) {
            throw new ActionException('MODEL_RESULT_INVALID', 'Joomla returned an invalid template style identifier.');
        }
        return (int) $value;
    }
}
