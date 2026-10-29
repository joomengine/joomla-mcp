/** Bounded public JSON:API diagnostics; raw response bodies and traces are omitted. */
export interface JoomlaApiErrorDetail {
  readonly code?: string;
  readonly title?: string;
  readonly detail?: string;
}

/** An HTTP rejection is not evidence that a mutation had no effects. */
export class JoomlaApiError extends Error {
  public readonly code = 'JOOMLA_API_ERROR';
  public readonly errors: readonly JoomlaApiErrorDetail[];

  public constructor(
    public readonly httpStatus: number,
    data: unknown,
    credentials: readonly string[] = [],
  ) {
    const errors = errorDetails(data, credentials);
    const summary = errors.map((error) => error.detail ?? error.title ?? error.code).filter(Boolean).join('; ');
    super(`Joomla API returned HTTP ${httpStatus}: ${summary || 'No public JSON:API error details were returned.'}`);
    this.name = 'JoomlaApiError';
    this.errors = errors;
  }
}

function errorDetails(data: unknown, credentials: readonly string[]): readonly JoomlaApiErrorDetail[] {
  const rawErrors = record(data)['errors'];
  // Joomla's fallback renderer sometimes emits one error object, not an array.
  const errors = Array.isArray(rawErrors) ? rawErrors
    : Object.keys(record(rawErrors)).length > 0 ? [rawErrors] : [];

  return Object.freeze(errors.slice(0, 3).map((value) => {
    const error = record(value);
    const result: { code?: string; title?: string; detail?: string } = {};
    for (const key of ['code', 'title', 'detail'] as const) {
      const raw = error[key];
      if (typeof raw !== 'string' && !(key === 'code' && typeof raw === 'number' && Number.isFinite(raw))) continue;
      const text = safeText(String(raw), credentials);
      if (text !== '') result[key] = text;
    }
    return Object.freeze(result);
  }).filter((error) => Object.keys(error).length > 0));
}

function safeText(value: string, credentials: readonly string[]): string {
  // Never include debug stack frames or an HTML error page in protocol/audit errors.
  let text = value.split(/\r?\n|<[^>]*>/, 1)[0] ?? '';
  text = text.replace(/\s+in\s+(?:\/|[A-Za-z]:[\\/]).*$/, '');
  for (const credential of credentials) {
    if (credential === '') continue;
    for (const secret of new Set([credential, encodeURIComponent(credential), JSON.stringify(credential).slice(1, -1)])) {
      text = text.split(secret).join('[redacted]');
    }
  }
  // Error renderers can put SQL, secrets or a stack frame in the first line.
  // These are not public form diagnostics, even when wrapped in JSON:API.
  if (/[\u0000-\u001f\u007f]|\b(?:authorization|bearer|token|password|passwd|secret|credential|SQLSTATE|PDOException|stack trace|thrown in)\b|\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM)\b|(?:https?|file):\/\/|(?:^|\s|["'(])(?:\/[A-Za-z0-9_.-]+\/|[A-Za-z]:[\\/])|^\s*#\d+\s/i.test(text)) return '';
  return text.trim().slice(0, 500);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
