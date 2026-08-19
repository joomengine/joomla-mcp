/**
 * Fail-closed errors raised while loading or mapping joomla-mcp-spec.
 *
 * A missing, unreadable, or invalid spec artefact must never degrade into the
 * in-repo fallback. Callers either get a fully validated catalogue or an error.
 */
export class SpecCatalogError extends Error {
  public readonly code: string;
  public readonly specPath?: string;
  public readonly detail?: Readonly<Record<string, unknown>>;

  public constructor(
    code: string,
    message: string,
    options: {
      readonly specPath?: string;
      readonly detail?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SpecCatalogError';
    this.code = code;
    if (options.specPath !== undefined) {
      this.specPath = options.specPath;
    }
    if (options.detail !== undefined) {
      this.detail = Object.freeze({ ...options.detail });
    }
  }
}

export function failClosed(
  code: string,
  message: string,
  options: {
    readonly specPath?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  } = {},
): never {
  throw new SpecCatalogError(code, message, options);
}

export function failMissingFile(specPath: string, relativePath: string): never {
  return failClosed(
    'spec-file-missing',
    `joomla-mcp-spec is incomplete: missing ${relativePath}.`,
    { specPath, detail: { relativePath } },
  );
}

export function failInvalidDocument(specPath: string, relativePath: string, reason: string): never {
  return failClosed(
    'spec-document-invalid',
    `joomla-mcp-spec document ${relativePath} is invalid: ${reason}`,
    { specPath, detail: { relativePath, reason } },
  );
}
