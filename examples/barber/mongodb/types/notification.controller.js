/** Sets `doc.createdAt` to the current ISO timestamp when not already set. */
export function applyNotificationCreatedAt(doc) {
  if (!doc.createdAt) {
    doc.createdAt = new Date().toISOString();
  }
}

export const notificationController = {
  onSaving: async (doc) => {
    applyNotificationCreatedAt(doc);
  },
};
