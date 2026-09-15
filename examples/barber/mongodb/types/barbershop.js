import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';
import businessHourSlotType from './businessHourSlot.js';
import addressType from './address.js';
import contactInfoType from './contactInfo.js';
import { barbershopScopes } from './barbershop.scopes.js';
import { barbershopController } from './barbershop.controller.js';
import { BarbershopStateEnum, barbershopStateMachine } from './barbershop.stateMachine.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
} = graphql;

export { BarbershopStateEnum };

const barbershopType = new GraphQLObjectType({
  name: 'barbershop',
  description:
    'A barbershop business listing: profile, location, scheduling policy, catalog and lifecycle state. Only barbershops in the APPROVED state are publicly visible to clients.',
  extensions: {
    scope: barbershopScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the barbershop.' },
    owner: {
      type: new GraphQLNonNull(simfinity.getType('user')),
      description: 'The user (OWNER role) that owns and manages this barbershop.',
      extensions: { relation: { connectionField: 'owner', displayField: 'email' } },
    },
    slug: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'URL-friendly unique identifier used in public links.',
      extensions: { unique: true },
    },
    name: { type: new GraphQLNonNull(GraphQLString), description: 'Display name of the barbershop.' },
    description: { type: GraphQLString, description: 'Marketing description shown to clients.' },
    logoUrl: { type: GraphQLString, description: 'URL of the barbershop logo image.' },
    coverImageUrl: { type: GraphQLString, description: 'URL of the cover/banner image.' },
    address: {
      type: addressType,
      description: 'Physical street address of the barbershop.',
      extensions: { relation: { embedded: true } },
    },
    latitude: { type: GraphQLFloat, description: 'Latitude coordinate for map display and distance search.' },
    longitude: { type: GraphQLFloat, description: 'Longitude coordinate for map display and distance search.' },
    contactInfo: {
      type: contactInfoType,
      description: 'Public contact channels (phone, email, social links).',
      extensions: { relation: { embedded: true } },
    },
    timezone: {
      type: GraphQLString,
      description:
        "IANA timezone (e.g. 'America/Argentina/Buenos_Aires') used to interpret business hours and booking times.",
    },
    slotDurationMinutes: { type: GraphQLInt, description: 'Length in minutes of each bookable time slot.' },
    bufferMinutes: { type: GraphQLInt, description: 'Buffer time in minutes inserted between consecutive bookings.' },
    minAdvanceHours: {
      type: GraphQLInt,
      description: 'Minimum number of hours in advance a client must book before the appointment start.',
    },
    maxAdvanceDays: {
      type: GraphQLInt,
      description: 'Maximum number of days into the future a client may book.',
    },
    cancellationPolicyHours: {
      type: GraphQLInt,
      description: 'Hours before the appointment within which a cancellation may incur a fee.',
    },
    cancellationFeePercent: {
      type: GraphQLInt,
      description: 'Percentage of the total price charged for a late cancellation.',
    },
    averageRating: {
      type: GraphQLFloat,
      description: 'Computed average of client review ratings (1-5). Maintained automatically.',
    },
    reviewCount: { type: GraphQLInt, description: 'Computed total number of reviews. Maintained automatically.' },
    state: {
      type: BarbershopStateEnum,
      description:
        'Lifecycle state: DRAFT, PENDING_REVIEW, APPROVED, REJECTED or SUSPENDED. Only APPROVED shops are visible to clients. Change it via the state-machine mutations, not direct updates.',
    },
    rejectionReason: {
      type: GraphQLString,
      description: 'Explanation provided by an admin when the barbershop was rejected.',
    },
    businessHours: {
      type: new GraphQLList(businessHourSlotType),
      description: 'Weekly opening hours, one entry per day of week.',
      extensions: { relation: { embedded: true } },
    },
    services: {
      type: new GraphQLList(simfinity.getType('service')),
      description: 'Services offered by this barbershop.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
    serviceCategories: {
      type: new GraphQLList(simfinity.getType('serviceCategory')),
      description: 'Categories used to organize this barbershop\'s services.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
    professionals: {
      type: new GraphQLList(simfinity.getType('professional')),
      description: 'Staff members who perform services at this barbershop.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
    bookings: {
      type: new GraphQLList(simfinity.getType('booking')),
      description: 'Appointments booked at this barbershop.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
    bundles: {
      type: new GraphQLList(simfinity.getType('bundle')),
      description: 'Discounted service packages offered by this barbershop.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
    reviews: {
      type: new GraphQLList(simfinity.getType('review')),
      description: 'Client reviews for this barbershop.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
    favorites: {
      type: new GraphQLList(simfinity.getType('favorite')),
      description: 'Favorite bookmarks pointing to this barbershop.',
      extensions: { relation: { connectionField: 'barbershop' } },
    },
  }),
});

export default barbershopType;
simfinity.connect(
  null,
  barbershopType,
  'barbershop',
  'barbershops',
  protect('barbershop', barbershopController),
  null,
  barbershopStateMachine
);
