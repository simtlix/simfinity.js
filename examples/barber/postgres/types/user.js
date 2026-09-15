import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { scalars } from '@simtlix/simfinity-postgres';
import { userScopes } from './user.scopes.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
  GraphQLEnumType,
} = graphql;

const { EmailScalar } = scalars;

export const UserRoleEnum = new GraphQLEnumType({
  name: 'UserRole',
  values: {
    CLIENT: { value: 'CLIENT' },
    OWNER: { value: 'OWNER' },
    STAFF: { value: 'STAFF' },
    PLATFORM_ADMIN: { value: 'PLATFORM_ADMIN' },
  },
});

export const UserStatusEnum = new GraphQLEnumType({
  name: 'UserStatus',
  values: {
    ACTIVE: { value: 'ACTIVE' },
    SUSPENDED: { value: 'SUSPENDED' },
  },
});

const userType = new GraphQLObjectType({
  name: 'user',
  description:
    'A platform user account. Covers clients who book appointments, barbershop owners, staff members and platform administrators. The active role determines what the user can do.',
  extensions: {
    scope: userScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the user.' },
    email: {
      type: new GraphQLNonNull(EmailScalar),
      description: 'Email address; unique across the platform and used as the sign-in identifier.',
      extensions: { unique: true },
    },
    name: { type: new GraphQLNonNull(GraphQLString), description: "User's full display name." },
    phone: { type: GraphQLString, description: 'Contact phone number (optional).' },
    avatarUrl: { type: GraphQLString, description: "URL of the user's profile picture (optional)." },
    role: {
      type: UserRoleEnum,
      description:
        'Platform role that controls permissions: CLIENT (books appointments), OWNER (manages barbershops), STAFF (works at a barbershop) or PLATFORM_ADMIN (full administration).',
    },
    emailVerified: { type: GraphQLBoolean, description: 'Whether the user has verified their email address.' },
    status: {
      type: UserStatusEnum,
      description: 'Account status: ACTIVE (can sign in) or SUSPENDED (access blocked).',
    },
    passwordHash: {
      type: GraphQLString,
      description: 'Read-only, never exposed; always resolves to null.',
      extensions: { readOnly: true },
      resolve: () => null,
    },
    barbershops: {
      type: new GraphQLList(simfinity.getType('barbershop')),
      description: 'Barbershops owned by this user (relevant for the OWNER role).',
      extensions: { relation: { connectionField: 'owner' } },
    },
    bookings: {
      type: new GraphQLList(simfinity.getType('booking')),
      description: 'Appointments this user booked as a client.',
      extensions: { relation: { connectionField: 'client' } },
    },
    reviews: {
      type: new GraphQLList(simfinity.getType('review')),
      description: 'Reviews written by this user.',
      extensions: { relation: { connectionField: 'client' } },
    },
    notifications: {
      type: new GraphQLList(simfinity.getType('notification')),
      description: 'Notifications addressed to this user.',
      extensions: { relation: { connectionField: 'user' } },
    },
    favorites: {
      type: new GraphQLList(simfinity.getType('favorite')),
      description: 'Barbershops this user bookmarked as favorites.',
      extensions: { relation: { connectionField: 'user' } },
    },
  }),
});

export default userType;

simfinity.connect(null, userType, 'user', 'users', protect('user'), null, null);
