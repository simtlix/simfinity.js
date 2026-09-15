/** Strips `owner` from the update payload so ownership cannot be changed via mutations. */
export function stripOwnerFromUpdatePayload(doc) {
  delete doc.owner;
}

export const barbershopController = {
  onUpdating: async (_id, doc, _session, _context) => {
    stripOwnerFromUpdatePayload(doc);
  },
};
