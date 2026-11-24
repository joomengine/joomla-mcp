import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../src/config/schema.js';
import { JoomlaApiError } from '../src/infrastructure/api/joomla-api-error.js';
import type { JoomlaApiResponse, JoomlaApiTransport } from '../src/infrastructure/api/joomla-api-client.js';
import { getJcbApiAction } from '../src/jcb/catalog.js';
import {
  applyJcbApiWrite,
  prepareJcbApiWrite,
  probeJcbApiResource,
  readJcbApiAction,
  resolveJcbApiRequest,
} from '../src/jcb/api.js';
import { jcbInputSchema } from '../src/jcb/api-input.js';

const apiConfig: ApiConfig = {
  baseUrl: 'https://cms.example/joomla',
  tokenEnv: 'TEST',
  token: 'test',
  timeoutMs: 1000,
  maxResponseBytes: 100000,
  maxPageSize: 3,
};
const key = '1db54972-0003-4643-92da-dac1b45449e4';

function action(id: string) {
  const descriptor = getJcbApiAction('jcb.api.' + id);
  if (!descriptor) throw new Error('Test action missing: ' + id);
  return descriptor;
}

function response(data: unknown, status = 200, headers: Record<string, string> = {}): JoomlaApiResponse {
  return { data, status, headers };
}

function item(id: string, attributes: Record<string, unknown>, type = 'languages'): JoomlaApiResponse {
  return response({ data: { id, type, attributes } });
}

function transport() {
  return { get: vi.fn<JoomlaApiTransport['get']>(), request: vi.fn<JoomlaApiTransport['request']>() };
}

