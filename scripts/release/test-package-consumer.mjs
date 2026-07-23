import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'joomla-mcp-consumer-'));
const npmCache = process.env['NPM_CONFIG_CACHE'] ?? join(tmpdir(), 'joomla-mcp-npm-cache');
mkdirSync(npmCache, { recursive: true });

try {
  const pack = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', workspace], root);
  const tarballName = JSON.parse(pack.stdout)[0].filename;
  const tarball = join(workspace, tarballName);
  const consumer = join(workspace, 'consumer');
  mkdirSync(consumer);

  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({
      name: 'joomla-mcp-package-consumer-test',
      version: '1.0.0',
      private: true,
      type: 'module',
    }, null, 2)}\n`,
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    consumer,
  );
  assert(existsSync(join(consumer, 'node_modules/.bin/joomla-mcp')), 'Missing joomla-mcp binary.');
  assert(
    existsSync(join(consumer, 'node_modules/.bin/joomla-mcp-http')),
    'Missing joomla-mcp-http binary.',
  );

  writeFileSync(join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict';
import {
  JOOMLA_MCP_PACKAGE_NAME,
  JOOMLA_MCP_VERSION,
  createJoomlaMcp,
  resolveConfiguration,
} from '@joomengine/joomla-mcp';
import { publicCatalog } from '@joomengine/joomla-mcp/catalog';
import { ToolsetSchema } from '@joomengine/joomla-mcp/config';
import { JwksJwtVerifier } from '@joomengine/joomla-mcp/security';
import { JoomlaApiClient } from '@joomengine/joomla-mcp/adapters';
import { createRemoteHttpServer } from '@joomengine/joomla-mcp/http';

assert.equal(JOOMLA_MCP_PACKAGE_NAME, '@joomengine/joomla-mcp');
assert.equal(JOOMLA_MCP_VERSION, '${JSON.parse(readFileSync('package.json', 'utf8')).version}');
assert.equal(typeof createJoomlaMcp, 'function');
assert.equal(typeof resolveConfiguration, 'function');
assert.equal(typeof publicCatalog, 'function');
assert.equal(typeof ToolsetSchema.parse, 'function');
assert.equal(typeof JwksJwtVerifier, 'function');
assert.equal(typeof JoomlaApiClient, 'function');
assert.equal(typeof createRemoteHttpServer, 'function');

const configuration = {
  defaultSite: 'example',
  sites: new Map([['example', {
    id: 'example',
    toolsets: new Set(['discovery']),
    api: {
      baseUrl: 'https://joomla.example',
      tokenEnv: 'JOOMLA_TOKEN',
      token: 'not-used-by-this-test',
      timeoutMs: 30_000,
      maxResponseBytes: 5_242_880,
      maxPageSize: 100,
    },
  }]]),
};
const application = createJoomlaMcp({ configuration, server: { localPrincipal: 'consumer-test' } });
assert.equal(typeof application.createServer, 'function');
assert.equal(typeof application.createHttpServer, 'function');
`);
  run(process.execPath, ['verify.mjs'], consumer);

  writeFileSync(join(consumer, 'verify.ts'), `
import {
  createJoomlaMcp,
  type AuditSink,
  type Configuration,
  type JoomlaMcpApplication,
} from '@joomengine/joomla-mcp';
import type { JoomlaApiResponse } from '@joomengine/joomla-mcp/adapters';
import type { AuthorizedPrincipal } from '@joomengine/joomla-mcp/http';

const configuration: Configuration = {
  defaultSite: 'example',
  sites: new Map([['example', {
    id: 'example',
    toolsets: new Set(['discovery']),
    api: {
      baseUrl: 'https://joomla.example',
      tokenEnv: 'JOOMLA_TOKEN',
      token: 'not-used-by-this-test',
      timeoutMs: 30_000,
      maxResponseBytes: 5_242_880,
      maxPageSize: 100,
    },
  }]]),
};
const audit: AuditSink = { write: async () => undefined };
const application: JoomlaMcpApplication = createJoomlaMcp({
  configuration,
  runtimeOptions: { audit },
});
const response: JoomlaApiResponse | undefined = undefined;
const principal: AuthorizedPrincipal | undefined = undefined;
void application;
void response;
void principal;
`);
  writeFileSync(join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    },
    include: ['verify.ts'],
  }, null, 2)}\n`);
  run(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    consumer,
  );

  process.stdout.write('Installed package passed JavaScript and TypeScript consumer tests.\n');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}:\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
