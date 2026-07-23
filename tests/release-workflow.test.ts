import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('release workflow', () => {
  it('accepts an explicit matching version from main', () => {
    const result = verify({
      RELEASE_EVENT: 'workflow_dispatch',
      RELEASE_INPUT_VERSION: '0.5.0',
      RELEASE_INPUT_PRERELEASE: 'false',
      RELEASE_REF: 'refs/heads/main',
      RELEASE_REF_NAME: 'main',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: '0.5.0',
      tag: 'v0.5.0',
      prerelease: false,
    });
  });

  it('accepts a matching SemVer tag and infers prerelease state', () => {
    const result = verify({
      RELEASE_EVENT: 'push',
      RELEASE_REF: 'refs/tags/v0.5.0',
      RELEASE_REF_NAME: 'v0.5.0',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ tag: 'v0.5.0', prerelease: false });
  });

  it('rejects manual releases from non-main refs and mismatched versions', () => {
    expect(verify({
      RELEASE_EVENT: 'workflow_dispatch',
      RELEASE_INPUT_VERSION: '0.5.0',
      RELEASE_REF: 'refs/heads/feature',
      RELEASE_REF_NAME: 'feature',
    }).stderr).toContain('main branch');

    expect(verify({
      RELEASE_EVENT: 'workflow_dispatch',
      RELEASE_INPUT_VERSION: '9.9.9',
      RELEASE_REF: 'refs/heads/main',
      RELEASE_REF_NAME: 'main',
    }).stderr).toContain('must match');
  });

  it('publishes every required self-hosted artifact class', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('already_released');
    expect(workflow).toContain('already points to');
    expect(workflow).toContain('already exists');
    expect(workflow).toContain('joomengine-mcp-for-joomla-${RELEASE_TAG}.tgz');
    expect(workflow).toContain('joomengine-mcp-for-joomla-deployment-${RELEASE_TAG}.tar.gz');
    expect(workflow).toContain('pkg_joomlamcp-*.zip');
    expect(workflow).toContain('.spdx.json');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('attest-build-provenance@v4');
  });
});

function verify(environment: Readonly<Record<string, string>>) {
  return spawnSync(process.execPath, ['scripts/release/verify-version.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  });
}
