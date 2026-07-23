import { resolve } from 'node:path';

import {
  JwksJwtVerifier,
  createJoomlaMcp,
  loadConfiguration,
} from '@joomengine/joomla-mcp';

const configFile = resolve(process.env['JOOMLA_MCP_CONFIG'] ?? 'config/sites.json');
const configuration = await loadConfiguration(configFile, {
  resolveSecret: ({ name }) => process.env[name],
});
const http = configuration.http;

if (http === undefined) {
  throw new Error('The http configuration block is required by this example.');
}

const verifier = new JwksJwtVerifier({ jwksUrl: http.jwksUrl });
const application = createJoomlaMcp({
  configuration,
  server: { name: 'embedded-joomla-mcp-http' },
});
const controller = application.createHttpServer({
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
  ...(http.resourceMetadataUrl === undefined
    ? {}
    : { resourceMetadataUrl: http.resourceMetadataUrl }),
  enableJsonResponse: http.enableJsonResponse,
});

await new Promise((resolveListen, reject) => {
  controller.server.once('error', reject);
  controller.server.listen(http.port, http.listenHost, () => {
    controller.server.off('error', reject);
    process.stderr.write(
      `Embedded Joomla MCP listening on ${http.listenHost}:${http.port}${http.mcpPath}\n`,
    );
    resolveListen();
  });
});

let closing = false;
const close = async (signal) => {
  if (closing) return;
  closing = true;
  process.stderr.write(`Received ${signal}; closing embedded Joomla MCP.\n`);
  await controller.close();
};

process.once('SIGTERM', () => void close('SIGTERM'));
process.once('SIGINT', () => void close('SIGINT'));
