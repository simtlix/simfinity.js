import { describe, it, expect, vi, beforeEach } from 'vitest';

// A plain function stands in for the account lookup: vitest reported a cleared or reset vi.fn's
// rejection as a test error even though the middleware handles it.
const account = vi.hoisted(() => ({ lookup: null, headers: [] }));
vi.mock('../auth/context.js', () => ({
  resolveUserContext: async (header) => {
    account.headers.push(header);
    return account.lookup(header);
  },
}));

const { requireAuth } = await import('../routes/upload.js');

async function authenticate(authorization) {
  const req = { headers: { authorization } };
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

describe('upload requireAuth', () => {
  beforeEach(() => {
    account.lookup = null;
    account.headers = [];
  });

  it('signs in an active account with the request context GraphQL uses', async () => {
    const user = { id: 'owner-1', roles: ['OWNER'], role: 'OWNER' };
    account.lookup = async () => ({ user });
    const { req, res, next } = await authenticate('Bearer token');
    expect(account.headers).toEqual(['Bearer token']);
    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a token of a deleted or suspended account like an invalid one', async () => {
    account.lookup = async () => ({ user: null });
    const { res, next } = await authenticate('Bearer token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token invalido' });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers JSON 503 when the account cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    account.lookup = async () => { throw new Error('connection refused'); };
    const { res, next } = await authenticate('Bearer token');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'No se pudo verificar la sesion' });
    expect(next).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('asks for a bearer token before reading any account', async () => {
    const { res, next } = await authenticate(undefined);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token requerido' });
    expect(account.headers).toEqual([]);
    expect(next).not.toHaveBeenCalled();
  });
});
