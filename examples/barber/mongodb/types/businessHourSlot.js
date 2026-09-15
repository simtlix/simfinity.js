import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const { GraphQLObjectType, GraphQLString, GraphQLBoolean, GraphQLInt } = graphql;

const businessHourSlotType = new GraphQLObjectType({
  name: 'businessHourSlot',
  description: 'Opening hours for a single day of the week, with an optional mid-day break.',
  fields: () => ({
    dayOfWeek: {
      type: GraphQLInt,
      description: 'Day of week as an integer (0 = Sunday, 1 = Monday, ... 6 = Saturday).',
    },
    openTime: { type: GraphQLString, description: "Opening time in 'HH:mm' 24-hour format." },
    closeTime: { type: GraphQLString, description: "Closing time in 'HH:mm' 24-hour format." },
    isClosed: { type: GraphQLBoolean, description: 'Whether the business is closed on this day.' },
    breakStartTime: { type: GraphQLString, description: "Start of the mid-day break in 'HH:mm' (optional)." },
    breakEndTime: { type: GraphQLString, description: "End of the mid-day break in 'HH:mm' (optional)." },
  }),
});

export default businessHourSlotType;
simfinity.addNoEndpointType(businessHourSlotType);
