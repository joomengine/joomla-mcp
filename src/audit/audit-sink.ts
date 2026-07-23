export interface AuditEvent {
  readonly timestamp: string;
  readonly event:
    | 'action.read'
    | 'action.read_failed'
    | 'write.previewed'
    | 'write.planned'
    | 'write.applied'
    | 'write.failed'
    | 'permission.requested'
    | 'permission.approved'
    | 'permission.used'
    | 'permission.revoked';
  readonly site: string;
  readonly action: string;
  readonly transport?: 'api' | 'cli';
  readonly idempotencyKey?: string;
  readonly principalFingerprint?: string;
  readonly permissionRequestId?: string;
  readonly grantId?: string;
  readonly duration?: 'once' | '30-minutes' | 'indefinite';
  readonly toolsets?: readonly string[];
  readonly outcome: 'previewed' | 'planned' | 'requested' | 'approved' | 'revoked' | 'success' | 'failure';
  readonly detail?: string;
}

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

export class JsonLineAuditSink implements AuditSink {
  public constructor(private readonly output: Pick<NodeJS.WritableStream, 'write'> = process.stderr) {}

  public write(event: AuditEvent): void {
    this.output.write(`${JSON.stringify(event)}\n`);
  }
}
