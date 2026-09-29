<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Joomla;

use Joomla\Component\Installer\Administrator\Model\InstallerModel;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;

/** Preserve exact zero-based slices across Joomla administrator pagination. */
final class ModelListPage
{
    /** @return array{items: array, total: int} */
    public static function read(object $model, int $offset, int $limit, string $getter = 'getItems'): array
    {
        if (!method_exists($model, 'setState') || !method_exists($model, $getter)) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla model cannot provide a bounded list.');
        }

        if ($getter === 'getData' || $model instanceof InstallerModel) {
            // CacheModel's first getData() slices its cached full collection;
            // getTotal() can then count only that slice. InstallerModel filters
            // translated metadata in getItems(), after the base SQL total.
            // Both native models already load the whole collection internally.
            $model->setState('list.start', 0);
            $model->setState('list.limit', 0);
            $items = $model->{$getter}();
            self::requireItems($items);

            return ['items' => array_slice($items, $offset, $limit), 'total' => count($items)];
        }

        if (!method_exists($model, 'getTotal')) {
            throw new ActionException('MODEL_INCOMPATIBLE', 'The Joomla model cannot report its list total.');
        }

        $model->setState('list.start', $offset);
        $model->setState('list.limit', $limit);
        $total = $model->getTotal();

        if (!is_int($total) || $total < 0) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla model returned an invalid list total.');
        }

        if ($offset >= $total) {
            return ['items' => [], 'total' => $total];
        }

        // ListModel::getStart() rewinds partial tail pages unless the native
        // limit fits the remaining rows. Public page.limit stays requested.
        $nativeLimit = min($limit, $total - $offset);
        $model->setState('list.limit', $nativeLimit);
        $items = $model->getItems();
        self::requireItems($items);

        if (count($items) > $nativeLimit) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla model returned more rows than its bounded list permits.');
        }

        return ['items' => $items, 'total' => $total];
    }

    private static function requireItems(mixed $items): void
    {
        if (!is_array($items)) {
            throw new ActionException('MODEL_RESULT_INVALID', 'The Joomla model returned an invalid list.');
        }
    }
}
