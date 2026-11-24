/**
 * The 6.2.1 administrator forms render these GUID selectors read-only so
 * association rows keep the parent chosen by the administrator. Joomla's
 * JSON:API can bind that initial relationship on create. PATCH remains immutable.
 */
export interface JcbParentBinding {
  readonly field: string;
  readonly resource: string;
}

const families = [
  {
    field: 'admin_view', resource: 'admin_views',
    children: ['admins_fields', 'admins_fields_conditions', 'admins_fields_relations', 'admins_custom_tabs'],
  },
  {
    field: 'joomla_component', resource: 'joomla_components',
    children: [
      'components_admin_views', 'components_site_views', 'components_custom_admin_views', 'components_updates',
      'components_mysql_tweaks', 'components_custom_admin_menus', 'components_routers', 'components_config',
      'components_dashboard', 'components_files_folders', 'components_placeholders', 'components_plugins',
      'components_modules',
    ],
  },
  {field: 'library', resource: 'libraries', children: ['libraries_config', 'libraries_files_folders_urls']},
  {
    field: 'joomla_module', resource: 'joomla_modules',
    children: ['joomla_modules_updates', 'joomla_modules_files_folders_urls'],
  },
  {
    field: 'joomla_plugin', resource: 'joomla_plugins',
    children: ['joomla_plugins_updates', 'joomla_plugins_files_folders_urls'],
  },
];

const bindings = new Map<string, JcbParentBinding>();
for (const {field, resource, children} of families) {
  const binding = Object.freeze({field, resource});
  for (const child of children) bindings.set(child, binding);
}

export function getJcbParentBinding(resource: string): JcbParentBinding | undefined {
  return bindings.get(resource);
}
