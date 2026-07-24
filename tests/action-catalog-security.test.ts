import { describe, expect, it } from 'vitest';

import { getJoomlaReadAction, resolveJoomlaReadRequest, resolveJoomlaWriteRequest } from '../src/catalog/action-catalog.js';
import { normalizeBoundedListQuery } from '../src/contracts/bounded-query.js';
import { resolveReadActionRoute } from '../src/contracts/route-resolution.js';

describe('action catalogue request safety', () => {
  it('normalizes only bounded Joomla pagination parameters', () => {
    expect(normalizeBoundedListQuery(undefined)).toEqual({ 'page[offset]': 0, 'page[limit]': 20 });
    expect(normalizeBoundedListQuery({ offset: 40, limit: 25 })).toEqual({ 'page[offset]': 40, 'page[limit]': 25 });
    expect(normalizeBoundedListQuery(undefined, 10)).toEqual({ 'page[offset]': 0, 'page[limit]': 10 });

    expect(() => normalizeBoundedListQuery({ limit: 101 })).toThrow('between 1 and 100');
    expect(() => normalizeBoundedListQuery({ limit: 11 }, 10)).toThrow('between 1 and 10');
    expect(() => normalizeBoundedListQuery({ offset: 100_001 })).toThrow('between 0 and 100000');
    expect(() => normalizeBoundedListQuery({ offset: 1.5 })).toThrow('integer');
    expect(() => normalizeBoundedListQuery({ search: 'unbounded' })).toThrow('Unsupported');
    expect(() => normalizeBoundedListQuery([])).toThrow('object');
  });

  it('resolves numeric CRUD routes and rejects unknown action inputs', () => {
    expect(resolveJoomlaReadRequest('content.articles.get', { id: 42 })).toEqual({
      method: 'GET',
      path: 'v1/content/articles/42',
      query: {},
    });
    expect(resolveJoomlaReadRequest('content.articles.list', { offset: 20, limit: 10 })).toEqual({
      method: 'GET',
      path: 'v1/content/articles',
      query: { 'page[offset]': 20, 'page[limit]': 10 },
    });

    expect(() => resolveJoomlaReadRequest('content.articles.get', { id: '../configuration.php' })).toThrow('positive integer');
    expect(() => resolveJoomlaReadRequest('content.articles.get', { id: 1, path: 'extra' })).toThrow('Unsupported');
    expect(() => resolveJoomlaReadRequest('unknown.action', {})).toThrow('Unknown Joomla read action');
    expect(() => resolveJoomlaReadRequest('content.articles.list', Object.create(null))).toThrow('object');
  });

  it('allows source-defined dynamic identifiers through narrow contracts', () => {
    expect(resolveJoomlaReadRequest('configuration.component.get', { component: 'com_content' }).path)
      .toBe('v1/config/com_content');
    expect(resolveJoomlaReadRequest('languages.overrides.site.get', {
      language: 'en-GB',
      constant: 'COM_CONTENT_ARTICLE_INFO',
    }).path).toBe('v1/languages/overrides/site/en-GB/COM_CONTENT_ARTICLE_INFO');

    expect(() => resolveJoomlaReadRequest('configuration.component.get', { component: '../config' })).toThrow('component name');
    expect(() => resolveJoomlaReadRequest('configuration.component.get', { component: 'content' })).toThrow('component name');
    expect(() => resolveJoomlaReadRequest('languages.overrides.site.get', { language: '../../x', constant: 'OK' })).toThrow('language code');
    expect(() => resolveJoomlaReadRequest('languages.overrides.site.get', { language: 'en-GB', constant: 'bad-value' })).toThrow('uppercase');
  });

  it('preserves safe media subdirectories but blocks traversal and URL syntax', () => {
    expect(resolveJoomlaReadRequest('media.files.get', { path: 'local-images/brand/logo blue.svg' }).path)
      .toBe('v1/media/files/local-images/brand/logo%20blue.svg');
    expect(resolveJoomlaReadRequest('media.directory.list', { path: 'local-images/brand' }).path)
      .toBe('v1/media/files/local-images/brand/');

    for (const path of [
      '../configuration.php',
      'local-images/../configuration.php',
      '/etc/passwd',
      'local-images\\secret',
      'local-images/file.jpg?raw=1',
      'local-images/%2e%2e/configuration.php',
      'local-images//file.jpg',
    ]) {
      expect(() => resolveJoomlaReadRequest('media.files.get', { path })).toThrow();
    }
  });

  it('injects fixed field contexts without exposing them as caller input', () => {
    expect(resolveJoomlaWriteRequest('field-groups.content-articles.create', {
      data: { title: 'Fixture group' },
    }).body).toEqual({
      title: 'Fixture group',
      context: 'com_content.article',
    });
    expect(() => resolveJoomlaWriteRequest('field-groups.content-articles.create', {
      data: { title: 'Fixture group', context: 'com_users.user' },
    })).toThrow('Unsupported field-groups.content-articles.create data properties');
  });

  it('requires all template parameters and does not permit undeclared substitutions', () => {
    const action = getJoomlaReadAction('languages.overrides.administrator.get');
    expect(action).toBeDefined();

    expect(() => resolveReadActionRoute(action!, { language: 'en-GB' })).toThrow('Missing required');
    expect(() => resolveReadActionRoute(action!, {
      language: 'en-GB',
      constant: 'COM_USERS_HEADING',
      injected: 'x',
    })).toThrow('Unexpected route parameters');
  });

  it('resolves special write routes through the same narrow parameter contracts', () => {
    expect(resolveJoomlaWriteRequest('media.files.update', {
      path: 'local-images/brand/logo.svg', data: { path: 'local-images/brand/logo-new.svg' },
    })).toEqual({
      method: 'PATCH',
      path: 'v1/media/files/local-images/brand/logo.svg',
      body: { path: 'local-images/brand/logo-new.svg' },
    });
    expect(resolveJoomlaWriteRequest('languages.overrides.site.delete', {
      language: 'en-GB', constant: 'COM_CONTENT_ARTICLE_INFO',
    })).toEqual({
      method: 'DELETE', path: 'v1/languages/overrides/site/en-GB/COM_CONTENT_ARTICLE_INFO',
    });
    expect(() => resolveJoomlaWriteRequest('media.files.delete', { path: '../configuration.php' })).toThrow();
  });

  it('enforces no-body routes and exact Joomla Update payload contracts', () => {
    expect(resolveJoomlaWriteRequest('content.article-history.keep', { id: 7 })).toEqual({
      method: 'PATCH',
      path: 'v1/content/articles/7/contenthistory/keep',
    });
    expect(resolveJoomlaWriteRequest('languages.overrides.refresh', {})).toEqual({
      method: 'POST',
      path: 'v1/languages/overrides/search/cache/refresh',
    });
    expect(() => resolveJoomlaWriteRequest('content.article-history.keep', {
      id: 7,
      data: { keep: true },
    })).toThrow('Unsupported action input');

    expect(resolveJoomlaWriteRequest('joomla-update.prepare', {
      data: { targetVersion: '6.1.3' },
    })).toEqual({
      method: 'POST',
      path: 'v1/joomlaupdate/prepareUpdate',
      body: { targetVersion: '6.1.3' },
    });
    expect(resolveJoomlaWriteRequest('joomla-update.finalize', {
      data: { fromVersion: '6.1.2', updateFileName: 'Joomla_6.1.3-Stable-Update_Package.zip' },
    }).body).toEqual({
      fromVersion: '6.1.2',
      updateFileName: 'Joomla_6.1.3-Stable-Update_Package.zip',
    });
    expect(() => resolveJoomlaWriteRequest('joomla-update.prepare', {
      data: { targetVersion: '6.1.3', injected: true },
    })).toThrow('Unsupported joomla-update.prepare data properties');
    expect(() => resolveJoomlaWriteRequest('joomla-update.finalize', {
      data: { fromVersion: '6.1.2', updateFileName: '../package.zip' },
    })).toThrow('required format');
    expect(() => resolveJoomlaWriteRequest('joomla-update.notification.success', {
      data: { fromVersion: '6.1.2' },
    })).toThrow('requires data.toVersion');
  });

  it('enforces source-derived special mutation schemas before dispatch', () => {
    expect(resolveJoomlaWriteRequest('plugins.plugins.update', {
      id: 4,
      data: { enabled: 1, access: 2, ordering: 3 },
    }).body).toEqual({ enabled: 1, access: 2, ordering: 3 });
    expect(() => resolveJoomlaWriteRequest('plugins.plugins.update', {
      id: 4,
      data: { enabled: true, params: { arbitrary: true } },
    })).toThrow();

    expect(resolveJoomlaWriteRequest('privacy.requests.create', {
      data: { email: 'person@example.test', request_type: 'remove' },
    }).body).toEqual({ email: 'person@example.test', request_type: 'remove' });
    expect(() => resolveJoomlaWriteRequest('privacy.requests.create', {
      data: { email: 'not-an-email', status: 1 },
    })).toThrow();

    expect(() => resolveJoomlaWriteRequest('media.files.create', {
      data: { path: 'images/file.txt' },
    })).toThrow('requires non-empty Base64 content');
    expect(resolveJoomlaWriteRequest('media.files.create', {
      data: { path: 'images/file.txt', content: 'SGVsbG8=' },
    }).body).toEqual({ path: 'images/file.txt', content: 'SGVsbG8=' });
    expect(() => resolveJoomlaWriteRequest('media.files.update', {
      path: 'images/file.txt',
      data: { override: true },
    })).toThrow('new path or Base64 content');

    expect(resolveJoomlaWriteRequest('languages.overrides.search', {
      data: { searchstring: 'ARTICLE', searchtype: 'constant' },
    }).body).toEqual({ searchstring: 'ARTICLE', searchtype: 'constant' });
    expect(() => resolveJoomlaWriteRequest('languages.overrides.site.create', {
      language: 'en-GB',
      data: { key: 'TRUE', override: 'Not permitted' },
    })).toThrow('reserved');
  });

  it('allows Joomla runtime contact fields but closes the core application configuration field set', () => {
    expect(resolveJoomlaWriteRequest('contacts.form.submit', {
      id: 3,
      data: {
        contact_name: 'Ada',
        contact_email: 'ada@example.test',
        contact_subject: 'Hello',
        contact_message: 'Message',
        'com_fields.custom_7': 'Runtime field',
      },
    }).body).toMatchObject({ 'com_fields.custom_7': 'Runtime field' });

    expect(resolveJoomlaWriteRequest('configuration.application.update', {
      data: { offline: true, mailer: 'smtp', smtpport: 587 },
    }).body).toEqual({ offline: true, mailer: 'smtp', smtpport: 587 });
    expect(() => resolveJoomlaWriteRequest('configuration.application.update', {
      data: { invented_configuration_key: true },
    })).toThrow('Unsupported configuration.application.update data properties');
  });
});
