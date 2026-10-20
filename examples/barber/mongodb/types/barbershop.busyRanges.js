// A business read that the generated queries cannot express goes on the type it describes, as a
// virtual field with arguments, rather than in a custom root operation. Clients read a shop's taken
// times through `barbershop(id) { busyRanges(date: ...) { ... } }`: a read-only query whose shop
// passes the barbershop get_by_id scope first, while the ranges themselves come from bookings that
// the booking scope would hide from clients.
import * as graphql from 'graphql';
import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';
import { blocksProfessional, dayNumber, parseClock } from './booking.schedule.js';
import { assertBarbershopApprovedForBooking, findOwnBookingId, findSlotHoldingBookings } from './booking.controller.js';

const { GraphQLObjectType, GraphQLNonNull, GraphQLList, GraphQLID, GraphQLString } = graphql;

const BookingBusyRangeType = new GraphQLObjectType({
  name: 'BookingBusyRange',
  description: 'Time held by a confirmed booking. It carries no client or booking details.',
  fields: {
    startTime: { type: GraphQLString, description: "Start of the held time ('HH:mm')." },
    endTime: { type: GraphQLString, description: "End of the services ('HH:mm'); the shop's bufferMinutes follow it." },
    professionalId: { type: GraphQLID, description: 'Professional holding the time; null when the booking holds the whole shop.' },
  },
});

/**
 * Times held by confirmed bookings of an approved barbershop on a date, in clock order. Bookings are
 * read natively, so clients see other clients' taken slots but none of their details. A query runs
 * outside a transaction, so the reads use no session; a booking write rechecks its slot in its own.
 */
export async function listBusyRanges(barbershopId, { date, professionalId, excludeBookingId }, context) {
  if (dayNumber(date) == null) {
    throw new simfinity.SimfinityError("date must use the 'YYYY-MM-DD' format", 'INVALID_BOOKING_TIME', 400);
  }
  // Same code the PostgreSQL runtime returns for a malformed UUID, instead of a raw CastError.
  if (excludeBookingId != null && !mongoose.isValidObjectId(excludeBookingId)) {
    throw new simfinity.SimfinityError('excludeBookingId is not a valid ID', 'NOT_VALID_ID', 400);
  }
  // The barbershop scope lets owners and admins read shops that are not approved; those take no bookings.
  await assertBarbershopApprovedForBooking(barbershopId, null);
  // Like an update's own overlap check, a client's booking does not block its own reschedule.
  const excludeId = excludeBookingId == null ? null : await findOwnBookingId(excludeBookingId, null, context);
  const bookings = await findSlotHoldingBookings(barbershopId, date, null, excludeId);
  return bookings
    .filter((booking) => !professionalId || blocksProfessional(booking.professional, professionalId))
    .map((booking) => ({ startTime: booking.startTime, endTime: booking.endTime, professionalId: booking.professional }))
    .sort((a, b) => (parseClock(a.startTime) ?? Infinity) - (parseClock(b.startTime) ?? Infinity));
}

/**
 * The `busyRanges` field of the barbershop type. `virtual` means no backend stores it: it has no
 * generated input and no filter, sort or aggregation argument or path, and MCP publishes it as the
 * `barbershop_busyRanges` read tool. auth/permissions.js limits it to signed-in users.
 */
export const busyRangesField = {
  type: new GraphQLList(new GraphQLNonNull(BookingBusyRangeType)),
  description: 'Times held by confirmed bookings on a date, without client data. Requires a signed-in user and an approved barbershop.',
  args: {
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
  extensions: { virtual: true },
  resolve: (barbershop, args, context) => listBusyRanges(String(barbershop._id ?? barbershop.id), args, context),
};
