import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { bundleScopes } from './bundle.scopes.js';
import { bundleController } from './bundle.controller.js';
import bundleItemType from './bundleItem.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLFloat,
  GraphQLNonNull,
  GraphQLList,
} = graphql;

const bundleType = new GraphQLObjectType({
  name: 'bundle',
  description:
    'A discounted package that combines several services from a barbershop at a single price.',
  extensions: {
    scope: bundleScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the bundle.' },
    name: { type: new GraphQLNonNull(GraphQLString), description: 'Display name of the bundle.' },
    description: { type: GraphQLString, description: 'Details about what the bundle includes.' },
    price: {
      type: GraphQLFloat,
      description: 'Total price of the bundle; must be below the sum of its services\' prices.',
    },
    totalDurationMinutes: {
      type: GraphQLInt,
      description: 'Computed total duration in minutes, summed from the included services.',
    },
    isActive: { type: GraphQLBoolean, description: 'Whether the bundle is currently bookable.' },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The barbershop that offers this bundle.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
    services: {
      type: new GraphQLList(bundleItemType),
      description: 'The services included in this bundle.',
      extensions: { relation: { embedded: true } },
    },
  }),
});

export default bundleType;
simfinity.connect(null, bundleType, 'bundle', 'bundles', protect('bundle', bundleController), null, null);
