import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingController } from '../types/booking.controller.js';
import * as reminders from '../jobs/reminderStub.js';

const record = { id: 'booking-id', scheduledDate: '2030-01-01', startTime: '10:00' };
const expected = { bookingId: 'booking-id', scheduledDate: record.scheduledDate, startTime: record.startTime };
beforeEach(() => {
  vi.stubEnv('REMINDER_JOBS_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('booking reminders after commit', () => {
  it('onSaveCommitted schedules a created reminder', () => {
    bookingController.onSaveCommitted(record);
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[reminderStub]', 'created', expected);
  });
  it.each([['reschedule', 'rescheduled'], ['cancelbyclient', 'cancelled'], ['cancelbyshop', 'cancelled']])('maps %s to %s', (action, event) => {
    bookingController.onTransitionCommitted(record, action);
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[reminderStub]', event, expected);
  });
  it('other actions schedule nothing', () => {
    for (const action of ['complete', 'noshow', 'unknown']) bookingController.onTransitionCommitted(record, action);
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each([undefined, 'false', 'TRUE', '1'])('logs nothing when enabled is %s', (enabled) => {
    vi.stubEnv('REMINDER_JOBS_ENABLED', enabled);
    reminders.scheduleBookingReminder(record, 'created');
    expect(console.error).not.toHaveBeenCalled();
  });
  it('normalizes native MongoDB identifiers and selects only reminder fields', () => {
    reminders.scheduleBookingReminder({ ...record, _id: { toString: () => 'mongo-id' }, notes: 'private notes' }, 'created');
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[reminderStub]', 'created', { ...expected, bookingId: 'mongo-id' });
  });
});
