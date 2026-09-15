import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { reviewScopes } from './review.scopes.js';
import { reviewController } from './review.controller.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLNonNull,
} = graphql;

const reviewType = new GraphQLObjectType({
  name: 'review',
  description:
    "A client's rating and comment about a barbershop, usually tied to a completed booking. Saving a review recomputes the barbershop's averageRating and reviewCount.",
  extensions: {
    scope: reviewScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the review.' },
    rating: { type: new GraphQLNonNull(GraphQLInt), description: 'Star rating from 1 (worst) to 5 (best).' },
    comment: { type: GraphQLString, description: 'Free-text feedback written by the client.' },
    reply: { type: GraphQLString, description: 'Optional public reply from the barbershop owner.' },
    isReported: {
      type: GraphQLBoolean,
      description: 'Whether the review was flagged for moderation.',
    },
    booking: {
      type: simfinity.getType('booking'),
      description: 'The booking this review refers to (optional).',
      extensions: { relation: { connectionField: 'booking', displayField: 'confirmationCode' } },
    },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The barbershop being reviewed.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
    client: {
      type: simfinity.getType('user'),
      description: 'The user who wrote the review.',
      extensions: { relation: { connectionField: 'client', displayField: 'email' } },
    },
    createdAt: { type: GraphQLString, description: 'Timestamp when the review was created.' },
  }),
});

export default reviewType;
simfinity.connect(null, reviewType, 'review', 'reviews', protect('review', reviewController), null, null);
