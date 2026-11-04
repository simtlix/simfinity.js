/** Best-effort after-commit demonstration. Replace this log with a bounded delivery integration. */
export function scheduleBookingReminder(booking, event) {
  if (process.env.REMINDER_JOBS_ENABLED !== 'true') return;
  // stdout belongs to JSON-RPC when this application runs through MCP stdio.
  console.error('[reminderStub]', event, {
    bookingId: String(booking._id ?? booking.id),
    scheduledDate: booking.scheduledDate,
    startTime: booking.startTime,
  });
}
