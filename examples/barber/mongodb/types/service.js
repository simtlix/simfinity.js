import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';
import { scalars } from '@simtlix/simfinity-js';
import { serviceScopes } from './service.scopes.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLFloat,
  GraphQLNonNull,
  GraphQLEnumType,
} = graphql;

const { URLScalar } = scalars;

export const PriceTypeEnum = new GraphQLEnumType({
  name: 'PriceType',
  values: {
    FIXED: { value: 'FIXED' },
    STARTING_AT: { value: 'STARTING_AT' },
  },
});

const serviceType = new GraphQLObjectType({
  name: 'service',
  description:
    'A single service offered by a barbershop (e.g. haircut, beard trim), with its price and duration.',
  extensions: {
    scope: serviceScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the service.' },
    name: { type: new GraphQLNonNull(GraphQLString), description: 'Display name of the service.' },
    description: { type: GraphQLString, description: 'Details about what the service includes.' },
    price: { type: GraphQLFloat, description: 'Price of the service in the barbershop currency.' },
    priceType: {
      type: PriceTypeEnum,
      description: 'How the price is presented: FIXED (exact price) or STARTING_AT (minimum, may vary).',
    },
    durationMinutes: { type: GraphQLInt, description: 'Estimated duration of the service in minutes.' },
    imageUrl: { type: GraphQLString, description: 'URL of an illustrative image for the service.' },
    isActive: { type: GraphQLBoolean, description: 'Whether the service is currently bookable.' },
    sortOrder: { type: GraphQLInt, description: 'Display order within its category (lower shows first).' },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The barbershop that offers this service.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
    category: {
      type: simfinity.getType('serviceCategory'),
      description: 'The category this service belongs to.',
      extensions: { relation: { connectionField: 'category', displayField: 'name' } },
    },
  }),
});

export default serviceType;
simfinity.connect(null, serviceType, 'service', 'services', protect('service'), null, null);
