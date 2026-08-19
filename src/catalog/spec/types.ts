import type { Toolset } from '../../config/schema.js';
import type {
  CrudBaseDescriptor,
  JoomlaActionDescriptor,
  ReadActionDescriptor,
  WriteActionDescriptor,
} from '../../contracts/action-catalog.js';

/**
 * Types matching joomla-mcp-spec action-descriptor JSON, family documents,
 * catalogue meta, toolsets, write-field allowlists, gates, and the public MCP
 * tool contract. These are the language-neutral shapes both implementations
 * consume; they are not the runtime descriptor types in contracts/action-catalog.
 */

export const SPEC_CATALOG_ENV = 'JOOMLA_MCP_SPEC';

export const SPEC_REQUIRED_DOCUMENTS = Object.freeze([
  'catalog/meta.json',
  'catalog/toolsets.json',
  'catalog/write-fields.json',
] as const);

export const SPEC_ACTIONS_DIRECTORY = 'catalog/actions';
export const SPEC_GATES_DOCUMENT = 'catalog/gates.json';
export const SPEC_PUBLIC_TOOLS_DOCUMENT = 'contracts/mcp-public-tools.json';

export type SpecOperation =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'export'
  | 'healthcheck'
  | 'status'
  | 'state'
  | 'run';

export type SpecHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type SpecRisk = 'read' | 'sensitive-read' | 'write' | 'destructive';

export type SpecBodyPolicy = 'none' | 'optional' | 'required';

export type SpecDeleteSemantics = 'resource-model-defined' | 'permanent';

export type SpecRouteParameterKind =
  | 'positive-integer'
  | 'component-name'
  | 'language-code'
  | 'override-constant'
  | 'adapter-id'
  | 'media-path';

export type SpecDriverKind = 'joomla-api' | 'joomla-companion';

export type SpecTransport = 'https' | 'stdio-cli';

export type SpecAuthentication = 'joomla-api-token' | 'joomla-update-token' | 'process-identity';

export type SpecResponseShape = 'json-api' | 'joomla-json';

export type SpecMutationBody = 'flat-joomla-form-json' | 'not-applicable';

export type SpecSourceRegistration = 'createCRUDRoutes' | 'Route' | 'native-model';

export type SpecJsonSchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

export type SpecPublicToolCategory = 'discovery' | 'read' | 'write' | 'security';

export type SpecCatalogStatus = 'extracting' | 'stable' | 'deprecated';

export type SpecGateSeverity = 'source-only' | 'restricted' | 'informational';

export interface SpecJsonSchema {
  readonly $comment?: string;
  readonly $id?: string;
  readonly $schema?: string;
  readonly type?: SpecJsonSchemaType | readonly SpecJsonSchemaType[];
  readonly properties?: Readonly<Record<string, SpecJsonSchema>>;
  readonly items?: SpecJsonSchema | readonly SpecJsonSchema[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | SpecJsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly oneOf?: readonly SpecJsonSchema[];
  readonly anyOf?: readonly SpecJsonSchema[];
  readonly allOf?: readonly SpecJsonSchema[];
  readonly not?: SpecJsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number | boolean;
  readonly exclusiveMaximum?: number | boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: unknown;
  readonly description?: string;
  readonly title?: string;
  readonly writeOnly?: boolean;
  readonly readOnly?: boolean;
  readonly nullable?: boolean;
}

export interface SpecRouteParameter {
  readonly name: string;
  readonly kind: SpecRouteParameterKind;
  readonly required: boolean;
  readonly maximumLength?: number;
}

export interface SpecDriver {
  readonly kind: SpecDriverKind;
  readonly transport?: SpecTransport;
  readonly authentication?: SpecAuthentication;
  readonly plugin?: string;
  readonly responseShape?: SpecResponseShape;
  readonly mutationBody?: SpecMutationBody;
}

export interface SpecSourceReference {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly path: string;
  readonly registration?: SpecSourceRegistration;
}

export interface SpecActionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly operation: SpecOperation;
  readonly method: SpecHttpMethod;
  readonly routeTemplate: string;
  readonly routeParameters?: readonly SpecRouteParameter[];
  readonly paginated?: boolean;
  readonly bodyPolicy?: SpecBodyPolicy;
  readonly sideEffect?: boolean;
  readonly toolset: string;
  readonly risk: SpecRisk;
  readonly inputSchema: SpecJsonSchema;
  readonly writeFields?: readonly string[];
  readonly deleteSemantics?: SpecDeleteSemantics;
  readonly driver?: SpecDriver;
  readonly component?: string;
  readonly source?: SpecSourceReference;
  readonly gate?: string;
  readonly controllerDefaults?: Readonly<Record<string, string | number>>;
}

