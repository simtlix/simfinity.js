import mongoose from 'mongoose';

/** Open an independently owned database. Closing it never closes another runtime's connection. */
export const openMongoDatabase = async (uri, options = {}) => {
  const namespace = new mongoose.Mongoose();
  const connection = namespace.createConnection(uri, {
    autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000, ...options,
  });
  try {
    await connection.asPromise();
  } catch (error) {
    await connection.destroy();
    throw error;
  }
  return Object.freeze({ database: connection.db, close: () => connection.destroy() });
};

/** Create/cast an identifier at the adapter boundary; no model/driver is exposed. */
export const mongoId = (value) => new mongoose.Types.ObjectId(value);
/** Accept a stored ObjectId or its canonical hex representation. */
export const isMongoId = (value) => mongoose.isObjectIdOrHexString(value);
/** Encode dates and identifiers for JSON without exposing backend constructors. */
export const serializeMongoValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(serializeMongoValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeMongoValue(item)]));
  }
  return value;
};

/** Bind models to a borrowed client, or retain the legacy default connection. */
export const modelConnectionFor = (options) => {
  if (!options || !Object.hasOwn(options, 'database')) return mongoose.connection;
  const namespace = new mongoose.Mongoose();
  const connection = namespace.createConnection();
  if (!options.database) return connection;
  return connection.setClient(options.database.client).useDb(options.database.databaseName);
};
