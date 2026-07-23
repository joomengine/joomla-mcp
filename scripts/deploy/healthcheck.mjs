#!/usr/bin/env node

import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 3_000;

export async function probeHealth(environment = process.env) {
  const address = boundedText(environment.JOOMLA_MCP_HEALTH_ADDRESS ?? '127.0.0.1', 'health address', 255);
  const port = boundedInteger(environment.JOOMLA_MCP_HEALTH_PORT ?? '3000', 'health port', 1, 65_535);
  const path = healthPath(environment.JOOMLA_MCP_HEALTH_PATH ?? '/healthz');
  const host = boundedText(environment.JOOMLA_MCP_HEALTH_HOST ?? `127.0.0.1:${port}`, 'health Host', 255);
  const originValue = environment.JOOMLA_MCP_HEALTH_ORIGIN;
  const origin =
    originValue === undefined || originValue === '' ? undefined : boundedText(originValue, 'health Origin', 2_048);
  const timeoutMs = boundedInteger(
    environment.JOOMLA_MCP_HEALTH_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    'health timeout',
    100,
    30_000,
  );

  await new Promise((resolve, reject) => {
    const probe = request(
      {
        host: address,
        port,
        path,
        method: 'HEAD',
        headers: { Host: host, Connection: 'close', ...(origin === undefined ? {} : { Origin: origin }) },
        timeout: timeoutMs,
        agent: false,
      },
      (response) => {
        response.resume();
        response.once('end', () => {
          if (response.statusCode === 200) {
            resolve();
            return;
          }
          reject(new Error(`health endpoint returned HTTP ${response.statusCode ?? 'unknown'}`));
        });
      },
    );

    probe.once('timeout', () => probe.destroy(new Error('health request timed out')));
    probe.once('error', reject);
    probe.end();
  });
}

function boundedText(value, label, maximumLength) {
  if (value.length < 1 || value.length > maximumLength || /[\u0000-\u001F\u007F\s]/u.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return parsed;
}

function healthPath(value) {
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(value) || value.includes('//')) {
    throw new TypeError('Invalid health path.');
  }
  return value;
}

async function run() {
  try {
    await probeHealth();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Joomla MCP health probe failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
