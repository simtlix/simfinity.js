import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const { GraphQLObjectType, GraphQLFloat, GraphQLInt } = graphql;

const bookingLineType = new GraphQLObjectType({
  name: 'bookingLine',
  description:
    'A line item within a booking: either a single service or a bundle, with the price and duration captured at booking time. Set either `service` or `bundle`, not both.',
  fields: () => ({
    service: {
      type: simfinity.getType('service'),
      description: 'The selected service (mutually exclusive with `bundle`).',
      extensions: { relation: { connectionField: 'service', displayField: 'name' } },
    },
    bundle: {
      type: simfinity.getType('bundle'),
      description: 'The selected bundle (mutually exclusive with `service`).',
      extensions: { relation: { connectionField: 'bundle', displayField: 'name' } },
    },
    price: { type: GraphQLFloat, description: 'Price captured for this line at booking time.' },
    durationMinutes: { type: GraphQLInt, description: 'Duration in minutes captured for this line.' },
  }),
});

export default bookingLineType;
simfinity.addNoEndpointType(bookingLineType);