export interface SpecFamilyBase {
  readonly id: string;
  readonly domain: string;
  readonly resource: string;
  readonly collectionName: string;
  readonly itemName: string;
  readonly basePath: string;
  readonly controller: string;
  readonly component: string;
  readonly toolsetRead: string;
  readonly toolsetWrite: string;
  readonly deleteSemantics?: SpecDeleteSemantics;
  readonly driver: SpecDriver;
  readonly source: SpecSourceReference;
  readonly defaults?: Readonly<Record<string, string | number>>;
  readonly controllerDefaults?: Readonly<Record<string, string | number>>;
}

export interface SpecFamilyDocument {
  readonly $comment?: string;
  readonly base: SpecFamilyBase;
  readonly actions: readonly SpecActionDescriptor[];
}

export interface SpecJoomlaBaselines {
  readonly implementation: string;
  readonly compatibilityTarget: string;
  readonly canary: string;
}

export interface SpecExaminedHeads {
  readonly '6.1-dev': string;
  readonly '6.2-dev': string;
  readonly '7.0-dev': string;
}

export interface SpecMetaDocument {
  readonly specVersion: string;
  readonly name: string;
  readonly description: string;
  readonly joomlaBaselines: SpecJoomlaBaselines;
  readonly examinedHeads: SpecExaminedHeads;
  readonly consumers: readonly string[];
  readonly status: string;
  readonly extractedFamilies: readonly string[];
  readonly notes?: readonly string[];
}

export interface SpecToolsetEntry {
  readonly id: string;
  readonly description: string;
  readonly write: boolean;
}

export interface SpecToolsetsDocument {
  readonly $schema?: string;
  readonly description?: string;
  readonly toolsets: readonly SpecToolsetEntry[];
}

export interface SpecWriteFieldAllowlist {
  readonly fields: readonly string[];
  readonly sensitive: readonly string[];
}

export interface SpecWriteFieldsDocument {
  readonly $comment?: string;
  readonly bases: Readonly<Record<string, SpecWriteFieldAllowlist>>;
}

export interface SpecGateEntry {
  readonly id: string;
  readonly reason: string;
  readonly severity: SpecGateSeverity;
}

export interface SpecGatesDocument {
  readonly $comment?: string;
  readonly gates: readonly SpecGateEntry[];
}

export interface SpecPublicTool {
  readonly name: string;
  readonly category: SpecPublicToolCategory;
  readonly write: boolean;
}

export interface SpecPublicToolsDocument {
  readonly description: string;
  readonly tools: readonly SpecPublicTool[];
  readonly notes?: readonly string[];
}

export interface SpecCatalogOptions {
  /** Absolute or relative path to a joomla-mcp-spec checkout. */
  readonly specRoot?: string;
  /**
   * When true, skip installing the overlay into the runtime catalogue. Tests
   * use this to load and map a fixture without changing process-wide lookups.
   */
  readonly installOverlay?: boolean;
}

export interface LoadedSpecFamily {
  readonly relativePath: string;
  readonly document: SpecFamilyDocument;
}

export interface LoadedSpecCatalog {
  readonly specRoot: string;
  readonly meta: SpecMetaDocument;
  readonly toolsets: SpecToolsetsDocument;
  readonly writeFields: SpecWriteFieldsDocument;
  readonly gates: SpecGatesDocument;
  readonly families: readonly LoadedSpecFamily[];
  readonly publicTools?: SpecPublicToolsDocument;
}

export interface MappedSpecFamily {
  readonly familyId: string;
  readonly relativePath: string;
  readonly base: CrudBaseDescriptor;
  readonly readActions: readonly ReadActionDescriptor[];
  readonly writeActions: readonly WriteActionDescriptor[];
}

export interface MappedSpecCatalog {
  readonly specRoot: string;
  readonly meta: SpecMetaDocument;
  readonly toolsets: readonly SpecToolsetEntry[];
  readonly writeFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sensitiveWriteFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sourceOnlyGates: Readonly<Record<string, string>>;
  readonly families: readonly MappedSpecFamily[];
  readonly crudBases: readonly CrudBaseDescriptor[];
  readonly readActions: readonly ReadActionDescriptor[];
  readonly writeActions: readonly WriteActionDescriptor[];
  readonly actions: readonly JoomlaActionDescriptor[];
  readonly publicTools?: SpecPublicToolsDocument;
}

export interface SpecCatalogProvenance {
  readonly consumed: boolean;
  readonly specRoot?: string;
  readonly specVersion?: string;
  readonly status?: string;
  readonly extractedFamilies?: readonly string[];
  readonly familyCount?: number;
  readonly actionCount?: number;
  readonly fallback: 'in-repo' | 'spec-overlay';
}

