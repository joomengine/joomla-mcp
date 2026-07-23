import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { JoomlaCliClient } from '../src/infrastructure/cli/joomla-cli-client.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (path) => rm(path, { force: true, recursive: true })));
});

describe('JoomlaCliClient', () => {
  it('spawns a fixed executable and launcher without a shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joomla-mcp-'));
    temporary.push(root);
    const launcher = join(root, 'cli/joomla.php');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, 'console.log(process.argv.slice(2).join(" "));\n', 'utf8');
    await chmod(launcher, 0o644);
    const node = process.execPath;

    const result = await new JoomlaCliClient().list({
      root,
      phpBinary: node,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('list --no-interaction --no-ansi');
    expect(result.command).toEqual([node, launcher, 'list', '--no-interaction', '--no-ansi']);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('uses Joomla help to describe one validated command without executing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joomla-mcp-'));
    temporary.push(root);
    const launcher = join(root, 'cli/joomla.php');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, 'console.log(process.argv.slice(2).join(" "));\n', 'utf8');
    const client = new JoomlaCliClient();
    const config = { root, phpBinary: process.execPath, timeoutMs: 10_000, maxOutputBytes: 10_000 };

    const result = await client.help(config, 'componentbuilder:get:admin_view');

    expect(result.stdout.trim()).toBe(
      'help componentbuilder:get:admin_view --no-interaction --no-ansi',
    );
    expect(() => client.help(config, 'site:down;touch /tmp/escaped')).toThrow('Invalid Joomla CLI command');
    expect(() => client.help(config, '../configuration.php')).toThrow('Invalid Joomla CLI command');
  });

  it('sends companion actions and secrets over stdin rather than process arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joomla-mcp-'));
    temporary.push(root);
    const launcher = join(root, 'cli/joomla.php');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(
      launcher,
      'let body=""; process.stdin.on("data", c => body += c); process.stdin.on("end", () => console.log(JSON.stringify({protocol:"joomla-mcp/1",ok:true,result:{args: process.argv.slice(2),request: JSON.parse(body)}})));\n',
      'utf8',
    );
    const client = new JoomlaCliClient();
    const result = await client.dispatch(
      { root, phpBinary: process.execPath, timeoutMs: 10_000, maxOutputBytes: 10_000 },
      'users.password.reset',
      { password: 'stdin-only-secret' },
    );

    expect(result.command.join(' ')).not.toContain('stdin-only-secret');
    expect(result.data).toMatchObject({ result: { request: { action: 'users.password.reset' } } });
    expect(JSON.stringify(result.data)).toContain('stdin-only-secret');
  });

  it('requests the fixed structured Joomla CLI inventory command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'joomla-mcp-'));
    temporary.push(root);
    const launcher = join(root, 'cli/joomla.php');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(
      launcher,
      'console.log(JSON.stringify({protocol:"joomla-mcp/1",ok:true,commandCount:1,namespaces:[],commands:[]}));\n',
      'utf8',
    );

    const result = await new JoomlaCliClient().inventory({
      root,
      phpBinary: process.execPath,
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });

    expect(result.command.slice(2)).toEqual([
      'joomla:mcp:cli-inventory',
      '--format=json',
      '--no-interaction',
      '--no-ansi',
    ]);
    expect(result.data).toMatchObject({ protocol: 'joomla-mcp/1', ok: true, commandCount: 1 });
  });
});
