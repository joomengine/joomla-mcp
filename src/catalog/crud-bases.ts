import type { Toolset } from '../config/schema.js';
import type { CrudBaseDescriptor } from '../contracts/action-catalog.js';
import { acl, apiDriver, crudOperations, joomla6xVersions, source } from './source-metadata.js';

interface CrudSeed {
  readonly id: string;
  readonly domain: string;
  readonly resource: string;
  readonly collectionName: string;
  readonly itemName: string;
  readonly basePath: `v1/${string}`;
  readonly controller: string;
  readonly component: `com_${string}`;
  readonly defaults?: Readonly<Record<string, string | number>>;
  readonly plugin: string;
  readonly className: string;
  readonly toolset: Toolset;
  readonly mutationPhase?: 4 | 6;
  readonly deleteSemantics?: CrudBaseDescriptor['deleteSemantics'];
}

function crud(seed: CrudSeed): CrudBaseDescriptor {
  const defaults = Object.freeze({ component: seed.component, ...(seed.defaults ?? {}) });

  return Object.freeze({
    id: seed.id,
    domain: seed.domain,
    resource: seed.resource,
    collectionName: seed.collectionName,
    itemName: seed.itemName,
    basePath: seed.basePath,
    controller: seed.controller,
    controllerDefaults: defaults,
    toolset: seed.toolset,
    routeParameter: Object.freeze({ name: 'id', kind: 'positive-integer', required: true, maximumLength: 16 }),
    operations: crudOperations(seed.mutationPhase ?? 4),
    deleteSemantics: seed.deleteSemantics ?? 'resource-model-defined',
    acl: acl(seed.component),
    driver: apiDriver(`webservices/${seed.plugin}`),
    versions: joomla6xVersions,
    source: source(seed.plugin, seed.className, 'createCRUDRoutes'),
  });
}

/**
 * Joomla 6.1 source-backed CRUD registrations. Every entry expands to the five
 * routes created by ApiRouter::createCRUDRoutes; only GET actions are enabled
 * by the Phase 2 catalogue.
 */
