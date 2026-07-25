import { joomlaCrudBases } from '../catalog/crud-bases.js';

export interface LiveFixtureRecord {
  readonly id: string | number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly label: string;
}

export interface LiveFixtureContext {
  readonly lane: string;
  readonly seed: string;
  get(baseId: string): LiveFixtureRecord | undefined;
  reference(baseId: string): LiveFixtureRecord | undefined;
}

export interface CrudFixtureDefinition {
  readonly baseId: string;
  readonly dependencies: readonly string[];
  create(context: LiveFixtureContext, purpose: string): Readonly<Record<string, unknown>>;
  update(
    context: LiveFixtureContext,
    record: LiveFixtureRecord,
    purpose?: string,
  ): Readonly<Record<string, unknown>>;
}

interface FixtureNames {
  readonly title: string;
  readonly description: string;
  readonly alias: string;
  readonly short: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly languageCode: string;
}

type Factory = (
  context: LiveFixtureContext,
  value: FixtureNames,
) => Readonly<Record<string, unknown>>;

const definitions = new Map<string, CrudFixtureDefinition>();

function fixture(
  baseId: string,
  dependencies: readonly string[],
  create: Factory,
  update?: Factory,
): void {
  const definition: CrudFixtureDefinition = {
    baseId,
    dependencies: Object.freeze([...dependencies]),
    create: (context: LiveFixtureContext, purpose: string) =>
      create(context, names(context, baseId, purpose)),
    update: (context: LiveFixtureContext, _record: LiveFixtureRecord, purpose = 'updated') =>
      (update ?? ((_inner, value) => defaultUpdate(baseId, value)))(
        context,
        names(context, baseId, purpose),
      ),
  };
  definitions.set(baseId, Object.freeze(definition));
}

fixture('content.categories', [], (_context, value) => category(value));
fixture('banners.clients', [], (_context, value) => ({
  name: value.title, contact: 'Joomla MCP live test', email: value.email, extrainfo: '', state: 1,
}));
fixture('banners.categories', [], (_context, value) => category(value));
fixture('contacts.categories', [], (_context, value) => category(value));
fixture('menus.site', [], (_context, value) => ({
  menutype: value.short, title: value.title, description: value.description,
}));
fixture('menus.administrator', [], (_context, value) => ({
  menutype: value.short, title: value.short, description: value.description,
}));
fixture('users.groups', [], (_context, value) => ({ parent_id: 2, title: value.title }));
fixture('users.levels', [], (_context, value) => ({ title: value.title, rules: [2], ordering: 1 }));
fixture('tags.tags', [], (_context, value) => ({
  parent_id: 1, title: value.title, alias: value.alias, description: value.description,
  published: 1, access: 1, language: '*',
}));
fixture('templates.site-styles', [], (context, value) => ({
  template: templateName(context, 'templates.site-styles', 'cassiopeia'),
  title: value.title, home: '0', params: { logoFile: '' },
}));
fixture('templates.administrator-styles', [], (context, value) => ({
  template: templateName(context, 'templates.administrator-styles', 'atum'),
  title: value.title, home: '0', params: { colorScheme: 'os' },
}));
fixture('languages.content', [], (_context, value) => ({
  lang_code: value.languageCode,
  title: value.short,
  title_native: value.short,
  // Prefix the full generated language code so neither live record can collide
  // with Joomla's installed language SEF values (for example, en-GB uses en).
  sef: `x${value.languageCode.replace('-', '').toLowerCase()}`,
  image: '',
  description: value.description,
  metadesc: '',
  published: 1,
  access: 1,
}));
fixture('newsfeeds.categories', [], (_context, value) => category(value));
fixture('field-groups.content-articles', [], (_context, value) => fieldGroup(value));
fixture('field-groups.content-categories', [], (_context, value) => fieldGroup(value));
fixture('field-groups.contact', [], (_context, value) => fieldGroup(value));
fixture('field-groups.contact-mail', [], (_context, value) => fieldGroup(value));
fixture('field-groups.contact-categories', [], (_context, value) => fieldGroup(value));
fixture('field-groups.users', [], (_context, value) => fieldGroup(value));

