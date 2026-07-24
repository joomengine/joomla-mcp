import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { loadConfiguration } from '../config/load.js';
import type {
  LiveJoomlaPath,
  LiveMcpTransport,
  LiveTestOptions,
  LiveTestProfile,
} from './types.js';
import { runLiveTest } from './runner.js';

export async function runLiveTestCli(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    output.write(helpText);
    return 0;
  }
  const parsed = parseArguments(argv);
  const interactive = !parsed.nonInteractive;
  const answers = interactive ? await interactiveOptions(parsed) : parsed;
  const options = await finalizeOptions(answers);
  if (options.nonInteractive && options.profile !== 'read') {
    const configuration = await loadConfiguration(options.configurationFile);
    const siteId = options.site ?? configuration.defaultSite;
    const site = configuration.sites.get(siteId);
    const target = site?.api === undefined ? site?.cli?.root ?? 'unknown' : new URL(site.api.baseUrl).hostname;
    output.write(
      `WARNING: approved unattended ${options.profile} validation will mutate Joomla site ${siteId} at ${target}. ` +
      `Cleanup: ${options.cleanup ? 'enabled' : 'retaining one labelled showcase per CRUD family'}.\n`,
    );
  }
  const summary = await runLiveTest(options);
  output.write(
    `Joomla MCP live validation ${summary.exitCode === 0 ? 'passed' : 'failed'}: ` +
    `${summary.counts.PASS} passed, ${summary.counts.FAIL} failed, ` +
    `${summary.counts.BLOCKED_BY_PREREQUISITE} blocked, ${summary.counts.SOURCE_ONLY_GATED} source-gated, ` +
    `${summary.counts.CLEANUP_FAILED} cleanup failures.\n` +
    `Evidence: ${resolve(options.outputDirectory)}\n`,
  );
  return summary.exitCode;
}

interface PartialOptions {
  configurationFile?: string;
  site?: string;
  outputDirectory?: string;
  profile?: LiveTestProfile;
  joomlaPaths?: readonly LiveJoomlaPath[];
  mcpTransports?: readonly LiveMcpTransport[];
  families?: readonly string[];
  nonInteractive?: boolean;
  confirmMutations?: boolean;
  disposable?: boolean;
  cleanup?: boolean;
  retainDemo?: boolean;
  failFast?: boolean;
  seed?: string;
  repositoryCommit?: string;
  fixtureDigests?: Readonly<Record<string, string>>;
}

