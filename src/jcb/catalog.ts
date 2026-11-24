import data from './api-catalog.json' with { type: 'json' };
import { jcbInputSchema } from './api-input.js';

export interface JcbField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly disabled: boolean;
  readonly multiple?: boolean;
  readonly requestOnly?: boolean;
  readonly serverGenerated?: boolean;
  readonly default?: string;
  readonly showon?: string;
  readonly validate?: string;
  readonly filter?: string;
  readonly relationshipKey?: string;
  readonly maxlength?: string;
  readonly min?: string;
  readonly max?: string;
  readonly options?: readonly string[];
  readonly fields?: Readonly<Record<string, JcbField>>;
}

export interface JcbConditionGroup {
  readonly targets: readonly string[];
  readonly show: boolean;
  readonly toggle: boolean;
  readonly matches: readonly {
    readonly name: string;
    readonly behavior: number;
    readonly options: readonly string[];
    readonly user: boolean;
    readonly checkbox: boolean;
    readonly array: boolean;
    readonly supported: boolean;
  }[];
}

export interface JcbApiAction {
  readonly id: string;
  readonly resource: string;
  readonly operation: 'list' | 'get' | 'create' | 'update' | 'delete';
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly toolset: 'jcb.read' | 'jcb.write';
  readonly path: string;
  readonly controller: string;
  readonly identifier: 'id' | 'guid' | null;
  readonly paginated: boolean;
  readonly filters: readonly string[];
  readonly ordering: readonly string[];
  readonly fields: Readonly<Record<string, JcbField>>;
  readonly conditionGroups: readonly JcbConditionGroup[];
  readonly dynamicRequired: boolean;
  readonly sourceCreateDisabled?: boolean;
  readonly source: {
    readonly routeRegistration: string;
    readonly registrationFile: string;
    readonly controller: string;
    readonly form?: string;
    readonly model?: string;
  };
}

type StoredField = Omit<Partial<JcbField>, 'fields'> & {
  readonly type: string;
  readonly fields?: Readonly<Record<string, StoredField>>;
};
interface Resource {
  readonly filters: readonly string[];
  readonly ordering: readonly string[];
  readonly paginated: boolean;
  readonly fields?: Readonly<Record<string, StoredField>>;
  readonly conditionGroups?: readonly JcbConditionGroup[];
  readonly dynamicRequired?: boolean;
  readonly sourceCreateDisabled?: boolean;
  readonly model?: string;
  readonly form?: string;
}

const resources: Readonly<Record<string, Resource>> = data.resources;
const operations: Readonly<Record<string, JcbApiAction['operation']>> = {
  displayList: 'list', displayItem: 'get', add: 'create', edit: 'update', delete: 'delete',
};
const componentSource = 'https://github.com/vdm-io/Joomla-Component-Builder/blob/' + data.componentRevision + '/';
const routeRegistration = 'https://github.com/joomengine/pkg-component-builder/blob/' + data.packageRevision
  + '/src/joomla__plg_webservices_componentbuilderapiroutes__6.x.zip';

function normalizeFields(fields: Readonly<Record<string, StoredField>>): Readonly<Record<string, JcbField>> {
  return Object.fromEntries(Object.entries(fields).map(([name, raw]) => {
    const {fields: nestedFields, ...attributes} = raw;
    const field: JcbField = {
      name, required: false, readonly: false, disabled: false,
      ...attributes,
      ...(nestedFields && {fields: normalizeFields(nestedFields)}),
    };
    return [name, field];
  }));
}

function immutable<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

const fieldsByResource = new Map(
  Object.entries(resources).map(([name, resource]) => [name, normalizeFields(resource.fields ?? {})]),
);
const actions: JcbApiAction[] = [];
for (const [route, controller] of Object.entries(data.routes)) {
  const [method, path] = route.split(' ');
  const [controllerName, task] = controller.split('.');
  const resource = path?.split('/')[2];
  const metadata = resource && resources[resource];
  const operation = task && operations[task];
  if (!path || !resource || !metadata || !operation || !controllerName
      || (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE')) {
    throw new Error('Invalid generated JCB registration: ' + route);
  }
  const identifier = path.endsWith('/:id') ? 'id' : path.endsWith('/:guid') ? 'guid' : null;
  const source = {
    routeRegistration,
    registrationFile: data.router,
    controller: componentSource + 'api/src/Controller/' + controllerName[0]!.toUpperCase() + controllerName.slice(1) + 'Controller.php',
    ...(metadata.form && {form: componentSource + 'admin/forms/' + metadata.form + '.xml'}),
    ...(metadata.model && {model: componentSource + 'admin/src/Model/' + metadata.model[0]!.toUpperCase() + metadata.model.slice(1) + 'Model.php'}),
  };
  actions.push({
    id: 'jcb.api.' + resource + '.' + operation + (identifier === 'guid' ? '.guid' : ''),
    resource, operation, method, path, controller, identifier, source,
    toolset: method === 'GET' ? 'jcb.read' : 'jcb.write',
    paginated: operation === 'list' && metadata.paginated,
    filters: operation === 'list' ? metadata.filters : [],
    ordering: operation === 'list' ? metadata.ordering : [],
    fields: fieldsByResource.get(resource)!,
    conditionGroups: metadata.conditionGroups ?? [],
    dynamicRequired: metadata.dynamicRequired ?? false,
    ...(metadata.sourceCreateDisabled && {sourceCreateDisabled: true}),
  });
}

export const jcbApiActions: readonly JcbApiAction[] = immutable(actions);
const byId = new Map(jcbApiActions.map(action => [action.id, action]));
if (byId.size !== jcbApiActions.length) throw new Error('Duplicate generated JCB action ID.');

export function getJcbApiAction(id: string): JcbApiAction | undefined {
  return byId.get(id);
}

export function describeJcbApiAction(action: JcbApiAction) {
  return {...action, inputSchema: jcbInputSchema(action)};
}

/** Public source metadata. Use site-scoped discovery for installed routes and actor permissions. */
export function publicJcbCatalog() {
  const families = new Map<string, string[]>();
  for (const action of jcbApiActions) {
    const actions = families.get(action.resource);
    if (actions) actions.push(action.id);
    else families.set(action.resource, [action.id]);
  }
  return {
    component: 'com_componentbuilder',
    routeCount: jcbApiActions.length,
    resources: Object.fromEntries(families),
    discoveryDomain: 'jcb',
    toolsets: ['jcb.read', 'jcb.write', 'jcb.execute'],
  };
}

export { getJcbParentBinding } from './parent-binding.js';
