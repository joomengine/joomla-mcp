import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type JwtClaims = Readonly<Record<string, unknown>>;

/**
 * Trust boundary for JWT cryptography. Implementations MUST verify the JWT
 * signature, reject unsupported algorithms (including `none`), and validate
 * the signing key's trust chain before returning claims.
 */
export interface JwtCryptographicVerifier {
  verify(token: string): Promise<JwtClaims>;
}

export interface JwtAuthorizationPolicy {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredScopes: readonly string[];
  readonly clockToleranceSeconds?: number;
}

export interface AuthorizedPrincipal {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly authInfo: AuthInfo;
}

export type AuthorizationFailureCode =
  | 'authorization_missing'
  | 'authorization_malformed'
  | 'token_invalid'
  | 'issuer_invalid'
  | 'audience_invalid'
  | 'subject_invalid'
  | 'expiration_invalid'
  | 'token_expired'
  | 'token_not_active'
  | 'scope_insufficient';

export class AuthorizationError extends Error {
  readonly status: 401 | 403;
  readonly code: AuthorizationFailureCode;

  constructor(status: 401 | 403, code: AuthorizationFailureCode, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
    this.code = code;
  }

  wwwAuthenticate(resourceMetadataUrl?: string): string {
    const parameters = [
      `error="${this.status === 403 ? 'insufficient_scope' : 'invalid_token'}"`,
      `error_description="${this.code}"`,
    ];

    if (resourceMetadataUrl !== undefined) {
      parameters.push(`resource_metadata="${escapeHeaderValue(resourceMetadataUrl)}"`);
    }

    return `Bearer ${parameters.join(', ')}`;
  }
}

export async function authorizeBearerJwt(
  header: string | readonly string[] | undefined,
  verifier: JwtCryptographicVerifier,
  policy: JwtAuthorizationPolicy,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<AuthorizedPrincipal> {
  validatePolicy(policy);
  const token = parseBearerJwt(header);

  let claims: JwtClaims;
  try {
    claims = await verifier.verify(token);
  } catch {
    throw new AuthorizationError(401, 'token_invalid', 'The bearer token could not be verified.');
  }

  if (claims.iss !== policy.issuer) {
    throw new AuthorizationError(401, 'issuer_invalid', 'The bearer token issuer is not accepted.');
  }

  if (!claimAudience(claims.aud).includes(policy.audience)) {
    throw new AuthorizationError(401, 'audience_invalid', 'The bearer token audience is not accepted.');
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 512) {
    throw new AuthorizationError(401, 'subject_invalid', 'The bearer token has no valid subject.');
  }

  const expiresAt = numericDate(claims.exp);
  if (expiresAt === undefined) {
    throw new AuthorizationError(401, 'expiration_invalid', 'The bearer token has no valid expiration.');
  }

  const tolerance = policy.clockToleranceSeconds ?? 30;
  if (expiresAt <= nowEpochSeconds - tolerance) {
    throw new AuthorizationError(401, 'token_expired', 'The bearer token has expired.');
  }

  const notBefore = numericDate(claims.nbf);
  if (claims.nbf !== undefined && notBefore === undefined) {
    throw new AuthorizationError(401, 'token_not_active', 'The bearer token has an invalid not-before value.');
  }
  if (notBefore !== undefined && notBefore > nowEpochSeconds + tolerance) {
    throw new AuthorizationError(401, 'token_not_active', 'The bearer token is not active yet.');
  }

  const scopes = claimScopes(claims);
  const missingScopes = policy.requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new AuthorizationError(403, 'scope_insufficient', 'The bearer token lacks required scopes.');
  }

  const clientId = firstNonEmptyString(claims.client_id, claims.azp, claims.sub);
  const authInfo: AuthInfo = {
    token,
    clientId,
    scopes: [...scopes],
    expiresAt,
    extra: { subject: claims.sub, issuer: policy.issuer },
  };

  return { subject: claims.sub, clientId, scopes, expiresAt, authInfo };
}

export function parseBearerJwt(header: string | readonly string[] | undefined): string {
  if (header === undefined) {
    throw new AuthorizationError(401, 'authorization_missing', 'A bearer token is required.');
  }
  if (typeof header !== 'string') {
    throw new AuthorizationError(401, 'authorization_malformed', 'Only one Authorization header is accepted.');
  }

  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  if (match?.[1] === undefined) {
    throw new AuthorizationError(401, 'authorization_malformed', 'Authorization must contain one bearer JWT.');
  }

  return match[1];
}

function validatePolicy(policy: JwtAuthorizationPolicy): void {
  if (policy.issuer.length === 0 || policy.audience.length === 0) {
    throw new TypeError('JWT issuer and audience must not be empty.');
  }
  if (policy.requiredScopes.some((scope) => scope.length === 0 || /\s/.test(scope))) {
    throw new TypeError('JWT scopes must be non-empty and contain no whitespace.');
  }
  const tolerance = policy.clockToleranceSeconds ?? 30;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 300) {
    throw new TypeError('JWT clock tolerance must be an integer between 0 and 300 seconds.');
  }
}

function claimAudience(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }
  return [];
}

function claimScopes(claims: JwtClaims): readonly string[] {
  const value = claims.scope ?? claims.scp;
  if (typeof value === 'string') {
    return [...new Set(value.split(/\s+/u).filter((scope) => scope.length > 0))];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return [...new Set(value)];
  }
  return [];
}

function numericDate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function firstNonEmptyString(...values: readonly unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? 'unknown';
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
