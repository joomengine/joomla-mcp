import type { Toolset } from '../config/schema.js';

export type JoomlaHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type ActionRisk = 'read' | 'sensitive-read' | 'write' | 'destructive';

export type CrudOperationName = 'list' | 'get' | 'create' | 'update' | 'delete';

export type MutationBodyPolicy = 'none' | 'optional' | 'required';

export type RouteParameterKind =
  | 'positive-integer'
  | 'component-name'
  | 'language-code'
  | 'override-constant'
  | 'adapter-id'
  | 'media-path';

export interface JoomlaSourceReference {
  readonly repository: 'joomla/joomla-cms';
  readonly branch: '6.1-dev';
  readonly commit: string;
  readonly path: `plugins/webservices/${string}/src/Extension/${string}.php`;
  readonly registration: 'createCRUDRoutes' | 'Route';
}

export interface JoomlaVersionMetadata {
  readonly baseline: '6.1-dev';
  readonly compatible: '6.2-dev';
  readonly canary: '7.0-dev';
  readonly minimum: '6.1.0';
  readonly maximumExclusive: '8.0.0';
  readonly examinedHeads: Readonly<{
    '6.1-dev': string;
    '6.2-dev': string;
    '7.0-dev': string;
  }>;
}

export interface JoomlaAclMetadata {
  /** Joomla API authentication permission checked before component ACL. */
  readonly apiLogin: 'core.login.api' | 'not-used';
  /** Component whose controller/model performs the resource ACL check. */
  readonly component: `com_${string}`;
  /** ACL actions Joomla commonly evaluates for each operation. */
  readonly actionHints: Readonly<Record<CrudOperationName | 'read', readonly string[]>>;
  readonly enforcement: 'joomla-controller';
  readonly resourceScoped: boolean;
}

export interface JoomlaApiDriverMetadata {
  readonly kind: 'joomla-api';
  readonly transport: 'https';
  readonly authentication: 'joomla-api-token' | 'joomla-update-token';
  readonly plugin: `webservices/${string}`;
  readonly responseShape: 'json-api' | 'joomla-json';
  readonly mutationBody: 'flat-joomla-form-json' | 'not-applicable';
}

export interface RouteParameterDescriptor {
  readonly name: string;
  readonly kind: RouteParameterKind;
  readonly required: true;
  readonly maximumLength?: number;
}

export interface CrudOperationDescriptor {
  readonly name: CrudOperationName;
  readonly method: JoomlaHttpMethod;
  readonly route: 'collection' | 'item';
  readonly risk: ActionRisk;
  readonly deliveryPhase: 2 | 4 | 6;
}

export interface CrudBaseDescriptor {
  readonly id: string;
  readonly domain: string;
  readonly resource: string;
  readonly collectionName: string;
  readonly itemName: string;
  readonly basePath: `v1/${string}`;
  readonly controller: string;
  readonly controllerDefaults: Readonly<Record<string, string | number>>;
  readonly toolset: Toolset;
  readonly routeParameter: RouteParameterDescriptor;
  readonly operations: readonly CrudOperationDescriptor[];
  readonly deleteSemantics: 'resource-model-defined' | 'permanent';
  readonly acl: JoomlaAclMetadata;
  readonly driver: JoomlaApiDriverMetadata;
  readonly versions: JoomlaVersionMetadata;
  readonly source: JoomlaSourceReference;
}

export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ReadActionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly operation: 'list' | 'get' | 'export' | 'healthcheck' | 'status';
  readonly method: 'GET';
  readonly routeTemplate: `v1/${string}`;
  readonly routeParameters: readonly RouteParameterDescriptor[];
  readonly paginated: boolean;
  readonly inputSchema: JsonSchema;
  readonly toolset: Toolset;
  readonly risk: 'read' | 'sensitive-read';
  /**
   * True when Joomla's GET controller updates internal bookkeeping as part of
   * the read. MCP clients must not treat such an action as side-effect free.
   */
  readonly sideEffect: boolean;
  readonly acl: JoomlaAclMetadata;
  readonly driver: JoomlaApiDriverMetadata;
  readonly versions: JoomlaVersionMetadata;
  readonly source: JoomlaSourceReference;
}

export interface WriteActionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly operation: 'create' | 'update' | 'delete';
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly routeTemplate: `v1/${string}`;
  readonly routeParameters: readonly RouteParameterDescriptor[];
  readonly bodyPolicy: MutationBodyPolicy;
  readonly inputSchema: JsonSchema;
  readonly toolset: Toolset;
  readonly risk: 'write' | 'destructive';
  readonly acl: JoomlaAclMetadata;
  readonly driver: JoomlaApiDriverMetadata;
  readonly versions: JoomlaVersionMetadata;
  readonly source: JoomlaSourceReference;
}

export type JoomlaActionDescriptor = ReadActionDescriptor | WriteActionDescriptor;

export interface ResolvedReadRequest {
  readonly method: 'GET';
  readonly path: `v1/${string}`;
  readonly query: Readonly<Record<string, string | number>>;
}

export interface ResolvedWriteRequest {
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly path: `v1/${string}`;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly etag?: string;
}