fixture('content.articles', ['content.categories'], (context, value) => ({
  title: value.title,
  alias: value.alias,
  introtext: `<p>${value.description}</p>`,
  fulltext: '',
  state: 1,
  catid: requiredId(context, 'content.categories'),
  access: 1,
  language: '*',
}));
fixture('banners.banners', ['banners.clients', 'banners.categories'], (context, value) => ({
  cid: requiredId(context, 'banners.clients'),
  catid: requiredId(context, 'banners.categories'),
  type: 1,
  name: value.title,
  alias: value.alias,
  description: value.description,
  custombannercode: `<span>${value.description}</span>`,
  params: { imageurl: '' },
  state: 1,
  language: '*',
}));
fixture('contacts.contacts', ['contacts.categories'], (context, value) => ({
  name: value.title,
  alias: value.alias,
  catid: requiredId(context, 'contacts.categories'),
  email_to: value.email,
  params: { show_email_form: 1 },
  published: 1,
  access: 1,
  language: '*',
  misc: value.description,
}));
fixture('menus.site-items', ['menus.site'], (context, value) => ({
  menutype: requiredAttribute(context, 'menus.site', 'menutype'),
  title: value.title,
  alias: value.alias,
  link: 'index.php?option=com_content&view=featured',
  type: 'component',
  published: 1,
  parent_id: 1,
  access: 1,
  language: '*',
}), (context, value) =>
  menuItem(context, value, 'menus.site', 'index.php?option=com_content&view=featured'));
fixture('menus.administrator-items', ['menus.administrator'], (context, value) => ({
  menutype: requiredAttribute(context, 'menus.administrator', 'menutype'),
  title: value.title,
  alias: value.alias,
  link: 'index.php?option=com_cpanel&view=cpanel',
  type: 'component',
  published: 1,
  parent_id: 1,
  access: 1,
  language: '*',
}), (context, value) =>
  menuItem(context, value, 'menus.administrator', 'index.php?option=com_cpanel&view=cpanel'));
fixture('modules.site', [], (_context, value) => ({
  title: value.title,
  content: `<p>${value.description}</p>`,
  module: 'mod_custom',
  position: 'sidebar-right',
  published: 1,
  showtitle: 1,
  access: 1,
  language: '*',
  assigned: [0],
  params: { prepare_content: 0, layout: '_:default' },
}));
fixture('modules.administrator', [], (_context, value) => ({
  title: value.title,
  content: `<p>${value.description}</p>`,
  module: 'mod_custom',
  position: 'cpanel',
  published: 1,
  showtitle: 1,
  access: 1,
  language: '*',
  assigned: [0],
  params: { prepare_content: 0, layout: '_:default' },
}));
fixture('users.users', [], (_context, value) => ({
  name: value.title,
  username: value.username,
  email: value.email,
  password: value.password,
  password2: value.password,
  block: 0,
  sendEmail: 0,
  // Joomla private-message recipients require administrator login and
  // com_messages access. Group 7 is Joomla's built-in Administrator group.
  groups: [7],
}));
fixture('messages.messages', ['users.users'], (context, value) => ({
  // Joomla private-message item and list models expose messages only to their
  // recipient. Target the authenticated fixture user discovered before writes
  // so both API and companion postcondition reads can prove persistence.
  user_id_to: requiredReferenceId(context, 'users.users'),
  folder_id: 0,
  state: 0,
  priority: 0,
  subject: value.title,
  message: value.description,
}));
fixture('newsfeeds.feeds', ['newsfeeds.categories'], (context, value) => ({
  catid: requiredId(context, 'newsfeeds.categories'),
  name: value.title,
  alias: value.alias,
  link: `https://example.invalid/${value.alias}.xml`,
  published: 1,
  numarticles: 5,
  cache_time: 15,
  access: 1,
  language: '*',
  description: value.description,
  metadesc: '',
  metadata: { robots: '' },
  images: {
    image_first: '',
    float_first: '',
    image_first_alt: '',
    image_first_caption: '',
    image_second: '',
    float_second: '',
    image_second_alt: '',
    image_second_caption: '',
  },
  params: { show_feed_image: 1 },
}));
fixture('redirects.redirects', [], (_context, value) => ({
  old_url: `https://example.invalid/old/${value.alias}`,
  new_url: `https://example.invalid/new/${value.alias}`,
  comment: value.description,
  published: 1,
  header: 301,
}));

for (const baseId of [
  'fields.content-articles',
  'fields.content-categories',
  'fields.contact',
  'fields.contact-mail',
  'fields.contact-categories',
  'fields.users',
] as const) {
  const groupId = baseId === 'fields.content-articles'
    ? 'field-groups.content-articles'
    : baseId === 'fields.content-categories'
      ? 'field-groups.content-categories'
      : baseId === 'fields.contact'
        ? 'field-groups.contact'
        : baseId === 'fields.contact-mail'
          ? 'field-groups.contact-mail'
          : baseId === 'fields.contact-categories'
            ? 'field-groups.contact-categories'
            : 'field-groups.users';
  fixture(baseId, [groupId], (context, value) => ({
    group_id: requiredId(context, groupId),
    title: value.title,
    name: value.alias,
    label: value.title,
    default_value: '',
    type: 'text',
    description: value.description,
    state: 1,
    required: 0,
    access: 1,
    language: '*',
    params: { display: 1 },
    fieldparams: { filter: 0 },
  }));
}

