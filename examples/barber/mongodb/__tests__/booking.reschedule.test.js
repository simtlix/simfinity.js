import { describe, expect, it, vi } from 'vitest';
import { graphql, GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '@simtlix/simfinity-js';
import { BookingStateEnum, bookingStateMachine } from '../types/booking.stateMachine.js';

// Match the CJS GraphQL entry point used by the external, released runtime in Vitest.
vi.mock('graphql', async () => import('graphql/index.js'));

// Exercise the app's action through the released runtime. Only persistence is in memory.
function fixture(state) {
  let stored = { _id: 'booking-id', state, startTime: '10:00', notes: 'original' };
  let activeTransaction = null;
  const adapter = {
    createModel: () => ({}),
    castId: String,
    withTransaction: async (_session, body) => {
      const before = structuredClone(stored);
      activeTransaction = {};
      try { return await body(activeTransaction); }
      catch (error) { stored = before; throw error; }
      finally { activeTransaction = null; }
    },
    getById: async (_model, _id, session) => {
      expect(session).toBe(activeTransaction);
      return structuredClone(stored);
    },
    prepareUpdate: (set) => set,
    update: async (_model, _id, changes, session) => {
      expect(session).toBe(activeTransaction);
      Object.assign(stored, changes);
      return structuredClone(stored);
    },
    toObject: (record) => record,
  };
  const runtime = createRuntime(adapter);
  const Booking = new GraphQLObjectType({ name: 'RescheduleBooking', fields: {
    id: { type: GraphQLID }, state: { type: BookingStateEnum }, startTime: { type: GraphQLString }, notes: { type: GraphQLString },
  } });
  runtime.connect(null, Booking, 'booking', 'bookings', null, null, bookingStateMachine);
  const schema = runtime.createSchema();
  return {
    execute: (operation, fields) => graphql({ schema, source: `mutation { ${operation}(input: { id: "booking-id", ${fields} }) { id state startTime notes } }` }),
    record: () => stored,
  };
}

describe('confirmed booking reschedule action', () => {
  it('moves a confirmed booking while retaining its identity and state', async () => {
    const f = fixture('CONFIRMED');
    const result = await f.execute('reschedule_booking', 'startTime: "11:00"');
    expect(result.errors).toBeUndefined();
    expect(result.data.reschedule_booking).toMatchObject({ id: 'booking-id', state: 'CONFIRMED', startTime: '11:00' });
  });

  it.each(['CANCELLED_BY_SHOP', 'CANCELLED_BY_CLIENT', 'COMPLETED', 'NO_SHOW'])('rejects a stale reschedule after the booking becomes %s', async (state) => {
    const f = fixture(state);
    const result = await f.execute('reschedule_booking', 'startTime: "11:00"');
    expect(result.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect(f.record()).toMatchObject({ state, startTime: '10:00', notes: 'original' });
  });

  it('keeps ordinary edits available for historical bookings', async () => {
    const f = fixture('COMPLETED');
    const result = await f.execute('updatebooking', 'notes: "Corrected note"');
    expect(result.errors).toBeUndefined();
    expect(result.data.updatebooking).toMatchObject({ state: 'COMPLETED', startTime: '10:00', notes: 'Corrected note' });
  });
});
