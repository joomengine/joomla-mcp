import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfiguration } from '../src/config/load.js';
import { selectExtensionStateFixture } from '../src/live-test/runner.js';
import { createHttpLiveSession, createStdioLiveSession } from '../src/live-test/transports.js';
import type { LiveMcpSession } from '../src/live-test/types.js';

// This fixture replaces Joomla, not the MCP service or its input normalizer.
// Each transport traverses the real tool, service, capability and CLI dispatch layers.
describe('extension filtering over live MCP transports', () => {
  it.each(['stdio', 'http'] as const)('routes filtered fixture reads over %s and rejects invalid inputs before dispatch', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'joomla-mcp-extension-filter-'));
    let session: LiveMcpSession | undefined;
    try {
      await mkdir(join(root, 'cli'));
      const dispatchLog = join(root, 'dispatch.jsonl');
      const plugin = {
        extensionId: 501, type: 'plugin', element: 'optional', folder: 'content',
        name: 'Optional content plugin', enabled: false, protected: false,
      };
      await writeFile(join(root, 'cli', 'joomla.php'), `
        const fs = require('node:fs');
        if (process.argv.includes('joomla:mcp:describe')) {
          console.log(JSON.stringify({ protocol: 'joomla-mcp/1', ok: true,
            actions: [{ name: 'extensions.list', effective: { allowed: true } }] }));
        } else {
          let body = '';
          process.stdin.on('data', chunk => body += chunk);
          process.stdin.on('end', () => {
            const request = JSON.parse(body);
            fs.appendFileSync(${JSON.stringify(dispatchLog)}, JSON.stringify(request) + '\\n');
            console.log(JSON.stringify({ protocol: 'joomla-mcp/1', ok: true, id: request.id,
              data: { items: [${JSON.stringify(plugin)}] } }));
          });
        }
      `);
      const configurationFile = join(root, 'sites.json');
      await writeFile(configurationFile, JSON.stringify({
        defaultSite: 'fixture',
        sites: { fixture: {
          toolsets: ['discovery', 'extensions.read'],
          cli: { root, phpBinary: process.execPath },
        } },
      }));
      session = kind === 'stdio'
        ? await createStdioLiveSession({
          configurationFile,
          arguments: ['--import', 'tsx', fileURLToPath(new URL('../src/bin/joomla-mcp.ts', import.meta.url))],
        })
        : await createHttpLiveSession(await loadConfiguration(configurationFile));
      const read = (input: Readonly<Record<string, unknown>>) => session!.call({
        name: 'joomla_action_read',
        arguments: { site: 'fixture', action: 'extensions.list', transport: 'cli', input },
      });

      const fixture = await selectExtensionStateFixture(read);
      expect(fixture).toMatchObject({ id: 501, attributes: { enabled: false, protected: false } });
      const requests = (await readFile(dispatchLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(requests).toEqual([expect.objectContaining({
        protocol: 'joomla-mcp/1', action: 'extensions.list',
        input: { type: 'plugin', offset: 0, limit: 100 },
      })]);

      for (const input of [{ type: 'plugins' }, { type: true }, { type: 'plugin', folder: 'content' }]) {
        await expect(read(input)).rejects.toThrow();
      }
      expect((await readFile(dispatchLog, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
