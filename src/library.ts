import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Configuration } from './config/schema.js';
import {
  createRuntime,
  createServer,
  type JoomlaMcpRuntime,
  type JoomlaMcpRuntimeOptions,
  type JoomlaMcpServerOptions,
} from './mcp/create-server.js';
import {
  createRemoteHttpServer,
  type RemoteHttpGatewayOptions,
  type RemoteHttpServerController,
} from './http/remote-http.js';

export interface CreateJoomlaMcpOptions {
  readonly configuration: Configuration;
  /**
   * Supply a fully assembled runtime to share state across every MCP session.
   * When omitted, the runtime is assembled from runtimeOptions.
   */
  readonly runtime?: JoomlaMcpRuntime;
  readonly runtimeOptions?: JoomlaMcpRuntimeOptions;
  readonly server?: JoomlaMcpServerOptions;
}

export type JoomlaMcpHttpOptions = Omit<RemoteHttpGatewayOptions, 'createMcpServer'>;

export interface JoomlaMcpApplication {
  readonly configuration: Configuration;
  readonly runtime: JoomlaMcpRuntime;
  /** Create a fresh MCP protocol server backed by the shared runtime. */
  createServer(): McpServer;
  /**
   * Create the authenticated Streamable HTTP gateway. Each MCP session gets a
   * fresh protocol server while write, permission, idempotency, and audit state
   * remain shared through this application runtime.
   */
  createHttpServer(options: JoomlaMcpHttpOptions): RemoteHttpServerController;
}

/**
 * Assemble an embeddable Joomla MCP application without starting a transport,
 * opening a port, registering signal handlers, or reading process globals.
 */
export function createJoomlaMcp(options: CreateJoomlaMcpOptions): JoomlaMcpApplication {
  const configuration = options.configuration;
  const runtime = options.runtime ?? createRuntime(configuration, options.runtimeOptions);
  const serverOptions = options.server;
  const createProtocolServer = (): McpServer => createServer(configuration, runtime, serverOptions);

  return Object.freeze({
    configuration,
    runtime,
    createServer: createProtocolServer,
    createHttpServer: (httpOptions: JoomlaMcpHttpOptions) =>
      createRemoteHttpServer({
        ...httpOptions,
        createMcpServer: createProtocolServer,
      }),
  });
}