export const joomlaCrudBases: readonly CrudBaseDescriptor[] = Object.freeze([
  crud({
    id: 'content.articles', domain: 'content', resource: 'article', collectionName: 'Articles', itemName: 'Article',
    basePath: 'v1/content/articles', controller: 'articles', component: 'com_content', plugin: 'content', className: 'Content',
    toolset: 'content.read',
  }),
  crud({
    id: 'content.categories', domain: 'content', resource: 'content-category', collectionName: 'Content categories', itemName: 'Content category',
    basePath: 'v1/content/categories', controller: 'categories', component: 'com_categories', defaults: { extension: 'com_content' },
    plugin: 'content', className: 'Content', toolset: 'structure.read',
  }),
  crud({
    id: 'banners.banners', domain: 'banners', resource: 'banner', collectionName: 'Banners', itemName: 'Banner',
    basePath: 'v1/banners', controller: 'banners', component: 'com_banners', plugin: 'banners', className: 'Banners', toolset: 'content.read',
  }),
  crud({
    id: 'banners.clients', domain: 'banners', resource: 'banner-client', collectionName: 'Banner clients', itemName: 'Banner client',
    basePath: 'v1/banners/clients', controller: 'clients', component: 'com_banners', plugin: 'banners', className: 'Banners', toolset: 'structure.read',
  }),
  crud({
    id: 'banners.categories', domain: 'banners', resource: 'banner-category', collectionName: 'Banner categories', itemName: 'Banner category',
    basePath: 'v1/banners/categories', controller: 'categories', component: 'com_categories', defaults: { extension: 'com_banners' },
    plugin: 'banners', className: 'Banners', toolset: 'structure.read',
  }),
  crud({
    id: 'contacts.contacts', domain: 'contacts', resource: 'contact', collectionName: 'Contacts', itemName: 'Contact',
    basePath: 'v1/contacts', controller: 'contact', component: 'com_contact', plugin: 'contact', className: 'Contact', toolset: 'content.read',
  }),
  crud({
    id: 'contacts.categories', domain: 'contacts', resource: 'contact-category', collectionName: 'Contact categories', itemName: 'Contact category',
    basePath: 'v1/contacts/categories', controller: 'categories', component: 'com_categories', defaults: { extension: 'com_contact' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'menus.site', domain: 'menus', resource: 'site-menu', collectionName: 'Site menus', itemName: 'Site menu',
    basePath: 'v1/menus/site', controller: 'menus', component: 'com_menus', defaults: { client_id: 0 },
    plugin: 'menus', className: 'Menus', toolset: 'structure.read', deleteSemantics: 'permanent',
  }),
  crud({
    id: 'menus.administrator', domain: 'menus', resource: 'administrator-menu', collectionName: 'Administrator menus', itemName: 'Administrator menu',
    basePath: 'v1/menus/administrator', controller: 'menus', component: 'com_menus', defaults: { client_id: 1 },
    plugin: 'menus', className: 'Menus', toolset: 'structure.read', deleteSemantics: 'permanent',
  }),
  crud({
    id: 'menus.site-items', domain: 'menus', resource: 'site-menu-item', collectionName: 'Site menu items', itemName: 'Site menu item',
    basePath: 'v1/menus/site/items', controller: 'items', component: 'com_menus', defaults: { client_id: 0 },
    plugin: 'menus', className: 'Menus', toolset: 'structure.read',
  }),
  crud({
    id: 'menus.administrator-items', domain: 'menus', resource: 'administrator-menu-item', collectionName: 'Administrator menu items', itemName: 'Administrator menu item',
    basePath: 'v1/menus/administrator/items', controller: 'items', component: 'com_menus', defaults: { client_id: 1 },
    plugin: 'menus', className: 'Menus', toolset: 'structure.read',
  }),
  crud({
    id: 'modules.site', domain: 'modules', resource: 'site-module', collectionName: 'Site modules', itemName: 'Site module',
    basePath: 'v1/modules/site', controller: 'modules', component: 'com_modules', defaults: { client_id: 0 },
    plugin: 'modules', className: 'Modules', toolset: 'structure.read',
  }),
  crud({
    id: 'modules.administrator', domain: 'modules', resource: 'administrator-module', collectionName: 'Administrator modules', itemName: 'Administrator module',
    basePath: 'v1/modules/administrator', controller: 'modules', component: 'com_modules', defaults: { client_id: 1 },
    plugin: 'modules', className: 'Modules', toolset: 'structure.read',
  }),
  crud({
    id: 'users.users', domain: 'users', resource: 'user', collectionName: 'Users', itemName: 'User',
    basePath: 'v1/users', controller: 'users', component: 'com_users', plugin: 'users', className: 'Users', toolset: 'users.read',
    mutationPhase: 6, deleteSemantics: 'permanent',
  }),
  crud({
    id: 'users.groups', domain: 'users', resource: 'user-group', collectionName: 'User groups', itemName: 'User group',
    basePath: 'v1/users/groups', controller: 'groups', component: 'com_users', plugin: 'users', className: 'Users', toolset: 'users.read',
    mutationPhase: 6, deleteSemantics: 'permanent',
  }),
  crud({
    id: 'users.levels', domain: 'users', resource: 'viewing-access-level', collectionName: 'Viewing access levels', itemName: 'Viewing access level',
    basePath: 'v1/users/levels', controller: 'levels', component: 'com_users', plugin: 'users', className: 'Users', toolset: 'users.read',
    mutationPhase: 6, deleteSemantics: 'permanent',
  }),
  crud({
    id: 'tags.tags', domain: 'tags', resource: 'tag', collectionName: 'Tags', itemName: 'Tag',
    basePath: 'v1/tags', controller: 'tags', component: 'com_tags', plugin: 'tags', className: 'Tags', toolset: 'structure.read',
  }),
  crud({
    id: 'templates.site-styles', domain: 'templates', resource: 'site-template-style', collectionName: 'Site template styles', itemName: 'Site template style',
    basePath: 'v1/templates/styles/site', controller: 'styles', component: 'com_templates', defaults: { client_id: 0 },
    plugin: 'templates', className: 'Templates', toolset: 'structure.read', deleteSemantics: 'permanent',
  }),
  crud({
    id: 'templates.administrator-styles', domain: 'templates', resource: 'administrator-template-style', collectionName: 'Administrator template styles', itemName: 'Administrator template style',
    basePath: 'v1/templates/styles/administrator', controller: 'styles', component: 'com_templates', defaults: { client_id: 1 },
    plugin: 'templates', className: 'Templates', toolset: 'structure.read', deleteSemantics: 'permanent',
  }),
  crud({
    id: 'languages.content', domain: 'languages', resource: 'content-language', collectionName: 'Content languages', itemName: 'Content language',
    basePath: 'v1/languages/content', controller: 'languages', component: 'com_languages', plugin: 'languages', className: 'Languages', toolset: 'structure.read',
  }),
  crud({
    id: 'messages.messages', domain: 'messages', resource: 'private-message', collectionName: 'Private messages', itemName: 'Private message',
    basePath: 'v1/messages', controller: 'messages', component: 'com_messages', plugin: 'messages', className: 'Messages', toolset: 'users.read',
    deleteSemantics: 'permanent',
  }),
  crud({
    id: 'newsfeeds.feeds', domain: 'newsfeeds', resource: 'newsfeed', collectionName: 'Newsfeeds', itemName: 'Newsfeed',
    basePath: 'v1/newsfeeds/feeds', controller: 'feeds', component: 'com_newsfeeds', plugin: 'newsfeeds', className: 'Newsfeeds', toolset: 'content.read',
  }),
  crud({
    id: 'newsfeeds.categories', domain: 'newsfeeds', resource: 'newsfeed-category', collectionName: 'Newsfeed categories', itemName: 'Newsfeed category',
    basePath: 'v1/newsfeeds/categories', controller: 'categories', component: 'com_categories', defaults: { extension: 'com_newsfeeds' },
    plugin: 'newsfeeds', className: 'Newsfeeds', toolset: 'structure.read',
  }),
  crud({
    id: 'redirects.redirects', domain: 'redirects', resource: 'redirect', collectionName: 'Redirects', itemName: 'Redirect',
    basePath: 'v1/redirects', controller: 'redirect', component: 'com_redirect', plugin: 'redirect', className: 'Redirect', toolset: 'maintenance.read',
  }),
  crud({
    id: 'fields.content-articles', domain: 'fields', resource: 'article-field', collectionName: 'Article fields', itemName: 'Article field',
    basePath: 'v1/fields/content/articles', controller: 'fields', component: 'com_fields', defaults: { context: 'com_content.article' },
    plugin: 'content', className: 'Content', toolset: 'structure.read',
  }),
  crud({
    id: 'fields.content-categories', domain: 'fields', resource: 'content-category-field', collectionName: 'Content category fields', itemName: 'Content category field',
    basePath: 'v1/fields/content/categories', controller: 'fields', component: 'com_fields', defaults: { context: 'com_content.categories' },
    plugin: 'content', className: 'Content', toolset: 'structure.read',
  }),
  crud({
    id: 'field-groups.content-articles', domain: 'fields', resource: 'article-field-group', collectionName: 'Article field groups', itemName: 'Article field group',
    basePath: 'v1/fields/groups/content/articles', controller: 'groups', component: 'com_fields', defaults: { context: 'com_content.article' },
    plugin: 'content', className: 'Content', toolset: 'structure.read',
  }),
  crud({
    id: 'field-groups.content-categories', domain: 'fields', resource: 'content-category-field-group', collectionName: 'Content category field groups', itemName: 'Content category field group',
    basePath: 'v1/fields/groups/content/categories', controller: 'groups', component: 'com_fields', defaults: { context: 'com_content.categories' },
    plugin: 'content', className: 'Content', toolset: 'structure.read',
  }),
  crud({
    id: 'fields.contact', domain: 'fields', resource: 'contact-field', collectionName: 'Contact fields', itemName: 'Contact field',
    basePath: 'v1/fields/contacts/contact', controller: 'fields', component: 'com_fields', defaults: { context: 'com_contact.contact' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'fields.contact-mail', domain: 'fields', resource: 'contact-mail-field', collectionName: 'Contact mail fields', itemName: 'Contact mail field',
    basePath: 'v1/fields/contacts/mail', controller: 'fields', component: 'com_fields', defaults: { context: 'com_contact.mail' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'fields.contact-categories', domain: 'fields', resource: 'contact-category-field', collectionName: 'Contact category fields', itemName: 'Contact category field',
    basePath: 'v1/fields/contacts/categories', controller: 'fields', component: 'com_fields', defaults: { context: 'com_contact.categories' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'field-groups.contact', domain: 'fields', resource: 'contact-field-group', collectionName: 'Contact field groups', itemName: 'Contact field group',
    basePath: 'v1/fields/groups/contacts/contact', controller: 'groups', component: 'com_fields', defaults: { context: 'com_contact.contact' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'field-groups.contact-mail', domain: 'fields', resource: 'contact-mail-field-group', collectionName: 'Contact mail field groups', itemName: 'Contact mail field group',
    basePath: 'v1/fields/groups/contacts/mail', controller: 'groups', component: 'com_fields', defaults: { context: 'com_contact.mail' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'field-groups.contact-categories', domain: 'fields', resource: 'contact-category-field-group', collectionName: 'Contact category field groups', itemName: 'Contact category field group',
    basePath: 'v1/fields/groups/contacts/categories', controller: 'groups', component: 'com_fields', defaults: { context: 'com_contact.categories' },
    plugin: 'contact', className: 'Contact', toolset: 'structure.read',
  }),
  crud({
    id: 'fields.users', domain: 'fields', resource: 'user-field', collectionName: 'User fields', itemName: 'User field',
    basePath: 'v1/fields/users', controller: 'fields', component: 'com_fields', defaults: { context: 'com_users.user' },
    plugin: 'users', className: 'Users', toolset: 'users.read', mutationPhase: 6,
  }),
  crud({
    id: 'field-groups.users', domain: 'fields', resource: 'user-field-group', collectionName: 'User field groups', itemName: 'User field group',
    basePath: 'v1/fields/groups/users', controller: 'groups', component: 'com_fields', defaults: { context: 'com_users.user' },
    plugin: 'users', className: 'Users', toolset: 'users.read', mutationPhase: 6,
  }),
]);