function parseArguments(argv: readonly string[]): PartialOptions {
  const result: PartialOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} requires a value.`);
      return next;
    };
    switch (argument) {
      case '--config': result.configurationFile = value(); break;
      case '--site': result.site = value(); break;
      case '--output': result.outputDirectory = value(); break;
      case '--profile': result.profile = enumValue(value(), ['read', 'crud', 'full'], '--profile'); break;
      case '--joomla-path': result.joomlaPaths = pathSelection(value()); break;
      case '--mcp-transport': result.mcpTransports = mcpSelection(value()); break;
      case '--families': {
        const families = value().split(',').map((entry) => entry.trim()).filter(Boolean);
        result.families = families.includes('all') ? [] : families;
        break;
      }
      case '--seed': result.seed = safeSeed(value()); break;
      case '--repository-commit': result.repositoryCommit = value(); break;
      case '--fixture-digest': {
        const digest = value();
        const separator = digest.indexOf('=');
        if (separator < 1 || separator === digest.length - 1) {
          throw new Error('--fixture-digest must use name=value.');
        }
        result.fixtureDigests = {
          ...(result.fixtureDigests ?? {}),
          [digest.slice(0, separator)]: digest.slice(separator + 1),
        };
        break;
      }
      case '--non-interactive': result.nonInteractive = true; break;
      case '--confirm-mutations': result.confirmMutations = true; break;
      case '--disposable': result.disposable = true; break;
      case '--cleanup': result.cleanup = true; result.retainDemo = false; break;
      case '--retain-demo': result.retainDemo = true; result.cleanup = false; break;
      case '--fail-fast': result.failFast = true; break;
      default: throw new Error(`Unknown live-test option: ${argument}`);
    }
  }
  return result;
}

async function interactiveOptions(initial: PartialOptions): Promise<PartialOptions> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive mode needs a terminal. Use --non-interactive and the explicit safety flags.');
  }
  const prompt = createInterface({ input, output });
  try {
    const configurationFile = initial.configurationFile ??
      await question(prompt, 'Configuration file', 'config/sites.json');
    await access(resolve(configurationFile));
    const configuration = await loadConfiguration(configurationFile);
    const site = initial.site ?? await choose(
      prompt,
      'Joomla site',
      [...configuration.sites.keys()],
      configuration.defaultSite,
    );
    const profile = initial.profile ?? await choose(
      prompt,
      'Test profile',
      ['read', 'crud', 'full'] as const,
      'full',
    );
    const joomlaChoice = initial.joomlaPaths === undefined
      ? await choose(prompt, 'Joomla execution path', ['api', 'cli', 'all'] as const, 'all')
      : undefined;
    const mcpChoice = initial.mcpTransports === undefined
      ? await choose(prompt, 'MCP transport', ['stdio', 'http', 'all'] as const, 'all')
      : undefined;
    const familiesAnswer = initial.families === undefined
      ? await question(prompt, 'Families (comma-separated or all)', 'all')
      : undefined;
    const cleanupChoice = initial.cleanup === undefined && initial.retainDemo === undefined && profile !== 'read'
      ? await choose(prompt, 'Demo data after the run', ['retain-demo', 'cleanup'] as const, 'retain-demo')
      : undefined;
    const seed = initial.seed ?? safeSeed(await question(prompt, 'Run seed', defaultSeed()));
    const resolved: PartialOptions = {
      ...initial,
      configurationFile,
      site,
      profile,
      joomlaPaths: initial.joomlaPaths ?? pathSelection(joomlaChoice!),
      mcpTransports: initial.mcpTransports ?? mcpSelection(mcpChoice!),
      families: initial.families ?? (familiesAnswer === 'all'
        ? []
        : familiesAnswer!.split(',').map((entry) => entry.trim()).filter(Boolean)),
      seed,
      outputDirectory: initial.outputDirectory ?? resolve('artifacts', `live-test-${seed}`),
      cleanup: initial.cleanup ?? cleanupChoice === 'cleanup',
      retainDemo: initial.retainDemo ?? cleanupChoice === 'retain-demo',
      nonInteractive: false,
    };

    if (profile !== 'read') {
      const selectedSite = configuration.sites.get(site);
      if (selectedSite === undefined) throw new Error(`Configured Joomla site ${site} does not exist.`);
      const hostname = selectedSite.api === undefined ? selectedSite.cli!.root : new URL(selectedSite.api.baseUrl).hostname;
      const phrase = `MUTATE ${hostname} ${seed}`;
      output.write(
        '\nWARNING: This live test will create, update, publish/unpublish, and delete Joomla data.\n' +
        `Target site: ${site}\nTarget host: ${hostname}\nProfile: ${profile}\n` +
        `Joomla paths: ${resolved.joomlaPaths!.join(', ')}\nMCP transports: ${resolved.mcpTransports!.join(', ')}\n` +
        `Retention: ${resolved.cleanup ? 'remove generated showcase records' : 'retain one labelled showcase record per CRUD family'}\n`,
      );
      const acknowledgement = await prompt.question(`Type "${phrase}" to continue: `);
      if (acknowledgement !== phrase) throw new Error('Mutation acknowledgement did not match; no test was started.');
      resolved.confirmMutations = true;
      if (profile === 'full') {
        const disposable = await choose(
          prompt,
          'Is this target explicitly disposable?',
          ['yes', 'no'] as const,
          'no',
        );
        resolved.disposable = disposable === 'yes';
      }
    }
    return resolved;
  } finally {
    prompt.close();
  }
}

async function finalizeOptions(value: PartialOptions): Promise<LiveTestOptions> {
  const configurationFile = resolve(value.configurationFile ?? 'config/sites.json');
  await access(configurationFile);
  const profile = value.profile ?? 'read';
  const nonInteractive = value.nonInteractive ?? false;
  if (nonInteractive && profile !== 'read' && value.confirmMutations !== true) {
    throw new Error('Non-interactive mutation profiles require --confirm-mutations.');
  }
  if (nonInteractive && profile === 'full' && value.disposable !== true) {
    throw new Error('Non-interactive --profile full requires --disposable.');
  }
  const seed = value.seed ?? defaultSeed();
  const cleanup = value.cleanup ?? (nonInteractive && profile !== 'read');
  return Object.freeze({
    configurationFile,
    ...(value.site === undefined ? {} : { site: value.site }),
    outputDirectory: resolve(value.outputDirectory ?? 'artifacts', value.outputDirectory === undefined ? `live-test-${seed}` : ''),
    profile,
    joomlaPaths: Object.freeze([...(value.joomlaPaths ?? ['api'])]),
    mcpTransports: Object.freeze([...(value.mcpTransports ?? ['stdio'])]),
    families: Object.freeze([...(value.families ?? [])]),
    nonInteractive,
    confirmMutations: value.confirmMutations ?? false,
    disposable: value.disposable ?? false,
    cleanup,
    retainDemo: value.retainDemo ?? !cleanup,
    failFast: value.failFast ?? false,
    seed,
    ...(value.repositoryCommit === undefined ? {} : { repositoryCommit: value.repositoryCommit }),
    ...(value.fixtureDigests === undefined ? {} : { fixtureDigests: value.fixtureDigests }),
  });
}

async function question(
  prompt: ReturnType<typeof createInterface>,
  label: string,
  fallback: string,
): Promise<string> {
  const answer = (await prompt.question(`${label} [${fallback}]: `)).trim();
  return answer || fallback;
}

async function choose<const T extends string>(
  prompt: ReturnType<typeof createInterface>,
  label: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  const answer = await question(prompt, `${label} (${choices.join('/')})`, fallback);
  return enumValue(answer, choices, label);
}

function pathSelection(value: string): readonly LiveJoomlaPath[] {
  const selected = enumValue(value, ['api', 'cli', 'all'] as const, '--joomla-path');
  return selected === 'all' ? ['api', 'cli'] : [selected];
}

function mcpSelection(value: string): readonly LiveMcpTransport[] {
  const selected = enumValue(value, ['stdio', 'http', 'all'] as const, '--mcp-transport');
  return selected === 'all' ? ['stdio', 'http'] : [selected];
}

function enumValue<const T extends string>(value: string, choices: readonly T[], label: string): T {
  if (!choices.includes(value as T)) throw new Error(`${label} must be one of: ${choices.join(', ')}.`);
  return value as T;
}

function safeSeed(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error('The live-test seed must use 1-64 letters, digits, dots, underscores, or hyphens.');
  }
  return value;
}

function defaultSeed(): string {
  return new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
}

const helpText = `Joomla MCP live validation

Usage:
  npx joomla-mcp-live-test [options]

Selection:
  --config <file>              Joomla MCP sites configuration (default: config/sites.json)
  --site <alias>               Configured site alias
  --profile <read|crud|full>   Read-only, catalogue CRUD, or complete validation
  --joomla-path <api|cli|all>  Joomla execution path
  --mcp-transport <stdio|http|all>
  --families <csv|all>         Limit action domains/families

Safety:
  --non-interactive            Disable prompts
  --confirm-mutations          Required for unattended CRUD/full runs
  --disposable                 Required for unattended full/high-risk runs
  --cleanup                    Remove generated showcase records
  --retain-demo                Retain one labelled showcase record per CRUD family

Evidence:
  --output <directory>         summary.md, summary.json, junit.xml, and per-action JSON
  --seed <value>               Deterministic fixture/run identifier
  --repository-commit <sha>    Commit recorded in evidence
  --fixture-digest <name=value> Repeatable fixture/image/package identity
  --fail-fast                  Stop after the first unexpected failure

Interactive mode warns before mutation and requires:
  MUTATE <target-hostname> <run-seed>
`;
