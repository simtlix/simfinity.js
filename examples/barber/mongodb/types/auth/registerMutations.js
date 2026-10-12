import * as graphql from 'graphql';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import * as simfinity from '@simtlix/simfinity-js';
import { scalars } from '@simtlix/simfinity-js';

const {
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLInputObjectType,
  GraphQLList,
} = graphql;

const { EmailScalar } = scalars;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change';
const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';
const SALT_ROUNDS = 12;

const AuthPayloadType = new GraphQLObjectType({
  name: 'AuthPayload',
  fields: () => ({
    accessToken: { type: GraphQLString },
    refreshToken: { type: GraphQLString },
    user: { type: simfinity.getType('user') },
  }),
});

const LoginInput = new GraphQLInputObjectType({
  name: 'LoginInput',
  fields: {
    email: { type: new GraphQLNonNull(EmailScalar) },
    password: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const RegisterInput = new GraphQLInputObjectType({
  name: 'RegisterInput',
  fields: {
    email: { type: new GraphQLNonNull(EmailScalar) },
    password: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    phone: { type: GraphQLString },
  },
});

const RefreshInput = new GraphQLInputObjectType({
  name: 'RefreshInput',
  fields: {
    refreshToken: { type: new GraphQLNonNull(GraphQLString) },
  },
});

function signTokens(userDoc) {
  const roles = userDoc.role ? [userDoc.role] : ['CLIENT'];
  const payload = {
    sub: String(userDoc._id),
    email: userDoc.email,
    name: userDoc.name,
    role: userDoc.role || 'CLIENT',
    roles,
  };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TTL });
  const refreshToken = jwt.sign(
    { sub: String(userDoc._id), typ: 'refresh' },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TTL }
  );
  return { accessToken, refreshToken };
}

/** Suspended accounts (`user.status`, set by an admin) cannot sign in or renew a session. */
function assertNotSuspended(user) {
  if (user.status === 'SUSPENDED') {
    throw new simfinity.SimfinityError('This account is suspended', 'ACCOUNT_SUSPENDED', 403);
  }
}

/** Verifies a refresh token and returns its claims; throws jsonwebtoken's errors. */
export function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
  if (decoded.typ !== 'refresh') throw new jwt.JsonWebTokenError('not a refresh token');
  return decoded;
}

/**
 * Exchanges a refresh token for a new token pair, as the refreshSession mutation does. scripts/mcp-stdio.js
 * also uses it to keep a long-running stdio session signed in.
 */
export async function renewSession(refreshToken) {
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new Error('Invalid refresh token');
  }
  const UserModel = simfinity.getModel(simfinity.getType('user'));
  const user = await UserModel.findById(decoded.sub);
  if (!user) throw new Error('User not found');
  assertNotSuspended(user);
  const u = user.toObject();
  return { ...signTokens(u), user: { ...u, id: u._id, passwordHash: undefined } };
}

simfinity.registerMutation(
  'login',
  'Authenticate with email and password',
  LoginInput,
  AuthPayloadType,
  async (input) => {
    const UserModel = simfinity.getModel(simfinity.getType('user'));
    const user = await UserModel.findOne({ email: input.email.toLowerCase() });
    if (!user?.passwordHash) {
      throw new Error('Invalid email or password');
    }
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) throw new Error('Invalid email or password');
    // Checked after the password, so a wrong password never reveals that the account is suspended.
    assertNotSuspended(user);
    const u = user.toObject();
    const { accessToken, refreshToken } = signTokens(u);
    return {
      accessToken,
      refreshToken,
      user: { ...u, id: u._id, passwordHash: undefined },
    };
  }
);

simfinity.registerMutation(
  'register',
  'Create a client account',
  RegisterInput,
  AuthPayloadType,
  async (input) => {
    const UserModel = simfinity.getModel(simfinity.getType('user'));
    const email = input.email.toLowerCase();
    const existing = await UserModel.findOne({ email });
    if (existing) throw new Error('Email already registered');
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    const doc = await UserModel.create({
      email,
      name: input.name,
      phone: input.phone,
      role: 'CLIENT',
      emailVerified: false,
      status: 'ACTIVE',
      passwordHash,
    });
    const u = doc.toObject();
    const { accessToken, refreshToken } = signTokens(u);
    return {
      accessToken,
      refreshToken,
      user: { ...u, id: u._id, passwordHash: undefined },
    };
  }
);

simfinity.registerMutation(
  'registerOwner',
  'Create an owner account',
  RegisterInput,
  AuthPayloadType,
  async (input) => {
    const UserModel = simfinity.getModel(simfinity.getType('user'));
    const email = input.email.toLowerCase();
    const existing = await UserModel.findOne({ email });
    if (existing) throw new Error('Email already registered');
    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    const doc = await UserModel.create({
      email,
      name: input.name,
      phone: input.phone,
      role: 'OWNER',
      emailVerified: false,
      status: 'ACTIVE',
      passwordHash,
    });
    const u = doc.toObject();
    const { accessToken, refreshToken } = signTokens(u);
    return {
      accessToken,
      refreshToken,
      user: { ...u, id: u._id, passwordHash: undefined },
    };
  }
);

simfinity.registerMutation(
  'refreshSession',
  'Exchange refresh token for new access token',
  RefreshInput,
  AuthPayloadType,
  async (input) => renewSession(input.refreshToken)
);
