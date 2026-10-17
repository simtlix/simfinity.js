export const postgresOrderStorage = (api, namespace) => {
  // This example accepts a simple configured schema name, not arbitrary SQL.
  if (!/^[a-z_][a-z0-9_]*$/.test(namespace)) throw new TypeError('Invalid example schema name');
  return {
    get: (type, id, session) => api.getModel(type).findById(id, { session }),
    async lines(type, orderId, session) {
      // Avoid the native Model.find page limit when computing the complete total.
      const { rows } = await session.query(`SELECT quantity, "unitPrice" FROM "${namespace}"."SkillLine" WHERE "orderId" = $1`, [orderId]);
      return rows;
    },
    setTotal: (type, id, total, session) => api.getModel(type).update(id, { total }, { session }),
  };
};
