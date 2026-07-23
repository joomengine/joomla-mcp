import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { CliConfig } from '../../config/schema.js';

export interface CliEnvelope {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface CompanionEnvelope extends CliEnvelope {
  readonly data: unknown;
}

export interface JoomlaCliTransport {
  list(config: CliConfig): Promise<CliEnvelope>;
  help(config: CliConfig, command: string): Promise<CliEnvelope>;
  describe(config: CliConfig): Promise<CompanionEnvelope>;
  inventory(config: CliConfig): Promise<CompanionEnvelope>;
  dispatch(
    config: CliConfig,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CompanionEnvelope>;
}

export class JoomlaCliClient implements JoomlaCliTransport {
  public list(config: CliConfig): Promise<CliEnvelope> {
    return this.execute(config, ['list', '--no-interaction', '--no-ansi']);
  }

  public help(config: CliConfig, command: string): Promise<CliEnvelope> {
    if (!/^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/.test(command) || command.length > 128) {
      throw new Error('Invalid Joomla CLI command identifier.');
    }

    return this.execute(config, ['help', command, '--no-interaction', '--no-ansi']);
  }

  public async describe(config: CliConfig): Promise<CompanionEnvelope> {
    const envelope = await this.executeJson(config, [
      'joomla:mcp:describe',
      '--format=json',
      '--no-interaction',
      '--no-ansi',
    ]);
    assertProtocol(envelope.data);
    return envelope;
  }

  public async inventory(config: CliConfig): Promise<CompanionEnvelope> {
    const envelope = await this.executeJson(config, [
      'joomla:mcp:cli-inventory',
      '--format=json',
      '--no-interaction',
      '--no-ansi',
    ]);
    const response = assertProtocol(envelope.data);

    if (response['ok'] !== true) {
      throw new Error('Joomla companion CLI inventory failed.');
    }

    return envelope;
  }

  public async dispatch(
    config: CliConfig,
    action: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CompanionEnvelope> {
    if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(action) || action.length > 128) {
      throw new Error('Invalid Joomla companion action identifier.');
    }

    const stdin = JSON.stringify({ protocol: 'joomla-mcp/1', id: randomUUID(), action, input });

    if (Buffer.byteLength(stdin, 'utf8') > 1_048_576) {
      throw new Error('Joomla companion request exceeds the 1048576-byte limit.');
    }

    const envelope = await this.executeJson(
      config,
      ['joomla:mcp:dispatch', '--input=-', '--format=json', '--no-interaction', '--no-ansi'],
      stdin,
    );
    const response = assertProtocol(envelope.data);

    if (response['ok'] !== true) {
      const error = asRecord(response['error']);
      const code = typeof error['code'] === 'string' ? error['code'] : 'ACTION_FAILED';
      const message = typeof error['message'] === 'string' ? error['message'] : 'The Joomla companion action failed.';
      throw new Error(`Joomla companion ${code}: ${message}`);
    }

    return envelope;
  }

  private async executeJson(config: CliConfig, args: readonly string[], stdin?: string): Promise<CompanionEnvelope> {
    const envelope = await this.execute(config, args, stdin);

    if (envelope.exitCode !== 0 || envelope.timedOut || envelope.truncated) {
      throw new Error(
        `Joomla companion failed (exit ${envelope.exitCode}, timeout=${envelope.timedOut}, truncated=${envelope.truncated}).`,
      );
    }

    try {
      return { ...envelope, data: JSON.parse(envelope.stdout) as unknown };
    } catch {
      throw new Error('Joomla companion returned malformed JSON.');
    }
  }

  private execute(config: CliConfig, args: readonly string[], stdin?: string): Promise<CliEnvelope> {
    const launcher = resolve(config.root, 'cli/joomla.php');
    const command = [config.phpBinary, launcher, ...args];
    const started = performance.now();

    return new Promise((resolvePromise, reject) => {
      const child = spawn(config.phpBinary, [launcher, ...args], {
        cwd: config.root,
        env: minimalEnvironment(),
        shell: false,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;

      if (child.stdout === null || child.stderr === null || (stdin !== undefined && child.stdin === null)) {
        child.kill('SIGTERM');
        reject(new Error('Unable to open the required Joomla CLI process streams.'));
        return;
      }

      const childStdout = child.stdout;
      const childStderr = child.stderr;
      const childStdin = child.stdin;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      }, config.timeoutMs);
      timer.unref();

      childStdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;

        if (stdoutBytes <= config.maxOutputBytes) {
          stdout.push(chunk);
        } else {
          truncated = true;
          child.kill('SIGTERM');
        }
      });
      childStderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;

        if (stderrBytes <= config.maxOutputBytes) {
          stderr.push(chunk);
        } else {
          truncated = true;
          child.kill('SIGTERM');
        }
      });

      if (stdin !== undefined) {
        childStdin?.end(stdin, 'utf8');
      }
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Unable to start Joomla CLI: ${error.message}`));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolvePromise({
          command,
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: Math.round(performance.now() - started),
          timedOut,
          truncated,
        });
      });
    });
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const keys = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'];
  const result: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const value = process.env[key];

    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function assertProtocol(value: unknown): Record<string, unknown> {
  const record = asRecord(value);

  if (record['protocol'] !== 'joomla-mcp/1') {
    throw new Error('Joomla companion returned an unsupported protocol response.');
  }

  return record;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
