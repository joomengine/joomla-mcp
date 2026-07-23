import { describe, expect, it } from 'vitest';

import {
  ConfirmationService,
  SiteWriteLock,
  type PlannedOperation,
} from '../src/security/confirmation-service.js';

const operation: PlannedOperation = {
  site: 'production',
  action: 'content.articles.create',
  method: 'POST',
  path: 'v1/content/articles',
  body: { title: 'A title', catid: 2 },
  idempotencyKey: '9782a1c5-f86f-4d05-a4f4-a21e175faa70',
  summary: 'Create article “A title” in category 2.',
};

describe('ConfirmationService', () => {
  it('creates a signed, one-time confirmation without placing the body in plaintext', () => {
    const service = new ConfirmationService('a-secret-that-is-at-least-32-bytes-long', 60_000);
    const plan = service.create(operation);

    expect(plan.confirmationToken).not.toContain('A title');
    expect(service.consume(plan.confirmationToken)).toEqual(operation);
    expect(() => service.consume(plan.confirmationToken)).toThrow('already been used');
  });

  it('rejects tampering and expiration', () => {
    let now = 1_000;
    const service = new ConfirmationService('a-secret-that-is-at-least-32-bytes-long', 30_000, () => now);
    const plan = service.create(operation);

    expect(() => service.consume(`${plan.confirmationToken}x`)).toThrow('signature');
    now = 31_001;
    expect(() => service.consume(plan.confirmationToken)).toThrow('expired');
  });

  it('binds a plan to its principal and authorizes before consuming it', () => {
    const service = new ConfirmationService('a-secret-that-is-at-least-32-bytes-long', 60_000);
    const plan = service.create(operation, 'issuer:subject:client-a');

    expect(() => service.consume(plan.confirmationToken, 'issuer:subject:client-b')).toThrow('does not match');
    expect(() => service.consume(plan.confirmationToken, 'issuer:subject:client-a', () => {
      throw new Error('scope revoked');
    })).toThrow('scope revoked');
    expect(service.consume(plan.confirmationToken, 'issuer:subject:client-a')).toEqual(operation);
  });
});

describe('SiteWriteLock', () => {
  it('serializes writes by rejecting overlapping operations for the same site', async () => {
    const lock = new SiteWriteLock();
    let release: (() => void) | undefined;
    const first = lock.run('production', async () => new Promise<void>((resolve) => (release = resolve)));

    await expect(lock.run('production', async () => undefined)).rejects.toThrow('already in progress');
    await expect(lock.run('staging', async () => 'ok')).resolves.toBe('ok');
    release?.();
    await first;
  });
});
