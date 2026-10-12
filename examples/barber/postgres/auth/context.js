import jwt from 'jsonwebtoken';
import * as simfinity from '@simtlix/simfinity-postgres';

const jwtSecret = () => process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

/** Verifies a raw access token and returns its user claims; throws jsonwebtoken's errors. */
export function verifyAccessToken(token, options) {
  const payload = jwt.verify(token, jwtSecret(), options);
  const roles = Array.isArray(payload.roles) ? payload.roles : ['CLIENT'];
  return { id: payload.sub, email: payload.email, roles, role: roles[0] };
}

// `data` carries the code into MCP's JSON-RPC error, which keeps only the message and data.
const accountError = (message, code, status) => Object.assign(
  new simfinity.SimfinityError(message, code, status),
  { data: { code, status } },
);

/** Why a bearer failed verification; access tokens last 15 minutes, so expiry is the usual case. */
function tokenError(error) {
  return error?.name === 'TokenExpiredError'
    ? accountError(`The access token expired at ${error.expiredAt.toISOString()}; renew it with GraphQL refreshSession`, 'UNAUTHENTICATED', 401)
    : accountError('Invalid access token; sign in again with GraphQL login', 'UNAUTHENTICATED', 401);
}

/**
 * Verifies a bearer header; the scheme is case-insensitive. No header or another scheme is anonymous;
 * a bearer that fails verification, including one with no token, says why.
 */
function verifyBearer(authHeader) {
  const [scheme = '', ...rest] = String(authHeader ?? '').trim().split(/\s+/);
  if (scheme.toLowerCase() !== 'bearer') return { user: null };
  try {
    const token = rest.join(' ');
    if (!token) throw new Error('missing bearer token');
    return { user: verifyAccessToken(token) };
  } catch (error) {
    return { user: null, rejection: tokenError(error) };
  }
}

/**
 * Token-only claims: a missing, malformed or expired bearer is anonymous. It reads no account, so
 * request entry points (GraphQL, MCP, uploads) use resolveUserContext or resolveMcpUserContext instead.
 */
export function buildUserContext(authHeader) {
  return { user: verifyBearer(authHeader).user };
}

async function readAccount(id) {
  const UserModel = simfinity.getModel(simfinity.getType('user'));
  try {
    return await UserModel.findById(id);
  } catch (error) {
    // A subject that is not a UUID (e.g. a MongoDB example token) names no account here.
    if (error?.getCode?.() === 'NOT_VALID_ID') return null;
    throw error;
  }
}

/**
 * Reads the account behind a verified bearer, once per request. An active account signs in with the
 * role stored now, not the one in the token, so a demoted user's earlier token cannot use or restore
 * its old role. A bearer that fails verification, or the token of a deleted or SUSPENDED account, is
 * anonymous and comes with the error that explains why. Database failures propagate instead of
 * signing the caller out.
 */
async function authenticate(authHeader) {
  const { user, rejection } = verifyBearer(authHeader);
  if (!user) return { user: null, rejection };
  const account = await readAccount(user.id);
  if (!account) {
    return { user: null, rejection: accountError('The account of this access token no longer exists', 'UNAUTHENTICATED', 401) };
  }
  if (account.status === 'SUSPENDED') {
    return { user: null, rejection: accountError('This account is suspended', 'ACCOUNT_SUSPENDED', 403) };
  }
  const role = account.role || 'CLIENT';
  return { user: { ...user, roles: [role], role } };
}

/**
 * GraphQL and upload context. An expired or invalid bearer, or a token of a deleted or suspended
 * account, is anonymous, so public pages still render while signed-in actions fail with UNAUTHENTICATED.
 */
export async function resolveUserContext(authHeader) {
  const { user } = await authenticate(authHeader);
  return { user };
}

/**
 * MCP context. A bearer that is expired or fails verification, or the token of a deleted or suspended
 * account, fails the tool call (UNAUTHENTICATED or ACCOUNT_SUSPENDED), so an agent never mistakes
 * anonymous results for the account's data; an expired token's message says to renew it with GraphQL
 * refreshSession, which MCP does not publish. Only a request without a bearer runs as anonymous.
 */
export async function resolveMcpUserContext(authHeader) {
  const { user, rejection } = await authenticate(authHeader);
  if (rejection) throw rejection;
  return { user };
}
