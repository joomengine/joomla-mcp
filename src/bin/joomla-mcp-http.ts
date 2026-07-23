#!/usr/bin/env node

import { resolve } from 'node:path';

import { loadConfiguration } from '../config/load.js';
import { createRemoteHttpServer, type HttpAuditEvent } from '../http/index.js';
import { createRuntime, createServer } from '../mcp/create-server.js';
import { JwksJwtVerifier } from '../security/jwks-jwt-verifier.js';

async function main(): Promise<void> {
  const configFile = resolve(process.env['JOOMLA_MCP_CONFIG'] ?? 'config/sites.json');
  const configuration = await loadConfiguration(configFile);
  const http = configuration.http;

  if (http === undefined) {
    throw new Error('Remote HTTP is unavailable until the http configuration block is defined.');
  }

  const verifier = new JwksJwtVerifier({ jwksUrl: http.jwksUrl });
  const runtime = createRuntime(configuration);
  const controller = createRemoteHttpServer({
    createMcpServer: () => createServer(configuration, runtime),
    jwtVerifier: verifier,
    authorization: {
      issuer: http.issuer,
      audience: http.audience,
      requiredScopes: http.requiredScopes,
    },
    requestPolicy: {
      allowedHosts: http.allowedHosts,
      allowedOrigins: http.allowedOrigins,
      requireOrigin: http.requireOrigin,
    },
    limits: http.limits,
    mcpPath: http.mcpPath,
    healthPath: http.healthPath,
    readinessPath: http.readinessPath,
    readinessCheck: () => verifier.warm(),
    shutdownGraceMs: http.shutdownGraceMs,
    ...(http.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: http.resourceMetadataUrl }),
    enableJsonResponse: http.enableJsonResponse,
    audit: {
      emit: (event: HttpAuditEvent) => {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      },
    },
  });

  await new Promise<void>((resolveListen, reject) => {
    controller.server.once('error', reject);
    controller.server.listen(http.port, http.listenHost, () => {
      controller.server.off('error', reject);
      process.stderr.write(
        `JoomEngine MCP for Joomla HTTP listening on ${http.listenHost}:${http.port}${http.mcpPath}\n`,
      );
      resolveListen();
    });
  });

  let shutdownStarted = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    process.stderr.write(`JoomEngine MCP for Joomla received ${signal}; shutting down.\n`);
    await controller.close();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`JoomEngine MCP for Joomla HTTP failed: ${message}\n`);
  process.exitCode = 1;
});
