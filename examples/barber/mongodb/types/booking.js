import { protect } from '../auth/ownership.js';
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';
import bookingLineType from './bookingLine.js';
import { bookingScopes } from './booking.scopes.js';
import { bookingController } from './booking.controller.js';
import { PaymentMethodEnum, BookingStateEnum, bookingStateMachine } from './booking.stateMachine.js';

const {
  GraphQLObjectType,
  GraphQLID,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
} = graphql;

export { PaymentMethodEnum, BookingStateEnum };

const bookingType = new GraphQLObjectType({
  name: 'booking',
  description:
    "A client's appointment at a barbershop: the selected services/bundles, schedule, pricing and lifecycle state. The total price and end time are derived automatically from the booking lines.",
  extensions: {
    scope: bookingScopes,
  },
  fields: () => ({
    id: { type: GraphQLID, description: 'Unique identifier of the booking.' },
    confirmationCode: {
      type: GraphQLString,
      description: 'Human-friendly confirmation code; generated automatically when missing.',
    },
    notes: { type: GraphQLString, description: 'Free-text notes from the client or staff.' },
    scheduledDate: {
      type: GraphQLString,
      description: "Appointment date in 'YYYY-MM-DD' format, in the barbershop timezone.",
    },
    startTime: {
      type: GraphQLString,
      description: "Start time of the appointment (ISO date-time or 'HH:mm'), in the barbershop timezone.",
    },
    endTime: {
      type: GraphQLString,
      description: 'End time, computed automatically from the selected services\' durations.',
    },
    totalPrice: {
      type: GraphQLFloat,
      description: 'Total price, computed automatically from the booking lines.',
    },
    paymentMethod: {
      type: PaymentMethodEnum,
      description: 'How the appointment is paid. Currently only ON_SITE (pay at the barbershop).',
    },
    state: {
      type: BookingStateEnum,
      description:
        'Lifecycle state: CONFIRMED, COMPLETED, CANCELLED_BY_CLIENT, CANCELLED_BY_SHOP or NO_SHOW. Change it via the state-machine mutations, not direct updates.',
    },
    cancellationReason: {
      type: GraphQLString,
      description: 'Reason captured when the booking was cancelled.',
    },
    client: {
      type: simfinity.getType('user'),
      description: 'The user who booked the appointment. Defaults to the signed-in user.',
      extensions: { relation: { connectionField: 'client', displayField: 'email' } },
    },
    barbershop: {
      type: simfinity.getType('barbershop'),
      description: 'The barbershop where the appointment takes place. Must be APPROVED.',
      extensions: { relation: { connectionField: 'barbershop', displayField: 'name' } },
    },
    professional: {
      type: simfinity.getType('professional'),
      description: 'The staff member who will perform the services (optional).',
      extensions: { relation: { connectionField: 'professional', displayField: 'name' } },
    },
    lines: {
      type: new GraphQLList(bookingLineType),
      description: 'The services or bundles selected for this appointment, with captured price and duration.',
      extensions: { relation: { embedded: true } },
    },
    createdAt: { type: GraphQLString, description: 'Timestamp when the booking was created.' },
  }),
});

export default bookingType;
simfinity.connect(null, bookingType, 'booking', 'bookings', protect('booking', bookingController), null, bookingStateMachine);
