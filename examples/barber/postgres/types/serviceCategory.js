import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { serviceCategoryScopes } from './serviceCategory.scopes.js';

const { GraphQLObjectType, GraphQLID, GraphQLString, GraphQLBoolean, GraphQLInt, GraphQLNonNull } = graphql;

const serviceCategoryType = new GraphQLObjectType({
  name: 'serviceCategory',
  description:
    "A category used to group a barbershop's services (e.g. 'Haircuts', 'Beard', 'Coloring').",
  extensions: {
    scope: serviceCategoryScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the category.' },
    name: { type: new GraphQLNonNull(GraphQLString), description: 'Display name of the category.' },
    sortOrder: { type: GraphQLInt, description: 'Display order among categories (lower shows first).' },
    isActive: { type: GraphQLBoolean, description: 'Whether the category is currently shown.' },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The barbershop this category belongs to.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
  }),
});

export default serviceCategoryType;
simfinity.connect(null, serviceCategoryType, 'serviceCategory', 'serviceCategories', protect('serviceCategory'), null, null);
