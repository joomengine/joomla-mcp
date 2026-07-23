export type AuditEventType = 'request_completed' | 'request_rejected' | 'session_opened' | 'session_closed';

export interface HttpAuditEvent {
  readonly type: AuditEventType;
  readonly timestamp: string;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly subject?: string;
  readonly sessionId?: string;
  readonly reason?: string;
}

export interface AuditSink {
  emit(event: HttpAuditEvent): void | Promise<void>;
}

export const noopAuditSink: AuditSink = { emit: () => undefined };

export async function safeAudit(sink: AuditSink, event: HttpAuditEvent): Promise<void> {
  try {
    await sink.emit(event);
  } catch {
    // Audit delivery must be monitored by the sink, but must not corrupt an MCP response.
  }
}
