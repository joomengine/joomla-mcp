<?php

use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;

test('native article authoring and module publishing fields survive save and read-back', static function (): void {
    $cases = [
        'content.articles' => ['created' => '2026-11-09 08:30:00', 'created_by' => 42],
        'modules.site' => ['publish_up' => '2026-11-09 08:30:00', 'publish_down' => '2026-11-16 08:30:00'],
        'modules.administrator' => ['publish_up' => '2026-11-09 08:30:00', 'publish_down' => null],
    ];
    foreach ($cases as $base => $data) {
        $entity = array_values(array_filter(CoreEntityCatalogue::all(), static fn ($candidate): bool => $candidate->id === $base))[0];
        $model = new class {
            public array $stored = ['id' => 41, 'title' => 'Existing'];
            public array $saved = [];
            public function setState(string $key, mixed $value): void {}
            public function getState(string $key, int $default = 0): int { return 41; }
            public function getItem(int $id): object { return (object) $this->stored; }
            public function save(array $data): bool
            {
                $this->saved = $data;
                $this->stored = ['id' => 41] + $data;
                return true;
            }
        };
        $models = new class ($model) implements ModelProviderInterface {
            public function __construct(private object $model) {}
            public function administrator(string $component, string $modelName): object { return $this->model; }
        };
        foreach (['create', 'update'] as $operation) {
            $action = new CoreEntityAction($entity, $operation, $models);
            $input = ['data' => ['title' => 'Scheduled content'] + $data];
            if ($operation === 'update') $input['id'] = 41;
            expect($action->execute($input)['dryRun'] === true, 'Publishing writes must preview by default.');
            $result = $action->execute($input + ['dryRun' => false, '_edgeConfirmed' => true]);
            expect(array_intersect_key($model->saved, $data) === $data, 'Publishing input was lost before native save.');
            expect(array_intersect_key($result['item'], $data) === $data, 'Publishing output was lost after native save.');
            $read = (new CoreEntityAction($entity, 'get', $models))->execute(['id' => 41]);
            expect(array_intersect_key($read['item'], $data) === $data, 'Independent read omitted publishing fields.');
        }
    }
});
