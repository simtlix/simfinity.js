import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  getType: vi.fn(() => ({})),
  getModel: vi.fn(),
  SimfinityError: class SimfinityError extends Error {
    constructor(message, code, status) {
      super(message);
      this.extensions = { code, status };
    }
  },
}));

import * as simfinity from '@simtlix/simfinity-postgres';
import { buildUserContext, resolveMcpUserContext, resolveUserContext } from '../auth/context.js';

const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const bearer = (claims = {}, options = { expiresIn: '15m' }) => `Bearer ${jwt.sign({ sub: 'user-1', email: 'u@test.local', roles: ['CLIENT'], ...claims }, secret, options)}`;
const read = (result) => vi.mocked(simfinity.getModel).mockReturnValue({ findById: vi.fn(result) });
const accountIs = (account) => read(async () => account);
const lookupFails = (error) => read(async () => { throw error; });
const rejection = (code, status) => ({ extensions: { code, status }, data: { code, status } });

describe('request user context', () => {
  beforeEach(() => vi.mocked(simfinity.getModel).mockReset());

  it('keeps an ACTIVE or status-less account signed in', async () => {
    for (const status of ['ACTIVE', null, undefined]) {
      accountIs({ role: 'CLIENT', status });
      expect((await resolveUserContext(bearer())).user).toEqual({ id: 'user-1', email: 'u@test.local', roles: ['CLIENT'], role: 'CLIENT' });
      expect((await resolveMcpUserContext(bearer())).user).toMatchObject({ id: 'user-1', roles: ['CLIENT'] });
    }
  });

  it('uses the role stored now, not the role in the token', async () => {
    accountIs({ role: 'CLIENT', status: 'ACTIVE' });
    const demoted = bearer({ roles: ['PLATFORM_ADMIN'] });
    expect(buildUserContext(demoted).user.roles).toEqual(['PLATFORM_ADMIN']);
    expect((await resolveUserContext(demoted)).user).toMatchObject({ roles: ['CLIENT'], role: 'CLIENT' });
    accountIs({ role: 'OWNER' });
    expect((await resolveUserContext(bearer())).user).toMatchObject({ roles: ['OWNER'], role: 'OWNER' });
    accountIs({});
    expect((await resolveUserContext(bearer({ roles: ['OWNER'] }))).user).toMatchObject({ roles: ['CLIENT'], role: 'CLIENT' });
  });

  it('treats a still-valid token of a SUSPENDED account as anonymous, and fails MCP calls', async () => {
    accountIs({ role: 'CLIENT', status: 'SUSPENDED' });
    expect(buildUserContext(bearer()).user?.id).toBe('user-1');
    expect(await resolveUserContext(bearer())).toEqual({ user: null });
    await expect(resolveMcpUserContext(bearer())).rejects.toMatchObject(rejection('ACCOUNT_SUSPENDED', 403));
  });

  it('treats a token of a deleted account as anonymous, and fails MCP calls', async () => {
    accountIs(null);
    expect(await resolveUserContext(bearer())).toEqual({ user: null });
    await expect(resolveMcpUserContext(bearer())).rejects.toMatchObject(rejection('UNAUTHENTICATED', 401));
  });

  it('reads no account for a missing, malformed or expired token', async () => {
    for (const header of [undefined, 'Basic x', 'Bearer not-a-jwt', bearer({}, { expiresIn: -10 })]) {
      expect(await resolveUserContext(header)).toEqual({ user: null });
    }
    // A lower-case scheme carries the token too.
    expect(buildUserContext(bearer().replace('Bearer', 'bearer')).user?.id).toBe('user-1');
    // MCP runs a request without a bearer as anonymous.
    for (const header of [undefined, 'Basic x']) {
      expect(await resolveMcpUserContext(header)).toEqual({ user: null });
    }
    expect(simfinity.getModel).not.toHaveBeenCalled();
  });

  it('fails MCP calls whose bearer is expired or invalid instead of running them as anonymous', async () => {
    const expired = resolveMcpUserContext(bearer({}, { expiresIn: -10 }));
    await expect(expired).rejects.toMatchObject(rejection('UNAUTHENTICATED', 401));
    await expect(expired).rejects.toThrow(/^The access token expired at \d{4}-\d\d-\d\dT.*; renew it with GraphQL refreshSession$/);
    const otherSecret = `Bearer ${jwt.sign({ sub: 'user-1', roles: ['CLIENT'] }, 'another-secret')}`;
    // Node trims a header value, so an empty bearer arrives as 'Bearer'; schemes are case-insensitive.
    for (const header of ['Bearer not-a-jwt', 'Bearer ', 'Bearer', '  bearer  ', 'bearer not-a-jwt', 'BEARER not-a-jwt', otherSecret]) {
      const invalid = resolveMcpUserContext(header);
      await expect(invalid).rejects.toMatchObject(rejection('UNAUTHENTICATED', 401));
      await expect(invalid).rejects.toThrow('Invalid access token; sign in again with GraphQL login');
    }
    expect(simfinity.getModel).not.toHaveBeenCalled();
  });

  it('treats a subject in the other example database format as a deleted account', async () => {
    lookupFails(Object.assign(new Error('Expected a UUID identifier'), { getCode: () => 'NOT_VALID_ID' }));
    expect(await resolveUserContext(bearer())).toEqual({ user: null });
    await expect(resolveMcpUserContext(bearer())).rejects.toMatchObject(rejection('UNAUTHENTICATED', 401));
  });

  it('propagates database failures instead of signing the caller out', async () => {
    lookupFails(new Error('connection refused'));
    await expect(resolveUserContext(bearer())).rejects.toThrow('connection refused');
    await expect(resolveMcpUserContext(bearer())).rejects.toThrow('connection refused');
  });
});
