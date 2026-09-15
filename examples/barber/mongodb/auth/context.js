import jwt from 'jsonwebtoken';

export function buildUserContext(authHeader) {
  try {
    if (!authHeader?.startsWith('Bearer ')) return { user: null };
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production');
    const roles = Array.isArray(payload.roles) ? payload.roles : ['CLIENT'];
    return { user: { id: payload.sub, email: payload.email, roles, role: roles[0] } };
  } catch {
    return { user: null };
  }
}
