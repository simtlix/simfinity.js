import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';
import { favoriteScopes } from './favorite.scopes.js';

const { GraphQLObjectType, GraphQLID } = graphql;

const favoriteType = new GraphQLObjectType({
  name: 'favorite',
  description: 'A bookmark linking a user to a barbershop they marked as favorite.',
  extensions: {
    scope: favoriteScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the favorite.' },
    user: {
      type: simfinity.getType('user'),
      description: 'The user who saved the favorite.',
      extensions: { relation: { connectionField: 'user', displayField: 'email' } },
    },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The bookmarked barbershop.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
  }),
});

export default favoriteType;
simfinity.connect(null, favoriteType, 'favorite', 'favorites', protect('favorite'), null, null);
