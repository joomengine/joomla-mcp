import type {
  CrudOperationDescriptor,
  JoomlaAclMetadata,
  JoomlaApiDriverMetadata,
  JoomlaSourceReference,
  JoomlaVersionMetadata,
} from '../contracts/action-catalog.js';

export const joomla6xVersions: JoomlaVersionMetadata = Object.freeze({
  baseline: '6.1-dev',
  compatible: '6.2-dev',
  canary: '7.0-dev',
  minimum: '6.1.0',
  maximumExclusive: '8.0.0',
  examinedHeads: Object.freeze({
    '6.1-dev': '071afb7ad305c02983a653ccfc301b5c8360264b',
    '6.2-dev': 'df0e57da1cf3febfd8d4da0c522b87f3d5c6aec5',
    '7.0-dev': 'b3a08ce4cbca0c77ff34c9b1abe1c431536dbb3f',
  }),
});

const READ_HINTS = Object.freeze(['core.manage']);

export function acl(component: `com_${string}`, resourceScoped = true): JoomlaAclMetadata {
  return Object.freeze({
    apiLogin: 'core.login.api',
    component,
    enforcement: 'joomla-controller',
    resourceScoped,
    actionHints: Object.freeze({
      read: READ_HINTS,
      list: READ_HINTS,
      get: READ_HINTS,
      create: Object.freeze(['core.create']),
      update: Object.freeze(['core.edit', 'core.edit.own']),
      delete: Object.freeze(['core.delete']),
    }),
  });
}

export function apiDriver(
  plugin: `webservices/${string}`,
  authentication: JoomlaApiDriverMetadata['authentication'] = 'joomla-api-token',
  responseShape: JoomlaApiDriverMetadata['responseShape'] = 'json-api',
): JoomlaApiDriverMetadata {
  return Object.freeze({
    kind: 'joomla-api',
    transport: 'https',
    authentication,
    plugin,
    responseShape,
    mutationBody: 'flat-joomla-form-json',
  });
}

export function source(
  plugin: string,
  className: string,
  registration: JoomlaSourceReference['registration'],
): JoomlaSourceReference {
  return Object.freeze({
    repository: 'joomla/joomla-cms',
    branch: '6.1-dev',
    commit: '071afb7ad305c02983a653ccfc301b5c8360264b',
    path: `plugins/webservices/${plugin}/src/Extension/${className}.php`,
    registration,
  });
}

export function crudOperations(mutationPhase: 4 | 6): readonly CrudOperationDescriptor[] {
  return Object.freeze([
    Object.freeze({ name: 'list', method: 'GET', route: 'collection', risk: 'read', deliveryPhase: 2 }),
    Object.freeze({ name: 'get', method: 'GET', route: 'item', risk: 'read', deliveryPhase: 2 }),
    Object.freeze({ name: 'create', method: 'POST', route: 'collection', risk: 'write', deliveryPhase: mutationPhase }),
    Object.freeze({ name: 'update', method: 'PATCH', route: 'item', risk: 'write', deliveryPhase: mutationPhase }),
    Object.freeze({ name: 'delete', method: 'DELETE', route: 'item', risk: 'destructive', deliveryPhase: mutationPhase }),
  ] satisfies CrudOperationDescriptor[]);
}

export function versionSupportFor(version: string): 'supported' | 'canary' | 'unsupported' {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(version);

  if (match === null) {
    return 'unsupported';
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (major === 6 && (minor === 1 || minor === 2)) {
    return 'supported';
  }

  if (major === 7 && minor === 0) {
    return 'canary';
  }

  return 'unsupported';
}