export interface ResolvedActionCatalog {
  readonly provenance: SpecCatalogProvenance;
  readonly spec: LoadedSpecCatalog | undefined;
  readonly mapped: MappedSpecCatalog | undefined;
  readonly crudBases: readonly CrudBaseDescriptor[];
  readonly readActions: readonly ReadActionDescriptor[];
  readonly writeActions: readonly WriteActionDescriptor[];
  readonly actions: readonly JoomlaActionDescriptor[];
  readonly readById: ReadonlyMap<string, ReadActionDescriptor>;
  readonly writeById: ReadonlyMap<string, WriteActionDescriptor>;
  readonly writeFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sensitiveWriteFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sourceOnlyGates: Readonly<Record<string, string>>;
  readonly publicTools: SpecPublicToolsDocument | undefined;
  readonly toolsetIds: ReadonlySet<Toolset>;
}

export const SPEC_OPERATIONS: readonly SpecOperation[] = Object.freeze([
  'list', 'get', 'create', 'update', 'delete', 'export', 'healthcheck', 'status', 'state', 'run',
]);

export const SPEC_HTTP_METHODS: readonly SpecHttpMethod[] = Object.freeze([
  'GET', 'POST', 'PATCH', 'DELETE',
]);

export const SPEC_RISKS: readonly SpecRisk[] = Object.freeze([
  'read', 'sensitive-read', 'write', 'destructive',
]);

export const SPEC_BODY_POLICIES: readonly SpecBodyPolicy[] = Object.freeze([
  'none', 'optional', 'required',
]);

export const SPEC_DELETE_SEMANTICS: readonly SpecDeleteSemantics[] = Object.freeze([
  'resource-model-defined', 'permanent',
]);

export const SPEC_ROUTE_PARAMETER_KINDS: readonly SpecRouteParameterKind[] = Object.freeze([
  'positive-integer', 'component-name', 'language-code', 'override-constant', 'adapter-id', 'media-path',
]);

export const SPEC_DRIVER_KINDS: readonly SpecDriverKind[] = Object.freeze([
  'joomla-api', 'joomla-companion',
]);

export const SPEC_TRANSPORTS: readonly SpecTransport[] = Object.freeze([
  'https', 'stdio-cli',
]);

export const SPEC_AUTHENTICATIONS: readonly SpecAuthentication[] = Object.freeze([
  'joomla-api-token', 'joomla-update-token', 'process-identity',
]);

export const SPEC_RESPONSE_SHAPES: readonly SpecResponseShape[] = Object.freeze([
  'json-api', 'joomla-json',
]);

export const SPEC_MUTATION_BODIES: readonly SpecMutationBody[] = Object.freeze([
  'flat-joomla-form-json', 'not-applicable',
]);

export const SPEC_SOURCE_REGISTRATIONS: readonly SpecSourceRegistration[] = Object.freeze([
  'createCRUDRoutes', 'Route', 'native-model',
]);

export const SPEC_PUBLIC_TOOL_CATEGORIES: readonly SpecPublicToolCategory[] = Object.freeze([
  'discovery', 'read', 'write', 'security',
]);

export const SPEC_GATE_SEVERITIES: readonly SpecGateSeverity[] = Object.freeze([
  'source-only', 'restricted', 'informational',
]);

export const SPEC_JSON_SCHEMA_TYPES: readonly SpecJsonSchemaType[] = Object.freeze([
  'object', 'array', 'string', 'integer', 'number', 'boolean', 'null',
]);

export const REQUIRED_PUBLIC_MCP_TOOLS: readonly string[] = Object.freeze([
  'joomla_sites_list',
  'joomla_capabilities',
  'joomla_actions_search',
  'joomla_action_describe',
  'joomla_action_read',
  'joomla_permission_request',
  'joomla_permission_approve',
  'joomla_permissions_list',
  'joomla_permission_revoke',
  'joomla_action_write_plan',
  'joomla_write_apply',
  'joomla_companion_capabilities',
  'joomla_companion_action_read',
]);

export const IMPLEMENTATION_MCP_TOOLS: readonly string[] = Object.freeze([
  'joomla_sites_list',
  'joomla_capabilities',
  'joomla_actions_search',
  'joomla_action_describe',
  'joomla_action_read',
  'joomla_permission_request',
  'joomla_permission_approve',
  'joomla_permissions_list',
  'joomla_permission_revoke',
  'joomla_action_write_plan',
  'joomla_content_articles_list',
  'joomla_content_article_get',
  'joomla_extensions_list',
  'joomla_application_config_get_safe',
  'joomla_cli_commands_list',
  'joomla_cli_command_help',
  'joomla_cli_targets',
  'joomla_cli_inventory',
  'joomla_companion_capabilities',
  'joomla_companion_action_read',
  'joomla_content_article_create_plan',
  'joomla_content_article_update_plan',
  'joomla_content_article_delete_plan',
  'joomla_write_apply',
]);

export const SPEC_GATE_ACTION_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'component-config-read': Object.freeze(['configuration.component.get']),
  'component-config-write': Object.freeze(['configuration.component.update']),
  'language-package-install': Object.freeze(['languages.packages.install']),
  'language-override-patch': Object.freeze([
    'languages.overrides.site.update',
    'languages.overrides.administrator.update',
  ]),
});
