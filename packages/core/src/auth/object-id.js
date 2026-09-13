const objectIdTypes = new Map();
const canonicalObjectId = /^[0-9a-f]{24}$/;

/** Internal adapter hook; database facades register only their authentic ObjectId constructor. */
export const registerObjectIdType = (ObjectId, toHexString) => {
  if (typeof ObjectId !== 'function' || typeof toHexString !== 'function') {
    throw new TypeError('ObjectId constructor and toHexString method are required');
  }
  if (!objectIdTypes.has(ObjectId)) objectIdTypes.set(ObjectId, toHexString);
};

/** Normalize only instances backed by a registered ObjectId implementation. */
export const normalizeObjectId = (value) => {
  for (const [ObjectId, toHexString] of objectIdTypes) {
    if (!(value instanceof ObjectId)) continue;
    try {
      const normalized = toHexString.call(value);
      return typeof normalized === 'string' && canonicalObjectId.test(normalized)
        ? normalized : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
