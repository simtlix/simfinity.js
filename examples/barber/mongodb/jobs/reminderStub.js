/**
 * Stub for future Bull/cron reminder jobs (email/WhatsApp).
 * Wire queue + templates when providers are configured.
 */
export function scheduleReminderStub() {
  if (process.env.REMINDER_JOBS_ENABLED === 'true') {
    console.log('[reminderStub] jobs would run here');
  }
}