describe('JCB Web Services', () => {
  it('resolves only native filters, ordering and bounded page sizes', async () => {
    const fields = action('fields.list');
    const request = resolveJcbApiRequest(
      fields,
      { filter: { datatype: ['INT', 'CHAR'] }, ordering: 'id', direction: 'DESC', limit: 5 },
      3,
    );
    expect(request).toMatchObject({
      method: 'GET',
      path: 'v1/componentbuilder/fields',
      query: {
        'filter[datatype][]': ['INT', 'CHAR'],
        'list[ordering]': 'id',
        'list[direction]': 'desc',
        'page[limit]': 3,
        'page[offset]': 0,
      },
    });
    expect(() => resolveJcbApiRequest(fields, { filter: { unsupported: 'value' } })).toThrow(
      'Unknown list filter',
    );
    expect(() => resolveJcbApiRequest(fields, { filter: { datatype: [['nested']] } })).toThrow('scalar');
    expect(() => resolveJcbApiRequest(fields, { ordering: 'unregistered' })).toThrow();
    expect(() => resolveJcbApiRequest(fields, { baseUrl: 'elsewhere' })).toThrow();
    expect(jcbInputSchema(fields)).toHaveProperty('properties.filter.properties.datatype');
  });

  it('sends required native defaults only for active fields and only during creation', async () => {
    const create = action('templates.create');
    const body = { name: 'Fixture', alias: 'fixture', description: 'Fixture' };
    const plan = await prepareJcbApiWrite(transport(), apiConfig, create, { data: body });
    expect(plan.request.body).toHaveProperty('add_php_view', '0');
    expect(plan.preview.formDefaults).toContain('add_php_view');
    expect(jcbInputSchema(create)).toHaveProperty('properties.data.properties.add_php_view.default', '0');
    expect(resolveJcbApiRequest(action('templates.update'), { id: 1, data: body }).body).toEqual(body);
    expect(resolveJcbApiRequest(action('help_documents.create'), { data: { type: 2 } }).body).not.toHaveProperty(
      'article',
    );
    expect(resolveJcbApiRequest(action('help_documents.create'), { data: { type: 1 } }).body).toHaveProperty(
      'article',
      '0',
    );
    expect(resolveJcbApiRequest(create, { data: { ...body, add_php_view: '1' } }).body).toHaveProperty(
      'add_php_view',
      '1',
    );
  });

  it('sends native bundled form params only on create and discloses those form defaults separately', async () => {
    const create = action('admin_views.create');
    const data = { name_single: 'Entry', name_list: 'Entries', short_description: 'Fixture' };
    const plan = await prepareJcbApiWrite(transport(), apiConfig, create, { data });
    expect(plan.request.body).toHaveProperty('params.privacy.activate', '0');
    expect(plan.preview.pluginFormDefaults).toHaveProperty('privacy.permissions', '1');
    expect(plan.preview.fields).not.toContain('params');
    expect(() =>
      resolveJcbApiRequest(create, { data: { ...data, params: { privacy: { activate: '1' } } } }),
    ).toThrow('read-only');
    expect(resolveJcbApiRequest(action('admin_views.update'), { id: 1, data }).body).not.toHaveProperty('params');
  });

  it('discloses the component model canonical code name before dispatch', async () => {
    const update = action('joomla_components.update');
    const api = transport();
    api.get.mockResolvedValue(item('7', { name_code: 'Old' }, 'joomla_components'));
    const plan = await prepareJcbApiWrite(api, apiConfig, update, {
      id: 7,
      data: { name_code: 'test-component.v2' },
    });
    expect(plan.preview.normalizedComponentCodeName).toBe('Testcomponentv2');
    expect(plan.request.body).toEqual({ name_code: 'Testcomponentv2' });
  });

  it('matches native integer storage while retaining strict comparison for ordinary text', async () => {
    const update = action('libraries.update');
    const api = transport();
    const prior = item('7', { name: 'library', how: 0 }, 'libraries');
    const saved = item('7', { name: 1, how: 1 }, 'libraries');
    for (const data of [{ how: '1' }, { name: '1' }]) {
      api.get.mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValueOnce(saved);
      api.request.mockResolvedValueOnce(saved);
      const plan = await prepareJcbApiWrite(api, apiConfig, update, { id: 7, data });
      const result = await applyJcbApiWrite(api, apiConfig, update, plan, key);
      expect(result.verification.status).toBe('how' in data ? 'verified' : 'uncertain');
    }
  });

  it('reads unpaginated compiler inventory without adding page or filter inputs', async () => {
    const api = transport();
    api.get.mockResolvedValue(response({ data: [] }));
    const compiler = action('compiler.list');
    expect(await probeJcbApiResource(api, apiConfig, compiler)).toBe(true);
    expect(api.get).toHaveBeenCalledWith(apiConfig, 'v1/componentbuilder/compiler', {});
    expect(() => resolveJcbApiRequest(compiler, { limit: 1 })).toThrow('does not accept');
  });

  it('retains the native status without disclosing credential-bearing API diagnostics', async () => {
    const api = transport();
    api.get.mockRejectedValue(new JoomlaApiError(403, { errors: [{ title: 'Rejected TEST_PRIVATE' }] }));
    let error: unknown;
    try {
      await readJcbApiAction(api, apiConfig, action('servers.get'), { id: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JoomlaApiError);
    expect(error).toMatchObject({ httpStatus: 403 });
    expect(String(error)).not.toContain('TEST_PRIVATE');
  });

  it('rejects creation when the installed source field is disabled', async () => {
    const api = transport();
    await expect(
      prepareJcbApiWrite(api, apiConfig, action('language_translations.create'), { data: { source: 'new text' } }),
    ).rejects.toThrow('disables source');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('checks independently returned GUID and numeric identity', async () => {
    const api = transport();
    const read = action('admin_views.get.guid');
    expect(resolveJcbApiRequest(read, { guid: key }).path).toBe('v1/componentbuilder/admin_views/guid/' + key);
    expect(() => resolveJcbApiRequest(read, { guid: 'invalid' })).toThrow();
    api.get.mockResolvedValue(item('7', { guid: '114dbb06-712d-49b5-a07c-ffd96725c07d' }, 'admin_views'));
    await expect(readJcbApiAction(api, apiConfig, read, { guid: key })).rejects.toThrow('different');
    const numeric = action('languages.get');
    expect(() => resolveJcbApiRequest(numeric, { id: 0 })).toThrow();
    expect(() => resolveJcbApiRequest(numeric, { id: '1/2' })).toThrow();
    api.get.mockResolvedValue(response({ data: { id: '7', type: 'languages', attributes: { id: '8' } } }));
    await expect(readJcbApiAction(api, apiConfig, numeric, { id: 7 })).rejects.toThrow('inconsistent');
  });

  it('checks collection format and withholds native credential values', async () => {
    const api = transport();
    const list = action('repositories.list');
    api.get.mockResolvedValue(response('<html>Joomla login</html>'));
    expect(await probeJcbApiResource(api, apiConfig, list)).toBe(false);
    api.get.mockResolvedValue(
      response({
        data: [{ id: '2', type: 'repositories', attributes: { token: 'secret', system_name: 'docs' } }],
      }),
    );
    expect(await probeJcbApiResource(api, apiConfig, list)).toBe(true);
    const out = await readJcbApiAction(api, apiConfig, list, {});
    expect(JSON.stringify(out)).toContain('docs');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('removes private server aliases, links, included records and relationship metadata from the wire result', async () => {
    const api = transport();
    const record = {
      type: 'servers',
      id: '1',
      attributes: {
        name: 'local',
        private_key: 'TEST_PRIVATE',
        private: 'TEST_PATH',
        signature: 'TEST_FTP',
        password: 'TEST_PASSWORD',
        secret: 'TEST_SECRET',
      },
      links: { self: 'https://example.invalid/?q=TEST_LINK' },
      relationships: {
        password: { data: { type: 'users', id: '1' } },
        created_by: {
          data: { type: 'users', id: '8', meta: { credential: 'TEST_META' } },
          links: { related: 'TEST_LINK' },
        },
      },
    };
    api.get.mockResolvedValue(
      response(
        { data: [record], included: [{ attributes: { name: 'TEST_SIDELOAD' } }], links: { next: 'TEST_NEXT' } },
        200,
        { location: 'TEST_HEADER' },
      ),
    );
    const output = await readJcbApiAction(api, apiConfig, action('servers.list'), { limit: 1 });
    expect(JSON.stringify(output)).not.toContain('TEST_');
    expect(output.data).toMatchObject({
      data: [
        {
          id: '1',
          attributes: { name: 'local' },
          relationships: { created_by: { data: { type: 'users', id: '8' } } },
        },
      ],
    });
    api.get.mockResolvedValue(response({ data: record }));
    expect(JSON.stringify(await readJcbApiAction(api, apiConfig, action('servers.get'), { id: 1 }))).not.toContain(
      'TEST_',
    );
  });

  it('returns credential write field names in plans and results, never their values or native headers', async () => {
    const api = transport();
    const edit = action('repositories.update');
    const old = item('7', { system_name: 'repo', token: 'TEST_OLD' }, 'repositories');
    const updated = item('7', { system_name: 'repo', token: 'TEST_NEW' }, 'repositories');
    api.get.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValueOnce(updated);
    api.request.mockResolvedValue(
      response({ data: { attributes: { token: 'TEST_NEW' } } }, 200, { location: 'TEST_HEADER' }),
    );
    const plan = await prepareJcbApiWrite(api, apiConfig, edit, { id: 7, data: { token: 'TEST_NEW' } });
    expect(plan.preview.fields).toEqual(['token']);
    expect(JSON.stringify(plan.preview)).not.toContain('TEST_');
    expect(plan.preview).not.toHaveProperty('preconditionFingerprint');
    const result = await applyJcbApiWrite(api, apiConfig, edit, plan, key);
    expect(result.verification.status).toBe('verified');
    expect(JSON.stringify(result)).not.toContain('TEST_');
  });

  it('rejects wrong JSON:API resource types even when the id matches', async () => {
    const api = transport();
    api.get.mockResolvedValue(item('7', { name: 'other' }, 'fields'));
    await expect(readJcbApiAction(api, apiConfig, action('languages.get'), { id: 7 })).rejects.toThrow(
      'resource type',
    );
    api.get.mockResolvedValue(response({ data: [{ id: '7', type: 'fields', attributes: { name: 'other' } }] }));
    expect(await probeJcbApiResource(api, apiConfig, action('languages.list'))).toBe(false);
  });

  it('refuses unregistered, authority and nested form fields', () => {
    const edit = action('languages.update');
    expect(() => resolveJcbApiRequest(edit, { id: 1, data: { not_a_field: 1 } })).toThrow();
    expect(() => resolveJcbApiRequest(edit, { id: 1, data: { rules: {} } })).toThrow();
    expect(() => resolveJcbApiRequest(edit, { id: 1, data: { id: 9 } })).toThrow();
    const translation = action('language_translations.update');
    expect(() => resolveJcbApiRequest(translation, { id: 1, data: { translation: [{ bogus: 'v' }] } })).toThrow(
      'bogus',
    );
    expect(() =>
      resolveJcbApiRequest(translation, {
        id: 1,
        data: { translation: [{ language: 'en-GB', translation: 'new text' }] },
      }),
    ).not.toThrow();
  });

  it('binds an association parent GUID only on create and verifies the same parent before and after dispatch', async () => {
    const api = transport();
    const create = action('components_updates.create');
    const parent = item('21', { guid: key }, 'joomla_components');
    const related = response({
      data: {
        id: '81',
        type: 'components_updates',
        attributes: {},
        relationships: { joomla_component: { data: { type: 'joomla_components', id: key } } },
      },
    });
    api.get.mockResolvedValueOnce(parent).mockResolvedValueOnce(parent).mockResolvedValueOnce(related);
    api.request.mockResolvedValue(response({ data: { type: 'components_updates', id: '81' } }, 201));
    const plan = await prepareJcbApiWrite(api, apiConfig, create, { data: { joomla_component: key } });
    expect(plan.preview.parent).toEqual({ resource: 'joomla_components', guid: key, id: '21' });
    expect((await applyJcbApiWrite(api, apiConfig, create, plan, key)).verification.status).toBe('verified');
    expect(api.get.mock.calls[0]?.[1]).toBe('v1/componentbuilder/joomla_components/guid/' + key);
    expect(() =>
      resolveJcbApiRequest(action('components_updates.update'), { id: 81, data: { joomla_component: key } }),
    ).toThrow('read-only');
    expect(() => resolveJcbApiRequest(create, { data: { joomla_component: 'wrong' } })).toThrow('GUID');
    expect(jcbInputSchema(create)).toHaveProperty('properties.data.properties.joomla_component.format', 'uuid');
    api.get.mockResolvedValue(item('42', { guid: key }, 'joomla_components'));
    await expect(applyJcbApiWrite(api, apiConfig, create, plan, key)).rejects.toThrow('parent');
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it('binds preconditions and verifies an independently read approved field', async () => {
    const api = transport();
    const edit = action('languages.update');
    const old = item('7', { name: 'Before' });
    const updated = item('7', { name: 'After' });
    api.get.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValueOnce(updated);
    api.request.mockResolvedValue(response(null, 204));
    const plan = await prepareJcbApiWrite(api, apiConfig, edit, { id: 7, data: { name: 'After' } });
    expect(plan.preview.fields).toEqual(['name']);
    expect(JSON.stringify(plan.preview)).not.toContain('After');
    const result = await applyJcbApiWrite(api, apiConfig, edit, plan, key);
    expect(api.request).toHaveBeenCalledExactlyOnceWith(apiConfig, {
      method: 'PATCH',
      path: 'v1/componentbuilder/languages/7',
      body: { name: 'After' },
      idempotencyKey: key,
    });
    expect(result.verification).toMatchObject({ status: 'verified', id: '7', fields: ['name'] });
  });

  it('stops stale approval before sending any write', async () => {
    const api = transport();
    const edit = action('languages.update');
    api.get
      .mockResolvedValueOnce(item('7', { name: 'old' }))
      .mockResolvedValueOnce(item('7', { name: 'changed' }));
    const plan = await prepareJcbApiWrite(api, apiConfig, edit, { id: 7, data: { name: 'requested' } });
    await expect(applyJcbApiWrite(api, apiConfig, edit, plan, key)).rejects.toThrow('changed');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('retains the original translation source while verifying nested translations', async () => {
    const api = transport();
    const edit = action('language_translations.update');
    const translation = [{ language: 'en-GB', translation: 'Text' }];
    const old = item('7', { source: 'FIXED_SOURCE', translation: [] }, 'language_translations');
    const saved = item(
      '7',
      { source: 'FIXED_SOURCE', translation: JSON.stringify(translation) },
      'language_translations',
    );
    api.get.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValueOnce(saved);
    api.request.mockResolvedValue(response(null, 204));
    const plan = await prepareJcbApiWrite(api, apiConfig, edit, { id: 7, data: { translation } });
    expect(plan.request.body).toEqual({ translation, source: null });
    expect(plan.preview.fields).toEqual(['translation']);
    expect((await applyJcbApiWrite(api, apiConfig, edit, plan, key)).verification.status).toBe('verified');
    await expect(prepareJcbApiWrite(api, apiConfig, edit, { id: 7, data: { source: 'mutated' } })).rejects.toThrow(
      'read-only',
    );
  });

  it('requires independent confirmation of accepted creates, without following response URLs', async () => {
    const api = transport();
    const create = action('languages.create');
    const plan = await prepareJcbApiWrite(api, apiConfig, create, { data: { name: 'Example', langtag: 'xx-AB' } });
    api.request.mockResolvedValue(
      response(null, 201, { location: 'https://foreign.example/api/index.php/v1/componentbuilder/languages/11' }),
    );
    expect((await applyJcbApiWrite(api, apiConfig, create, plan, key)).verification.status).toBe('uncertain');
    expect(api.get).not.toHaveBeenCalled();
    api.request.mockResolvedValue(
      response(null, 201, {
        location: 'https://cms.example/joomla/api/index.php/v1/componentbuilder/languages/11',
      }),
    );
    api.get.mockResolvedValue(item('11', { name: 'Other', langtag: 'xx-AB' }));
    expect((await applyJcbApiWrite(api, apiConfig, create, plan, key)).verification).toMatchObject({
      status: 'uncertain',
      id: '11',
    });
  });

  it('keeps ambiguous effects uncertain and verifies native deletes independently', async () => {
    const api = transport();
    const remove = action('languages.delete');
    const existing = item('7', { name: 'old' });
    api.get
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(existing)
      .mockRejectedValueOnce(new JoomlaApiError(404, null))
      .mockResolvedValueOnce(response({ data: [] }));
    api.request.mockResolvedValue(response(null, 204));
    const plan = await prepareJcbApiWrite(api, apiConfig, remove, { id: 7 });
    expect((await applyJcbApiWrite(api, apiConfig, remove, plan, key)).verification).toMatchObject({
      status: 'verified',
      id: '7',
    });
    api.get.mockResolvedValue(existing);
    api.request.mockRejectedValue(new Error('remote response dropped'));
    expect((await applyJcbApiWrite(api, apiConfig, remove, plan, key)).verification.status).toBe('uncertain');
  });
});
