import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PermissionGrantService } from '../src/security/permission-grant-service.js';

const secret = 'a-secret-that-is-at-least-32-bytes-long';
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe('PermissionGrantService', () => {
  it('requires the exact operator phrase and binds the request to its principal', () => {
    const service = new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      allowIndefinite: false,
    });
    const request = service.request({
      site: 'production',
      toolsets: ['content.write', 'users.admin'],
      duration: '30-minutes',
      reason: 'Publish content and create its author.',
    }, 'remote:issuer:alice:client');

    expect(request.acknowledgement).toContain('30 MINUTES');
    expect(() => service.approve(
      request.requestId,
      request.acknowledgement,
      'remote:issuer:bob:client',
    )).toThrow('another authenticated principal');
    expect(() => service.approve(
      request.requestId,
      `${request.acknowledgement} `,
      'remote:issuer:alice:client',
    )).toThrow('exactly match');
    const grant = service.approve(
      request.requestId,
      request.acknowledgement,
      'remote:issuer:alice:client',
    );
    expect(grant).toMatchObject({
      site: 'production',
      duration: '30-minutes',
      remainingUses: null,
    });
  });

  it('consumes a one-operation grant exactly once', () => {
    const service = new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      allowIndefinite: false,
    });
    const request = service.request({
      site: 'production',
      toolsets: ['extensions.admin'],
      duration: 'once',
      reason: 'Install the reviewed module package.',
    }, 'local-stdio');
    const grant = service.approve(request.requestId, request.acknowledgement, 'local-stdio');

    expect(service.authorize('local-stdio', 'production', 'extensions.admin').id).toBe(grant.id);
    expect(service.consume(grant.id, 'local-stdio', 'production', 'extensions.admin').remainingUses).toBe(0);
    expect(() => service.consume(grant.id, 'local-stdio', 'production', 'extensions.admin')).toThrow(
      'no longer authorizes',
    );
  });

  it('expires 30-minute grants and never lets a grant expand its site or toolset', () => {
    let now = 1_000;
    const service = new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      allowIndefinite: false,
    }, () => now);
    const request = service.request({
      site: 'production',
      toolsets: ['content.write'],
      duration: '30-minutes',
      reason: 'Complete the editorial batch.',
    }, 'local-stdio');
    const grant = service.approve(request.requestId, request.acknowledgement, 'local-stdio');

    expect(() => service.consume(grant.id, 'local-stdio', 'staging', 'content.write')).toThrow();
    expect(() => service.consume(grant.id, 'local-stdio', 'production', 'users.admin')).toThrow();
    now += 1_800_001;
    expect(service.list('local-stdio')).toEqual([]);
  });

  it('persists signed indefinite grants and fails closed after store tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joomla-mcp-grants-'));
    temporary.push(directory);
    const storePath = join(directory, 'grants.json');
    const first = new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      storePath,
      allowIndefinite: true,
    });
    const request = first.request({
      site: 'production',
      toolsets: ['maintenance.admin'],
      duration: 'indefinite',
      reason: 'Allow the in-house maintenance agent until revoked.',
    }, 'local-stdio');
    const grant = first.approve(request.requestId, request.acknowledgement, 'local-stdio');
    const second = new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      storePath,
      allowIndefinite: true,
    });

    expect(second.list('local-stdio')).toContainEqual(grant);
    expect((await readFile(storePath, 'utf8'))).not.toContain('local-stdio');

    const document = JSON.parse(await readFile(storePath, 'utf8')) as {
      grants: Array<{ site: string }>;
    };
    document.grants[0]!.site = 'staging';
    await writeFile(storePath, JSON.stringify(document), { mode: 0o600 });
    await chmod(storePath, 0o600);
    expect(() => new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      storePath,
      allowIndefinite: true,
    })).toThrow('integrity validation');
  });

  it('rejects indefinite permission when the operator disabled it', () => {
    const service = new PermissionGrantService({
      secret,
      requestTtlMs: 300_000,
      allowIndefinite: false,
    });

    expect(() => service.request({
      site: 'production',
      toolsets: ['configuration.write'],
      duration: 'indefinite',
      reason: 'Keep configuration management enabled.',
    }, 'local-stdio')).toThrow('disabled');
  });
});
