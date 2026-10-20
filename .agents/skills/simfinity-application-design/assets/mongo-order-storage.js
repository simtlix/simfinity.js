// All calls use the transaction supplied by the controller. These native reads
// intentionally see uncommitted lines; generated root queries cannot do that.
export const mongoOrderStorage = (api) => ({
  get: (type, id, session) => api.getModel(type).findById(id).session(session).lean(),
  lines: (type, orderId, session) => api.getModel(type).find({ orderId }).session(session).lean(),
  setTotal: (type, id, total, session) => api.getModel(type).updateOne({ _id: id }, { $set: { total } }, { session }),
});
