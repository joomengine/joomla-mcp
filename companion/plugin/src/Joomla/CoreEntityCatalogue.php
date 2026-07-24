<?php

declare(strict_types=1);

namespace VDM\Plugin\Console\JoomlaMcp\Joomla;

use VDM\Plugin\Console\JoomlaMcp\Domain\CoreEntityDefinition;

/**
 * Fixed Joomla 6 administrator-model catalogue.
 *
 * Component, model, field, context, and client values are never accepted from
 * a dispatch request. Adding a surface therefore requires a reviewed code
 * change instead of turning this companion into a generic MVC escape hatch.
 */
final class CoreEntityCatalogue
{
    private const CATEGORY_READ = [
        'id', 'parent_id', 'lft', 'rgt', 'level', 'path', 'extension', 'title', 'alias',
        'note', 'description', 'published', 'checked_out', 'access', 'params', 'metadesc',
        'metakey', 'metadata', 'created_user_id', 'created_time', 'modified_user_id',
        'modified_time', 'hits', 'language', 'version', 'ordering',
    ];

    private const CATEGORY_WRITE = [
        'parent_id', 'title', 'alias', 'note', 'description', 'published', 'access', 'params',
        'metadesc', 'metakey', 'metadata', 'language', 'ordering',
    ];

    private const FIELD_READ = [
        'id', 'asset_id', 'context', 'group_id', 'title', 'name', 'label', 'default_value',
        'type', 'note', 'description', 'state', 'required', 'only_use_in_subform', 'language',
        'created_time', 'created_user_id', 'modified_time', 'modified_by', 'access', 'ordering',
        'params', 'fieldparams',
    ];

    private const FIELD_WRITE = [
        'group_id', 'title', 'name', 'label', 'default_value', 'type', 'note', 'description',
        'state', 'required', 'only_use_in_subform', 'language', 'access', 'ordering', 'params',
        'fieldparams',
    ];

    private const GROUP_READ = [
        'id', 'asset_id', 'context', 'title', 'note', 'description', 'state', 'language',
        'created_time', 'created_user_id', 'modified_time', 'modified_by', 'access', 'ordering',
    ];

    private const GROUP_WRITE = [
        'title', 'note', 'description', 'state', 'language', 'access', 'ordering',
    ];

