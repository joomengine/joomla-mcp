import { resolve } from 'node:path';

import { createJoomlaMcp, loadConfiguration } from '@joomengine/joomla-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const configFile = resolve(process.env['JOOMLA_MCP_CONFIG'] ?? 'config/sites.json');
const configuration = await loadConfiguration(configFile, {
  resolveSecret: ({ name }) => process.env[name],
});
const application = createJoomlaMcp({
  configuration,
  server: {
    name: 'embedded-joomla-mcp',
    localPrincipal: process.env['JOOMLA_MCP_PRINCIPAL'] ?? 'embedded-stdio',
  },
});
const server = application.createServer();

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  await server.close().catch(() => undefined);
  throw error;
}
