#!/usr/bin/env node

import { resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfiguration } from '../config/load.js';
import { createServer } from '../mcp/create-server.js';

async function main(): Promise<void> {
  const configFile = resolve(process.env['JOOMLA_MCP_CONFIG'] ?? 'config/sites.json');
  const configuration = await loadConfiguration(configFile);
  const server = createServer(configuration);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`JoomEngine MCP for Joomla failed: ${message}\n`);
  process.exitCode = 1;
});