    /** @return list<CoreEntityDefinition> */
    public static function all(): array
    {
        $category = static fn (
            string $id,
            string $label,
            string $extension,
        ): CoreEntityDefinition => new CoreEntityDefinition(
            $id,
            $label,
            'com_categories',
            'Categories',
            'Category',
            self::CATEGORY_READ,
            self::CATEGORY_WRITE,
            ['extension' => $extension],
            ['filter.extension' => $extension],
        );

        $field = static fn (
            string $id,
            string $label,
            string $context,
        ): CoreEntityDefinition => new CoreEntityDefinition(
            $id,
            $label,
            'com_fields',
            'Fields',
            'Field',
            self::FIELD_READ,
            self::FIELD_WRITE,
            ['context' => $context],
            ['filter.context' => $context],
            'filter.state',
            stateField: 'state',
        );

        $group = static fn (
            string $id,
            string $label,
            string $context,
        ): CoreEntityDefinition => new CoreEntityDefinition(
            $id,
            $label,
            'com_fields',
            'Groups',
            'Group',
            self::GROUP_READ,
            self::GROUP_WRITE,
            ['context' => $context],
            ['filter.context' => $context],
            'filter.state',
            stateField: 'state',
        );

        return [
            new CoreEntityDefinition(
                'content.articles', 'articles', 'com_content', 'Articles', 'Article',
                [
                    'id', 'asset_id', 'title', 'alias', 'introtext', 'fulltext', 'state', 'catid',
                    'created', 'created_by', 'created_by_alias', 'modified', 'modified_by', 'checked_out',
                    'publish_up', 'publish_down', 'images', 'urls', 'attribs', 'version', 'ordering',
                    'metakey', 'metadesc', 'access', 'hits', 'metadata', 'featured', 'language', 'note', 'tags',
                ],
                [
                    'title', 'alias', 'introtext', 'fulltext', 'state', 'catid', 'created_by_alias',
                    'publish_up', 'publish_down', 'images', 'urls', 'attribs', 'ordering', 'metakey',
                    'metadesc', 'access', 'metadata', 'featured', 'language', 'note', 'tags',
                ],
                stateField: 'state',
            ),
            $category('content.categories', 'content categories', 'com_content'),
            new CoreEntityDefinition(
                'banners.banners', 'banners', 'com_banners', 'Banners', 'Banner',
                [
                    'id', 'cid', 'type', 'name', 'alias', 'imptotal', 'impmade', 'clicks', 'clickurl',
                    'state', 'catid', 'description', 'custombannercode', 'sticky', 'ordering', 'metakey',
                    'params', 'own_prefix', 'metakey_prefix', 'purchase_type', 'track_clicks',
                    'track_impressions', 'checked_out', 'publish_up', 'publish_down', 'reset',
                    'created', 'language', 'version',
                ],
                [
                    'cid', 'type', 'name', 'alias', 'imptotal', 'clickurl', 'state', 'catid',
                    'description', 'custombannercode', 'sticky', 'ordering', 'metakey', 'params',
                    'own_prefix', 'metakey_prefix', 'purchase_type', 'track_clicks',
                    'track_impressions', 'publish_up', 'publish_down', 'reset', 'language',
                ],
                stateField: 'state',
            ),
            new CoreEntityDefinition(
                'banners.clients', 'banner clients', 'com_banners', 'Clients', 'Client',
                [
                    'id', 'name', 'contact', 'email', 'extrainfo', 'state', 'metakey', 'own_prefix',
                    'metakey_prefix', 'purchase_type', 'track_clicks', 'track_impressions', 'checked_out',
                    'version',
                ],
                [
                    'name', 'contact', 'email', 'extrainfo', 'state', 'metakey', 'own_prefix',
                    'metakey_prefix', 'purchase_type', 'track_clicks', 'track_impressions',
                ],
                stateFilter: 'filter.state',
                stateField: 'state',
            ),
            $category('banners.categories', 'banner categories', 'com_banners'),
            new CoreEntityDefinition(
                'contacts.contacts', 'contacts', 'com_contact', 'Contacts', 'Contact',
                [
                    'id', 'name', 'alias', 'con_position', 'address', 'suburb', 'state', 'country',
                    'postcode', 'telephone', 'fax', 'misc', 'image', 'email_to', 'default_con',
                    'published', 'checked_out', 'ordering', 'params', 'user_id', 'catid', 'access',
                    'mobile', 'webpage', 'sortname1', 'sortname2', 'sortname3', 'language',
                    'created', 'created_by', 'modified', 'modified_by', 'metakey', 'metadesc',
                    'metadata', 'featured', 'publish_up', 'publish_down', 'version', 'hits', 'tags',
                ],
                [
                    'name', 'alias', 'con_position', 'address', 'suburb', 'state', 'country', 'postcode',
                    'telephone', 'fax', 'misc', 'image', 'email_to', 'default_con', 'published', 'ordering',
                    'params', 'user_id', 'catid', 'access', 'mobile', 'webpage', 'sortname1', 'sortname2',
                    'sortname3', 'language', 'metakey', 'metadesc', 'metadata', 'featured', 'publish_up',
                    'publish_down', 'tags',
                ],
            ),
            $category('contacts.categories', 'contact categories', 'com_contact'),
            new CoreEntityDefinition(
                'menus.site', 'site menus', 'com_menus', 'Menus', 'Menu',
                ['id', 'menutype', 'title', 'description', 'client_id'],
                ['menutype', 'title', 'description'],
                ['client_id' => 0], ['client_id' => 0], supportsState: false,
            ),
            new CoreEntityDefinition(
                'menus.administrator', 'administrator menus', 'com_menus', 'Menus', 'Menu',
                ['id', 'menutype', 'title', 'description', 'client_id'],
                ['menutype', 'title', 'description'],
                ['client_id' => 1], ['client_id' => 1], supportsState: false,
                highRisk: true,
            ),
            new CoreEntityDefinition(
                'menus.site-items', 'site menu items', 'com_menus', 'Items', 'Item',
                [
                    'id', 'menutype', 'title', 'alias', 'note', 'path', 'link', 'type', 'published',
                    'parent_id', 'level', 'component_id', 'checked_out', 'browserNav', 'access', 'img',
                    'template_style_id', 'params', 'lft', 'rgt', 'home', 'language', 'client_id', 'ordering',
                ],
                [
                    'menutype', 'title', 'alias', 'note', 'link', 'type', 'published', 'parent_id',
                    'browserNav', 'access', 'img', 'template_style_id', 'params', 'home', 'language', 'ordering',
                ],
                ['client_id' => 0], ['filter.client_id' => 0],
            ),
            new CoreEntityDefinition(
                'menus.administrator-items', 'administrator menu items', 'com_menus', 'Items', 'Item',
                [
                    'id', 'menutype', 'title', 'alias', 'note', 'path', 'link', 'type', 'published',
                    'parent_id', 'level', 'component_id', 'checked_out', 'browserNav', 'access', 'img',
                    'template_style_id', 'params', 'lft', 'rgt', 'home', 'language', 'client_id', 'ordering',
                ],
                [
                    'menutype', 'title', 'alias', 'note', 'link', 'type', 'published', 'parent_id',
                    'browserNav', 'access', 'img', 'template_style_id', 'params', 'home', 'language', 'ordering',
                ],
                ['client_id' => 1], ['filter.client_id' => 1], highRisk: true,
            ),
            new CoreEntityDefinition(
                'modules.site', 'site modules', 'com_modules', 'Modules', 'Module',
                [
                    'id', 'title', 'note', 'content', 'ordering', 'position', 'checked_out', 'published',
                    'module', 'access', 'showtitle', 'params', 'client_id', 'language', 'assigned',
                ],
                [
                    'title', 'note', 'content', 'ordering', 'position', 'published', 'module', 'access',
                    'showtitle', 'params', 'language', 'assigned',
                ],
                ['client_id' => 0], ['client_id' => 0],
            ),
            new CoreEntityDefinition(
                'modules.administrator', 'administrator modules', 'com_modules', 'Modules', 'Module',
                [
                    'id', 'title', 'note', 'content', 'ordering', 'position', 'checked_out', 'published',
                    'module', 'access', 'showtitle', 'params', 'client_id', 'language', 'assigned',
                ],
                [
                    'title', 'note', 'content', 'ordering', 'position', 'published', 'module', 'access',
                    'showtitle', 'params', 'language', 'assigned',
                ],
                ['client_id' => 1], ['client_id' => 1], highRisk: true,
            ),
            new CoreEntityDefinition(
                'users.users', 'users', 'com_users', 'Users', 'User',
                [
                    'id', 'name', 'username', 'email', 'block', 'sendEmail', 'registerDate',
                    'lastvisitDate', 'activation', 'params', 'lastResetTime', 'resetCount', 'requireReset',
                    'groups',
                ],
                [
                    'name', 'username', 'email', 'password', 'password2', 'block', 'sendEmail',
                    'requireReset', 'groups', 'params',
                ],
                stateFilter: 'filter.state', supportsState: false, highRisk: true,
                sensitiveFields: ['password', 'password2'],
            ),
            new CoreEntityDefinition(
                'users.groups', 'user groups', 'com_users', 'Groups', 'Group',
                ['id', 'parent_id', 'lft', 'rgt', 'title'],
                ['parent_id', 'title'],
                supportsState: false, highRisk: true,
            ),
            new CoreEntityDefinition(
                'users.levels', 'viewing access levels', 'com_users', 'Levels', 'Level',
                ['id', 'title', 'rules', 'ordering'],
                ['title', 'rules', 'ordering'],
                supportsState: false, highRisk: true,
            ),
            new CoreEntityDefinition(
                'tags.tags', 'tags', 'com_tags', 'Tags', 'Tag',
                [
                    'id', 'parent_id', 'lft', 'rgt', 'level', 'path', 'title', 'alias', 'note',
                    'description', 'published', 'checked_out', 'access', 'params', 'metadesc', 'metakey',
                    'metadata', 'created_user_id', 'created_time', 'modified_user_id', 'modified_time',
                    'images', 'urls', 'hits', 'language', 'version', 'publish_up', 'publish_down', 'ordering',
                ],
                [
                    'parent_id', 'title', 'alias', 'note', 'description', 'published', 'access', 'params',
                    'metadesc', 'metakey', 'metadata', 'images', 'urls', 'language', 'publish_up',
                    'publish_down', 'ordering',
                ],
            ),
            new CoreEntityDefinition(
                'templates.site-styles', 'site template styles', 'com_templates', 'Styles', 'Style',
                ['id', 'template', 'client_id', 'home', 'title', 'params'],
                ['template', 'home', 'title', 'params'],
                ['client_id' => 0], ['client_id' => 0], supportsState: false,
            ),
            new CoreEntityDefinition(
                'templates.administrator-styles', 'administrator template styles', 'com_templates', 'Styles', 'Style',
                ['id', 'template', 'client_id', 'home', 'title', 'params'],
                ['template', 'home', 'title', 'params'],
                ['client_id' => 1], ['client_id' => 1], supportsState: false, highRisk: true,
            ),
            new CoreEntityDefinition(
                'languages.content', 'content languages', 'com_languages', 'Languages', 'Language',
                [
                    'lang_id', 'id', 'lang_code', 'title', 'title_native', 'sef', 'image', 'description',
                    'metadesc', 'sitename', 'published', 'access', 'ordering',
                ],
                [
                    'lang_code', 'title', 'title_native', 'sef', 'image', 'description', 'metadesc',
                    'sitename', 'published', 'access', 'ordering',
                ],
                primaryKey: 'lang_id',
            ),
            new CoreEntityDefinition(
                'messages.messages', 'private messages', 'com_messages', 'Messages', 'Message',
                ['message_id', 'id', 'user_id_from', 'user_id_to', 'folder_id', 'date_time', 'state', 'priority', 'subject', 'message'],
                ['user_id_to', 'folder_id', 'state', 'priority', 'subject', 'message'],
                stateFilter: 'filter.state', supportsState: false, highRisk: true,
                primaryKey: 'message_id',
            ),
            new CoreEntityDefinition(
                'newsfeeds.feeds', 'newsfeeds', 'com_newsfeeds', 'Newsfeeds', 'Newsfeed',
                [
                    'id', 'catid', 'name', 'alias', 'link', 'published', 'numarticles', 'cache_time',
                    'checked_out', 'ordering', 'rtl', 'access', 'language', 'params', 'created',
                    'created_by', 'modified', 'modified_by', 'metakey', 'metadesc', 'metadata',
                    'description', 'images', 'version', 'hits', 'publish_up', 'publish_down', 'tags',
                ],
                [
                    'catid', 'name', 'alias', 'link', 'published', 'numarticles', 'cache_time', 'ordering',
                    'rtl', 'access', 'language', 'params', 'metakey', 'metadesc', 'metadata', 'description',
                    'images', 'publish_up', 'publish_down', 'tags',
                ],
            ),
            $category('newsfeeds.categories', 'newsfeed categories', 'com_newsfeeds'),
            new CoreEntityDefinition(
                'redirects.redirects', 'redirects', 'com_redirect', 'Links', 'Link',
                ['id', 'old_url', 'new_url', 'referer', 'comment', 'hits', 'published', 'created_date', 'modified_date', 'header'],
                ['old_url', 'new_url', 'comment', 'published', 'header'],
            ),
            $field('fields.content-articles', 'article fields', 'com_content.article'),
            $field('fields.content-categories', 'content category fields', 'com_content.categories'),
            $group('field-groups.content-articles', 'article field groups', 'com_content.article'),
            $group('field-groups.content-categories', 'content category field groups', 'com_content.categories'),
            $field('fields.contact', 'contact fields', 'com_contact.contact'),
            $field('fields.contact-mail', 'contact mail fields', 'com_contact.mail'),
            $field('fields.contact-categories', 'contact category fields', 'com_contact.categories'),
            $group('field-groups.contact', 'contact field groups', 'com_contact.contact'),
            $group('field-groups.contact-mail', 'contact mail field groups', 'com_contact.mail'),
            $group('field-groups.contact-categories', 'contact category field groups', 'com_contact.categories'),
            new CoreEntityDefinition(
                'fields.users', 'user fields', 'com_fields', 'Fields', 'Field',
                self::FIELD_READ, self::FIELD_WRITE,
                ['context' => 'com_users.user'], ['filter.context' => 'com_users.user'],
                'filter.state', highRisk: true, stateField: 'state',
            ),
            new CoreEntityDefinition(
                'field-groups.users', 'user field groups', 'com_fields', 'Groups', 'Group',
                self::GROUP_READ, self::GROUP_WRITE,
                ['context' => 'com_users.user'], ['filter.context' => 'com_users.user'],
                'filter.state', highRisk: true, stateField: 'state',
            ),
        ];
    }
}
