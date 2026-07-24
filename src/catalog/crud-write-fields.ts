/**
 * Fixed Joomla administrator-model write-field allowlists.
 *
 * These names mirror the reviewed companion CoreEntityCatalogue. They keep the
 * generic MCP write tool from accepting arbitrary form keys while Joomla's own
 * form/model remains responsible for resource-specific value validation.
 */

const category = [
  'parent_id', 'title', 'alias', 'note', 'description', 'published', 'access', 'params',
  'metadesc', 'metakey', 'metadata', 'language', 'ordering',
] as const;

const field = [
  'group_id', 'title', 'name', 'label', 'default_value', 'type', 'note', 'description',
  'state', 'required', 'only_use_in_subform', 'language', 'access', 'ordering', 'params',
  'fieldparams',
] as const;

const fieldGroup = [
  'title', 'note', 'description', 'state', 'language', 'access', 'ordering',
] as const;

const menuItem = [
  'menutype', 'title', 'alias', 'note', 'link', 'type', 'published', 'parent_id',
  'browserNav', 'access', 'img', 'template_style_id', 'params', 'home', 'language', 'ordering',
] as const;

const moduleFields = [
  'title', 'note', 'content', 'ordering', 'position', 'published', 'module', 'access',
  'showtitle', 'params', 'language', 'assigned',
] as const;

export const crudWriteFieldsByBaseId: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'content.articles': Object.freeze([
    'title', 'alias', 'articletext', 'introtext', 'fulltext', 'state', 'catid', 'created_by_alias',
    'publish_up', 'publish_down', 'images', 'urls', 'attribs', 'ordering', 'metakey',
    'metadesc', 'access', 'metadata', 'featured', 'language', 'note', 'tags',
  ]),
  'content.categories': Object.freeze([...category]),
  'banners.banners': Object.freeze([
    'cid', 'type', 'name', 'alias', 'imptotal', 'clickurl', 'state', 'catid',
    'description', 'custombannercode', 'sticky', 'ordering', 'metakey', 'params',
    'own_prefix', 'metakey_prefix', 'purchase_type', 'track_clicks',
    'track_impressions', 'publish_up', 'publish_down', 'reset', 'language',
  ]),
  'banners.clients': Object.freeze([
    'name', 'contact', 'email', 'extrainfo', 'state', 'metakey', 'own_prefix',
    'metakey_prefix', 'purchase_type', 'track_clicks', 'track_impressions',
  ]),
  'banners.categories': Object.freeze([...category]),
  'contacts.contacts': Object.freeze([
    'name', 'alias', 'con_position', 'address', 'suburb', 'state', 'country', 'postcode',
    'telephone', 'fax', 'misc', 'image', 'email_to', 'default_con', 'published', 'ordering',
    'params', 'user_id', 'catid', 'access', 'mobile', 'webpage', 'sortname1', 'sortname2',
    'sortname3', 'language', 'metakey', 'metadesc', 'metadata', 'featured', 'publish_up',
    'publish_down', 'tags',
  ]),
  'contacts.categories': Object.freeze([...category]),
  'menus.site': Object.freeze(['menutype', 'title', 'description']),
  'menus.administrator': Object.freeze(['menutype', 'title', 'description']),
  'menus.site-items': Object.freeze([...menuItem]),
  'menus.administrator-items': Object.freeze([...menuItem]),
  'modules.site': Object.freeze([...moduleFields]),
  'modules.administrator': Object.freeze([...moduleFields]),
  'users.users': Object.freeze([
    'name', 'username', 'email', 'password', 'password2', 'block', 'sendEmail',
    'requireReset', 'groups', 'params',
  ]),
  'users.groups': Object.freeze(['parent_id', 'title']),
  'users.levels': Object.freeze(['title', 'rules', 'ordering']),
  'tags.tags': Object.freeze([
    'parent_id', 'title', 'alias', 'note', 'description', 'published', 'access', 'params',
    'metadesc', 'metakey', 'metadata', 'images', 'urls', 'language', 'publish_up',
    'publish_down', 'ordering',
  ]),
  'templates.site-styles': Object.freeze(['template', 'home', 'title', 'params']),
  'templates.administrator-styles': Object.freeze(['template', 'home', 'title', 'params']),
  'languages.content': Object.freeze([
    'lang_code', 'title', 'title_native', 'sef', 'image', 'description', 'metadesc',
    'sitename', 'published', 'access', 'ordering',
  ]),
  'messages.messages': Object.freeze([
    'user_id_to', 'folder_id', 'state', 'priority', 'subject', 'message',
  ]),
  'newsfeeds.feeds': Object.freeze([
    'catid', 'name', 'alias', 'link', 'published', 'numarticles', 'cache_time', 'ordering',
    'rtl', 'access', 'language', 'params', 'metakey', 'metadesc', 'metadata', 'description',
    'images', 'publish_up', 'publish_down', 'tags',
  ]),
  'newsfeeds.categories': Object.freeze([...category]),
  'redirects.redirects': Object.freeze(['old_url', 'new_url', 'comment', 'published', 'header']),
  'fields.content-articles': Object.freeze([...field]),
  'fields.content-categories': Object.freeze([...field]),
  'field-groups.content-articles': Object.freeze([...fieldGroup]),
  'field-groups.content-categories': Object.freeze([...fieldGroup]),
  'fields.contact': Object.freeze([...field]),
  'fields.contact-mail': Object.freeze([...field]),
  'fields.contact-categories': Object.freeze([...field]),
  'field-groups.contact': Object.freeze([...fieldGroup]),
  'field-groups.contact-mail': Object.freeze([...fieldGroup]),
  'field-groups.contact-categories': Object.freeze([...fieldGroup]),
  'fields.users': Object.freeze([...field]),
  'field-groups.users': Object.freeze([...fieldGroup]),
});

export const sensitiveCrudWriteFieldsByBaseId: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'users.users': Object.freeze(['password', 'password2']),
});

export function crudWriteFields(baseId: string): readonly string[] {
  const fields = crudWriteFieldsByBaseId[baseId];

  if (fields === undefined) {
    throw new Error(`CRUD base ${baseId} has no reviewed write-field allowlist.`);
  }

  return fields;
}
