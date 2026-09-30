// Business-logic operations that cannot be expressed as CRUD + scopes. Simfinity 3.3.0 can
// register custom mutations but not custom queries, so read-only operations use mutations too.
import * as graphql from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';
import { blocksProfessional, dayNumber, parseClock } from './booking.schedule.js';
import { assertBarbershopApprovedForBooking, findOwnBookingId, findSlotHoldingBookings } from './booking.controller.js';

const { GraphQLObjectType, GraphQLInputObjectType, GraphQLNonNull, GraphQLList, GraphQLID, GraphQLString } = graphql;

const BookingAvailabilityInput = new GraphQLInputObjectType({
  name: 'BookingAvailabilityInput',
  fields: {
    barbershopId: { type: new GraphQLNonNull(GraphQLID), description: 'Approved barbershop to inspect.' },
    date: { type: new GraphQLNonNull(GraphQLString), description: "Day in 'YYYY-MM-DD' format, in the barbershop timezone." },
    professionalId: {
      type: GraphQLID,
      description: 'Return only ranges that block this professional: their bookings and bookings without a professional.',
    },
    excludeBookingId: {
      type: GraphQLID,
      description: "Leave out this booking when the signed-in user is its client, as when rescheduling it; other clients' bookings are never left out.",
    },
  },
});

const BookingBusyRangeType = new GraphQLObjectType({
  name: 'BookingBusyRange',
  description: 'Time held by a confirmed booking. It carries no client or booking details.',
  fields: {
    startTime: { type: GraphQLString, description: "Start of the held time ('HH:mm')." },
    endTime: { type: GraphQLString, description: "End of the services ('HH:mm'); the shop's bufferMinutes follow it." },
    professionalId: { type: GraphQLID, description: 'Professional holding the time; null when the booking holds the whole shop.' },
  },
});

/** Times held by confirmed bookings, read natively so clients can see other clients' taken slots. */
export async function listBusyRanges(input, session, context) {
  if (dayNumber(input.date) == null) {
    throw new simfinity.SimfinityError("date must use the 'YYYY-MM-DD' format", 'INVALID_BOOKING_TIME', 400);
  }
  await assertBarbershopApprovedForBooking(input.barbershopId, session);
  // Like an update's own overlap check, a client's booking does not block its own reschedule.
  const excludeId = input.excludeBookingId == null ? null : await findOwnBookingId(input.excludeBookingId, session, context);
  const bookings = await findSlotHoldingBookings(input.barbershopId, input.date, session, excludeId);
  return bookings
    .filter((booking) => !input.professionalId || blocksProfessional(booking.professional, input.professionalId))
    .map((booking) => ({ startTime: booking.startTime, endTime: booking.endTime, professionalId: booking.professional }))
    .sort((a, b) => (parseClock(a.startTime) ?? Infinity) - (parseClock(b.startTime) ?? Infinity));
}

simfinity.registerMutation(
  'bookingAvailability',
  'Times held by confirmed bookings of an approved barbershop on a date, without client data',
  BookingAvailabilityInput,
  new GraphQLList(BookingBusyRangeType),
  listBusyRanges,
);
