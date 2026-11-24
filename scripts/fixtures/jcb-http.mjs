import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createJoomlaMcp } from '../../dist/library.js';
import { LiveMcpToolError } from '../../dist/live-test/transports.js';
import { JwksJwtVerifier } from '../../dist/security/jwks-jwt-verifier.js';

// This port belongs to the JCB-only Joomla container. Both independent clients
// reach exactly the same gateway, service process, Joomla site and job directory.
export async function withJcbHttpClients(configuration, exercise) {
  const host = '127.0.0.1';
  const port = 31971;
  const endpoint = new URL('http://' + host + ':' + port + '/mcp');
  const issuer = 'https://local-jcb-issuer.invalid';
  const audience = 'https://local-jcb-resource.invalid/mcp';
  const jwksUrl = issuer + '/jwks.json';
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const controller = createJoomlaMcp({ configuration, runtimeOptions: { audit: { write: async () => {} } } })
    .createHttpServer({
      jwtVerifier: new JwksJwtVerifier({
        jwksUrl,
        fetch: async (url) => {
          assert.equal(String(url), jwksUrl);
          return Response.json({ keys: [jwk] });
        },
      }),
      authorization: { issuer, audience, requiredScopes: ['mcp:access'] },
      requestPolicy: { allowedHosts: [endpoint.host], allowedOrigins: [] },
      enableJsonResponse: true,
      limits: { requestsPerMinutePerPrincipal: 6000, burstPerPrincipal: 3000 },
    });
  const clients = [];
  function token(subject) {
    const header = Buffer.from(JSON.stringify({ kid: 'fixture', alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: issuer, aud: audience, sub: subject, client_id: 'jcb-fixture',
      exp: Math.floor(Date.now() / 1000) + 1800,
      scope: 'mcp:access joomla:permissions:grant joomla:permissions:read joomla:writes:apply joomla:sites:* joomla:toolsets:*',
    })).toString('base64url');
    const input = header + '.' + payload;
    return input + '.' + sign('RSA-SHA256', Buffer.from(input), key.privateKey).toString('base64url');
  }
  async function connect(subject) {
    const client = new Client({ name: 'jcb-http-fixture', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: 'Bearer ' + token(subject) } },
    }));
    return {
      kind: 'http',
      async call({ name, arguments: args }) {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new LiveMcpToolError(name, result);
        return result.structuredContent ?? result.content;
      },
    };
  }
  try {
    controller.server.listen(port, host);
    await once(controller.server, 'listening');
    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
    await exercise(await connect('builder'), await connect('observer'));
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await controller.close();
  }
}
