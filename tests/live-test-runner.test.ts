import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  entityFromMutation,
  liveTestExitCode,
  mediaAdapterSelector,
  mediaDirectoryPath,
  mediaUpdateRoutePath,
  normalizeCreatedMediaPath,
  runLiveTest,
  specialWritePriority,
} from '../src/live-test/runner.js';

describe('live-test runner', () => {
  it('ignores companion correlation ids when extracting a created resource', () => {
    const entity = entityFromMutation({
      preview: { dryRun: true },
      plan: { confirmationToken: 'redacted' },
      applied: {
        site: 'fixture',
        action: 'content.categories.create',
        idempotencyKey: 'dd93ca39-0b39-44d5-9798-03cc6e506de0',
        mutation: {
          protocol: 'joomla-mcp/1',
          id: '0c3348c7-49aa-4b06-a232-2df6a7774901',
          action: 'content.categories.create',
          ok: true,
          data: {
            result: {
              id: 41,
              item: { id: 41, title: 'Live fixture category' },
            },
          },
        },
      },
    }, { title: 'Live fixture category' });

    expect(entity).toMatchObject({
      id: 41,
      label: 'Live fixture category',
    });
  });

  it('uses the exact recovered entity after a persisted create reports an upstream error', () => {
    const entity = entityFromMutation({
      upstreamError: { message: 'HTTP 404' },
      recoveryVerification: {
        data: [
          { id: '1', attributes: { subject: 'Earlier message' } },
          { id: '2', attributes: { subject: 'Recovered message' } },
        ],
      },
      result: {
        id: '2',
        attributes: { subject: 'Recovered message' },
      },
    }, { subject: 'Recovered message' });

    expect(entity).toMatchObject({
      id: '2',
      label: 'Recovered message',
    });
  });

  it('normalizes Joomla media paths without dropping the adapter separator', () => {
    expect(normalizeCreatedMediaPath('local-images:/./fixture.png'))
      .toBe('local-images:/fixture.png');
    expect(normalizeCreatedMediaPath('local-images:/fixture.png'))
      .toBe('local-images:/fixture.png');
  });

  it('uses a default-adapter directory-relative path for Joomla media content updates', () => {
    expect(mediaUpdateRoutePath('local-images:/live-run/fixture.png')).toBe('live-run/fixture.png');
    expect(mediaUpdateRoutePath('folder/fixture.png')).toBe('folder/fixture.png');
  });

  it('selects the created file adapter without requesting a media move', () => {
    expect(mediaAdapterSelector('local-images:/live-run/fixture.png')).toBe('local-images:');
    expect(() => mediaAdapterSelector('live-run/fixture.png'))
      .toThrow('Media fixture path must identify its adapter');
  });

  it('derives the adapter-qualified directory used by the media fixture', () => {
    expect(mediaDirectoryPath('local-images:/live-run/fixture.png')).toBe('local-images:live-run');
    expect(mediaDirectoryPath('live-run/fixture.png')).toBe('live-run');
    expect(() => mediaDirectoryPath('local-images:/fixture.png'))
      .toThrow('Media fixture path must include a directory');
  });

  it('changes scheduler state before running the selected task', () => {
    expect(specialWritePriority('scheduler.tasks.state.set'))
      .toBeLessThan(specialWritePriority('scheduler.tasks.run'));
  });

  it('prepares, notifies, and finalizes a Joomla Update in dependency order', () => {
    expect(specialWritePriority('joomla-update.prepare'))
      .toBeLessThan(specialWritePriority('joomla-update.notification.success'));
    expect(specialWritePriority('joomla-update.notification.failed'))
      .toBeLessThan(specialWritePriority('joomla-update.finalize'));
  });

  it('fails complete disposable certification when any prerequisite remains blocked', () => {
    const counts = {
      PASS: 100,
      FAIL: 0,
      EXPECTED_DENIAL: 0,
      KNOWN_UPSTREAM_LIMITATION: 0,
      SOURCE_ONLY_GATED: 0,
      BLOCKED_BY_PREREQUISITE: 1,
      CLEANUP_FAILED: 0,
    } as const;

    expect(liveTestExitCode({
      profile: 'full',
      disposable: true,
      families: [],
    }, counts)).toBe(1);
    expect(liveTestExitCode({
      profile: 'read',
      disposable: false,
      families: [],
    }, counts)).toBe(0);
  });

  it('runs catalogue CRUD through the real HTTP MCP gateway and Joomla API adapter', async () => {
    const resources = new Map<string, Map<number, Record<string, unknown>>>([
      ['v1/content/categories', new Map()],
      ['v1/content/articles', new Map()],
    ]);
    let nextId = 10;
    const server = createServer((request, response) => void handle(request, response, resources, () => ++nextId));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const directory = await mkdtemp(join(tmpdir(), 'joomla-mcp-live-runner-'));
    const configurationFile = join(directory, 'sites.json');
    await writeFile(configurationFile, `${JSON.stringify({
      defaultSite: 'fixture',
      approval: {
        secretEnv: 'LIVE_TEST_APPROVAL_SECRET',
        ttlMs: 300000,
        requestTtlMs: 300000,
      },
      sites: {
        fixture: {
          toolsets: ['discovery', 'content.read', 'content.write', 'structure.read', 'structure.write'],
          api: {
            baseUrl: `http://127.0.0.1:${port}`,
            tokenEnv: 'LIVE_TEST_API_TOKEN',
            allowInsecureLoopback: true,
          },
        },
      },
    }, null, 2)}\n`);
    const oldToken = process.env['LIVE_TEST_API_TOKEN'];
    const oldApproval = process.env['LIVE_TEST_APPROVAL_SECRET'];
    process.env['LIVE_TEST_API_TOKEN'] = 'fixture-token';
    process.env['LIVE_TEST_APPROVAL_SECRET'] = 'fixture-approval-secret-with-at-least-32-characters';

    try {
      const summary = await runLiveTest({
        configurationFile,
        site: 'fixture',
        outputDirectory: join(directory, 'evidence'),
        profile: 'crud',
        joomlaPaths: ['api'],
        mcpTransports: ['http'],
        families: ['content'],
        nonInteractive: true,
        confirmMutations: true,
        disposable: true,
        cleanup: true,
        retainDemo: false,
        failFast: false,
        seed: 'unit-test',
      });

      expect(summary.exitCode).toBe(0);
      expect(summary.counts.FAIL).toBe(0);
      expect(summary.counts.CLEANUP_FAILED).toBe(0);
      expect(summary.counts.PASS).toBeGreaterThanOrEqual(14);
      expect(resources.get('v1/content/articles')?.size).toBe(0);
      expect(resources.get('v1/content/categories')?.size).toBe(0);
      expect(await readFile(join(directory, 'evidence', 'summary.md'), 'utf8')).toContain('Result: **PASS**');
    } finally {
      if (oldToken === undefined) delete process.env['LIVE_TEST_API_TOKEN'];
      else process.env['LIVE_TEST_API_TOKEN'] = oldToken;
      if (oldApproval === undefined) delete process.env['LIVE_TEST_APPROVAL_SECRET'];
      else process.env['LIVE_TEST_APPROVAL_SECRET'] = oldApproval;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('writes actionable evidence when the harness fails before a session is ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joomla-mcp-live-fatal-'));
    const joomlaRoot = join(directory, 'joomla');
    await mkdir(join(joomlaRoot, 'cli'), { recursive: true });
    await writeFile(join(joomlaRoot, 'cli', 'joomla.php'), '<?php\n');
    const configurationFile = join(directory, 'sites.json');
    await writeFile(configurationFile, `${JSON.stringify({
      defaultSite: 'fixture',
      sites: {
        fixture: {
          toolsets: ['discovery'],
          cli: {
            root: joomlaRoot,
            phpBinary: process.execPath,
          },
        },
      },
    }, null, 2)}\n`);

    const summary = await runLiveTest({
      configurationFile,
      site: 'fixture',
      outputDirectory: join(directory, 'evidence'),
      profile: 'read',
      joomlaPaths: ['cli'],
      mcpTransports: ['stdio'],
      families: [],
      nonInteractive: true,
      confirmMutations: false,
      disposable: false,
      cleanup: false,
      retainDemo: false,
      failFast: false,
      seed: 'fatal-evidence',
      stdioCommand: join(directory, 'missing-mcp-command'),
      stdioArguments: [],
    });

    expect(summary.exitCode).toBe(1);
    expect(summary.counts.FAIL).toBe(1);
    expect(summary.attempts[0]).toMatchObject({
      scenarioId: 'live-test.harness',
      phase: 'harness',
      status: 'FAIL',
      mcpTransport: 'stdio',
      joomlaPath: 'cli',
    });
    const report = await readFile(join(directory, 'evidence', 'summary.md'), 'utf8');
    expect(report).toContain('`live-test.harness`');
    expect(report).toContain('--mcp-transport');
  });
});

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  resources: Map<string, Map<number, Record<string, unknown>>>,
  nextId: () => number,
): Promise<void> {
  if (request.headers.authorization !== 'Bearer fixture-token') {
    json(response, 401, { errors: [{ detail: 'unauthorized' }] });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://fixture');
  const route = url.pathname.replace('/api/index.php/', '');
  const collection = [...resources.keys()].find((candidate) =>
    route === candidate || route.startsWith(`${candidate}/`));
  if (collection === undefined) {
    json(response, 404, { errors: [{ detail: `unknown route ${route}` }] });
    return;
  }
  const records = resources.get(collection)!;
  const suffix = route.slice(collection.length).replace(/^\//u, '');
  const id = suffix === '' ? undefined : Number(suffix);

  if (request.method === 'GET' && id === undefined) {
    json(response, 200, {
      data: [...records.entries()].map(([recordId, attributes]) => ({ id: String(recordId), attributes })),
    });
    return;
  }
  if (request.method === 'GET' && Number.isSafeInteger(id)) {
    const attributes = records.get(id!);
    if (attributes === undefined) {
      json(response, 404, { errors: [{ detail: 'not found' }] });
      return;
    }
    json(response, 200, { data: { id: String(id), attributes } });
    return;
  }
  if (request.method === 'POST') {
    const body = await bodyRecord(request);
    const recordId = nextId();
    records.set(recordId, body);
    json(response, 201, { data: { id: String(recordId), attributes: body } });
    return;
  }
  if (request.method === 'PATCH' && Number.isSafeInteger(id)) {
    const current = records.get(id!);
    if (current === undefined) {
      json(response, 404, { errors: [{ detail: 'not found' }] });
      return;
    }
    const body = await bodyRecord(request);
    const updated = { ...current, ...body };
    records.set(id!, updated);
    json(response, 200, { data: { id: String(id), attributes: updated } });
    return;
  }
  if (request.method === 'DELETE' && Number.isSafeInteger(id)) {
    records.delete(id!);
    response.writeHead(204);
    response.end();
    return;
  }
  json(response, 405, { errors: [{ detail: 'method not allowed' }] });
}

async function bodyRecord(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/vnd.api+json' });
  response.end(JSON.stringify(value));
}
