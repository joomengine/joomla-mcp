<?php

declare(strict_types=1);

use VDM\Plugin\Console\JoomlaMcp\Action\CoreEntityAction;
use VDM\Plugin\Console\JoomlaMcp\Contract\ModelProviderInterface;
use VDM\Plugin\Console\JoomlaMcp\Domain\ActionException;
use VDM\Plugin\Console\JoomlaMcp\Joomla\CoreEntityCatalogue;

foreach (['templates.site-styles' => 0, 'templates.administrator-styles' => 1] as $name => $client) {
    test($name . ' derives inheritance for preview and save', static function () use ($name, $client): void {
        $model = new class ($client) {
            public array $saved = [];
            public array $state = [];
            public string $manifest = '<extension><name>Child</name><parent>cassiopeia</parent></extension>';
            public function __construct(public int $client) {}
            public function setState(string $key, mixed $value): void { $this->state[$key] = $value; }
            public function getState(string $key, int $default = 0): int { return 41; }
            public function getItems(): array {
                // Native StylesModel filters by client_id, not filter.client_id.
                return [(object) ['id' => 1, 'template' => 'child', 'client_id' => $this->state['client_id'] ?? 0]];
            }
            public function getItem(int $id): object {
                return (object) ['id' => $id, 'template' => 'child', 'client_id' => $this->client,
                    'xml' => simplexml_load_string($this->manifest)];
            }
            public function save(array $data): bool { $this->saved = $data; return true; }
        };
        $provider = new class ($model) implements ModelProviderInterface {
            public function __construct(private object $model) {}
            public function administrator(string $component, string $modelName): object { return $this->model; }
        };
        $entity = null;
        foreach (CoreEntityCatalogue::all() as $candidate) {
            if ($candidate->id === $name) { $entity = $candidate; break; }
        }
        expect($entity !== null, 'Missing template style entity.');
        $action = new CoreEntityAction($entity, 'create', $provider);
        $input = ['data' => ['template' => 'child', 'title' => 'New child style']];
        $preview = $action->execute($input);
        expect($preview['item'] === ['template' => 'child', 'client_id' => $client, 'parent' => 'cassiopeia', 'inheritable' => 0], 'Missing approved inheritance.');
        expect($model->saved === [], 'Preview mutated the style.');
        expect($model->state['client_id'] === $client, 'Metadata lookup used incorrect client.');
        $action->execute($input + ['dryRun' => false, '_edgeConfirmed' => true]);
        expect($model->saved['parent'] === 'cassiopeia' && $model->saved['inheritable'] === 0, 'Native style save lost inheritance.');
        expect($model->saved['client_id'] === $client, 'Saved style used incorrect client.');
        $model->manifest = '<extension><name>Standalone</name><parent/><inheritable/></extension>';
        expect($action->execute($input)['item'] === ['template' => 'child', 'client_id' => $client, 'parent' => '', 'inheritable' => 0], 'Empty manifest defaults changed.');
        $model->manifest = '<extension><name>Parent</name><inheritable>1</inheritable></extension>';
        expect($action->execute($input)['item'] === ['template' => 'child', 'client_id' => $client, 'parent' => '', 'inheritable' => 1], 'Parent metadata changed.');
        $model->manifest = '<extension><name>Invalid</name><parent><nested/></parent></extension>';
        try {
            $action->execute($input);
            throw new RuntimeException('Nested inheritance metadata accepted.');
        } catch (ActionException $exception) {
            expect($exception->errorCode === 'MODEL_RESULT_INVALID', 'Unexpected invalid manifest error.');
        }
    });
}
