# JCB Web Services action reference

Use `joomla_actions_search` with `domain: "jcb"` to discover the actions available on your site. This reference is generated from the reviewed JCB route registrations. The [JCB integration guide](JCB.md) covers setup, examples, native permissions, compilation and package commands.

Each action ID starts with `jcb.api.`, followed by the family and the suffix in the table. For example, `jcb.api.admin_views.get.guid` reads one admin view by GUID. The plain `get`, `update` and `delete` suffixes take a numeric `id`. Their `.guid` variants take a `guid`. Use `joomla_action_describe` for the complete input schema, nested fields, native conditions and source references.

List actions accept only their registered filters. Creates bind initial associations to the GUID of an existing parent where indicated. The installed translation form disables its required source on create. Its existing translations can be read and edited.

| Family | Action suffixes | List filters | Parent GUID on create |
| --- | --- | --- | --- |
| `admin_views` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `add_fadein`, `type`, `add_custom_button`, `add_php_ajax` | — |
| `admins_custom_tabs` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `admin_view` from `admin_views` |
| `admins_fields` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `admin_view` from `admin_views` |
| `admins_fields_conditions` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `admin_view` from `admin_views` |
| `admins_fields_relations` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `admin_view` from `admin_views` |
| `class_extendings` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `extension_type` | — |
| `class_methods` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `visibility`, `extension_type` | — |
| `class_properties` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `visibility`, `extension_type` | — |
| `compiler` | `list` | — | — |
| `components_admin_views` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_config` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_custom_admin_menus` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_custom_admin_views` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_dashboard` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_files_folders` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_modules` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_mysql_tweaks` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_placeholders` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_plugins` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_routers` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access`, `mode_constructor_before_parent`, `mode_constructor_after_parent`, `mode_methods` | `joomla_component` from `joomla_components` |
| `components_site_views` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `components_updates` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_component` from `joomla_components` |
| `custom_admin_views` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `add_php_ajax`, `add_custom_button` | — |
| `custom_codes` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access`, `target`, `type`, `comment_type` | — |
| `dynamic_gets` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `main_source`, `gettype` | — |
| `extrusion` | `list` | — | — |
| `fields` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `category_id`, `fieldtype`, `datatype`, `indexes`, `null_switch`, `store` | — |
| `fieldtypes` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `category_id` | — |
| `help_documents` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `type`, `location`, `admin_view`, `site_view` | — |
| `joomla_components` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `companyname`, `author` | — |
| `joomla_modules` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `target` | — |
| `joomla_modules_files_folders_urls` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_module` from `joomla_modules` |
| `joomla_modules_updates` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_module` from `joomla_modules` |
| `joomla_plugin_groups` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `class_extends` | — |
| `joomla_plugins` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `class_extends`, `joomla_plugin_group` | — |
| `joomla_plugins_files_folders_urls` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_plugin` from `joomla_plugins` |
| `joomla_plugins_updates` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `joomla_plugin` from `joomla_plugins` |
| `joomla_powers` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access` | — |
| `language_translations` | `list`, `get`, `update`, `delete` | `search`, `published`, `access` | — |
| `languages` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | — |
| `layouts` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `dynamic_get`, `add_php_view` | — |
| `libraries` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `target`, `how`, `type` | — |
| `libraries_config` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `library` from `libraries` |
| `libraries_files_folders_urls` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | `library` from `libraries` |
| `placeholders` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | — |
| `powers` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `type`, `approved` | — |
| `repositories` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `organisation`, `repository`, `target`, `type`, `base` | — |
| `servers` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access`, `name`, `protocol` | — |
| `site_views` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `add_php_ajax`, `add_custom_button` | — |
| `snippet_types` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access` | — |
| `snippets` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `type`, `library` | — |
| `templates` | `list`, `get`, `get.guid`, `create`, `update`, `update.guid`, `delete`, `delete.guid` | `search`, `published`, `access`, `dynamic_get`, `add_php_view` | — |
| `validation_rules` | `list`, `get`, `create`, `update`, `delete` | `search`, `published`, `access` | — |
