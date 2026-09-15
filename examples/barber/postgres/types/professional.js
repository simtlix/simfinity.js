import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { scalars } from '@simtlix/simfinity-postgres';
import { professionalScopes } from './professional.scopes.js';
import businessHourSlotType from './businessHourSlot.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
} = graphql;

const { URLScalar } = scalars;

const professionalType = new GraphQLObjectType({
  name: 'professional',
  description: 'A staff member at a barbershop who performs services for clients.',
  extensions: {
    scope: professionalScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the professional.' },
    name: { type: new GraphQLNonNull(GraphQLString), description: 'Display name of the professional.' },
    photoUrl: { type: GraphQLString, description: 'URL of the professional\'s photo.' },
    bio: { type: GraphQLString, description: 'Short biography or specialties shown to clients.' },
    isActive: { type: GraphQLBoolean, description: 'Whether the professional currently accepts bookings.' },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The barbershop this professional works at.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
    user: {
      type: simfinity.getType('user'),
      description: 'The linked user account, if the professional can sign in.',
      extensions: { relation: { connectionField: 'user', displayField: 'email' } },
    },
    services: {
      type: new GraphQLList(simfinity.getType('professionalService')),
      description: 'Services this professional is able to perform.',
      extensions: { relation: { embedded: true } },
    },
    businessHours: {
      type: new GraphQLList(businessHourSlotType),
      description: 'Personal weekly working hours (overrides the barbershop default when set).',
      extensions: { relation: { embedded: true } },
    },
  }),
});

export default professionalType;
simfinity.connect(null, professionalType, 'professional', 'professionals', protect('professional'), null, null);
