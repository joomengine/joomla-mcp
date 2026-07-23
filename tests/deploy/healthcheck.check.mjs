#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { probeHealth } from '../../scripts/deploy/healthcheck.mjs';

const expectedHost = 'mcp-health.internal:3000';
const expectedOrigin = 'https://health-client.internal';
const server = createServer((request, response) => {
  if (
    request.method === 'HEAD' &&
    request.url === '/healthz' &&
    request.headers.host === expectedHost &&
    request.headers.origin === expectedOrigin
  ) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end();
    return;
  }
  response.writeHead(403);
  response.end();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const port = address.port;

  await probeHealth({
    JOOMLA_MCP_HEALTH_ADDRESS: '127.0.0.1',
    JOOMLA_MCP_HEALTH_HOST: expectedHost,
    JOOMLA_MCP_HEALTH_ORIGIN: expectedOrigin,
    JOOMLA_MCP_HEALTH_PATH: '/healthz',
    JOOMLA_MCP_HEALTH_PORT: String(port),
    JOOMLA_MCP_HEALTH_TIMEOUT_MS: '1000',
  });

  await assert.rejects(
    probeHealth({
      JOOMLA_MCP_HEALTH_ADDRESS: '127.0.0.1',
      JOOMLA_MCP_HEALTH_HOST: 'forbidden.internal',
      JOOMLA_MCP_HEALTH_ORIGIN: expectedOrigin,
      JOOMLA_MCP_HEALTH_PATH: '/healthz',
      JOOMLA_MCP_HEALTH_PORT: String(port),
      JOOMLA_MCP_HEALTH_TIMEOUT_MS: '1000',
    }),
    /HTTP 403/u,
  );

  await assert.rejects(
    probeHealth({
      JOOMLA_MCP_HEALTH_PATH: 'not-an-absolute-path',
    }),
    /Invalid health path/u,
  );
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

process.stdout.write('Deployment health probe tests passed.\n');
