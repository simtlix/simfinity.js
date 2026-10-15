import { castModelId } from './ids.js';
import { buildReadStages } from './pipeline-stages.js';

const CONDITIONAL_QUERY_OPTIONS = { sanitizeFilter: false, strictQuery: false };
const RETURN_UPDATED_DOCUMENT = { new: true };

// Never merge the condition into the identity: it must not replace the key.
const matchIdAndFilter = (id, filter) => ({
  $and: [{ _id: id }, filter],
});

const requiredIdentity = (Model, requiredId) => {
  if (requiredId == null) return [];
  return [{ _id: castModelId(Model, requiredId) }];
};

export const buildRecordReadPipeline = (Model, id, { requiredId, storage, projection }) => {
  const predicates = [
    { _id: castModelId(Model, id) },
    ...requiredIdentity(Model, requiredId),
    storage?.filter,
  ].filter(Boolean);

  return [
    { $match: { $and: predicates } },
    ...buildReadStages({ projection }),
    { $limit: 1 },
  ];
};

// Retain the distinct model statics and filter shapes: hooks can observe both.
export const createRecordRead = (Model, id, { projection, requiredId, storage }) => {
  if (storage?.filter) {
    return Model.findOne(
      matchIdAndFilter(id, storage.filter), projection, { ...CONDITIONAL_QUERY_OPTIONS },
    );
  }
  if (requiredId != null) {
    return Model.findOne(matchIdAndFilter(requiredId, { _id: id }), projection);
  }
  return Model.findById(id, projection);
};

export const createRecordUpdate = (Model, id, update, storage) => {
  if (storage?.filter === undefined) {
    return Model.findByIdAndUpdate(id, update, { ...RETURN_UPDATED_DOCUMENT });
  }
  return Model.findOneAndUpdate(
    matchIdAndFilter(id, storage.filter),
    update,
    { ...CONDITIONAL_QUERY_OPTIONS, ...RETURN_UPDATED_DOCUMENT },
  );
};

export const createRecordDelete = (Model, id, storage) => {
  if (storage?.filter === undefined) {
    return Model.findByIdAndDelete(id);
  }
  return Model.findOneAndDelete(
    matchIdAndFilter(id, storage.filter), { ...CONDITIONAL_QUERY_OPTIONS },
  );
};
