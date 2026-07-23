#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';

import { probeHealth } from './healthcheck.mjs';

const timeoutText = process.env.JOOMLA_MCP_STARTUP_TIMEOUT_MS ?? '30000';

if (!/^\d+$/u.test(timeoutText)) {
  throw new TypeError('JOOMLA_MCP_STARTUP_TIMEOUT_MS must be an integer.');
}

const timeoutMs = Number(timeoutText);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
  throw new TypeError('JOOMLA_MCP_STARTUP_TIMEOUT_MS must be between 1000 and 600000.');
}

const deadline = Date.now() + timeoutMs;
let lastError = new Error('health endpoint did not become available');

while (Date.now() < deadline) {
  try {
    await probeHealth();
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
  }

  await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
}

process.stderr.write(`Joomla MCP startup health check failed: ${lastError.message}\n`);
process.exit(1);