export const crudFixtureDefinitions: ReadonlyMap<string, CrudFixtureDefinition> = definitions;

export const crudFixtureOrder: readonly string[] = Object.freeze(topologicalOrder());

export function assertCompleteCrudFixtures(): void {
  const catalogueIds = new Set(joomlaCrudBases.map((base) => base.id));
  const missing = [...catalogueIds].filter((id) => !definitions.has(id));
  const extra = [...definitions.keys()].filter((id) => !catalogueIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Live CRUD fixtures are incomplete (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`);
  }
}

function topologicalOrder(): string[] {
  assertCompleteCrudFixtures();
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Live CRUD fixture dependency cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of definitions.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };

  for (const base of joomlaCrudBases) visit(base.id);
  return ordered;
}

function names(
  context: LiveFixtureContext,
  baseId: string,
  purpose: string,
): FixtureNames {
  const raw = `${context.seed}-${context.lane}-${baseId}-${purpose}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  const compact = raw.slice(0, 54);
  const hash = shortHash(raw);
  const languageBytes = [
    parseInt(hash.slice(0, 2), 16),
    parseInt(hash.slice(2, 4), 16),
    parseInt(hash.slice(4, 6), 16),
    parseInt(hash.slice(6, 8), 16),
  ];
  return {
    title: `Joomla MCP live ${purpose} ${baseId} ${hash}`,
    description: `Generated by Joomla MCP live test ${context.seed}; lane ${context.lane}; ${purpose}.`,
    alias: `jmcp-${compact.slice(0, 38).replace(/-+$/u, '')}-${hash}`,
    short: `jmcp${hash}${purpose[0]}`.slice(0, 20),
    username: `jmcp_${hash}_${purpose[0]}`,
    email: `jmcp-${hash}-${purpose[0]}@example.invalid`,
    password: `Jmcp-${hash}-Live!9x`,
    languageCode:
      `${letter(languageBytes[0]!, false)}${letter(languageBytes[1]!, false)}-` +
      `${letter(languageBytes[2]!, true)}${letter(languageBytes[3]!, true)}`,
  };
}

function menuItem(
  context: LiveFixtureContext,
  value: FixtureNames,
  menuBaseId: 'menus.site' | 'menus.administrator',
  link: string,
): Readonly<Record<string, unknown>> {
  return {
    menutype: requiredAttribute(context, menuBaseId, 'menutype'),
    title: value.title,
    alias: value.alias,
    link,
    type: 'component',
    published: 1,
    parent_id: 1,
    access: 1,
    language: '*',
  };
}

function category(value: FixtureNames): Readonly<Record<string, unknown>> {
  return {
    parent_id: 1,
    title: value.title,
    alias: value.alias,
    description: value.description,
    published: 1,
    access: 1,
    language: '*',
  };
}

function fieldGroup(value: FixtureNames): Readonly<Record<string, unknown>> {
  return {
    title: value.title,
    description: value.description,
    state: 1,
    access: 1,
    language: '*',
  };
}

function defaultUpdate(
  baseId: string,
  value: FixtureNames,
): Readonly<Record<string, unknown>> {
  if (baseId === 'banners.banners' || baseId === 'banners.clients' ||
      baseId === 'contacts.contacts' || baseId === 'newsfeeds.feeds') {
    return { name: value.title };
  }
  if (baseId === 'modules.site' || baseId === 'modules.administrator') {
    return { title: value.title, params: { prepare_content: 0, layout: '_:default' } };
  }
  if (baseId === 'users.users') return { name: value.title };
  if (baseId === 'messages.messages') return { subject: value.title };
  if (baseId === 'redirects.redirects') return { comment: value.description };
  if (baseId === 'menus.administrator') return { title: value.short };
  if (baseId === 'languages.content') return { title: value.short };
  return { title: value.title };
}

function requiredId(context: LiveFixtureContext, baseId: string): string | number {
  const record = context.get(baseId);
  if (record === undefined) throw new Error(`Fixture prerequisite ${baseId} has no created record.`);
  return record.id;
}

function requiredReferenceId(context: LiveFixtureContext, baseId: string): string | number {
  const record = context.reference(baseId);
  if (record === undefined) {
    throw new Error(`Fixture prerequisite ${baseId} has no existing reference record.`);
  }
  return record.id;
}

function requiredAttribute(context: LiveFixtureContext, baseId: string, name: string): unknown {
  const value = context.get(baseId)?.attributes[name];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Fixture prerequisite ${baseId} has no ${name} attribute.`);
  }
  return value;
}

function templateName(context: LiveFixtureContext, baseId: string, fallback: string): string {
  const value = context.reference(baseId)?.attributes['template'];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function letter(value: number, upper: boolean): string {
  const codePoint = (upper ? 65 : 97) + (value % 26);
  return String.fromCodePoint(codePoint);
}
