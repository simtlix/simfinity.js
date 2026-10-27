// Module-local ownership shared by consumers of this exact core installation. The snapshot is
// registration data only; descriptor formats and HTTP belong to opt-in consumer packages.
const registrationsBySchema = new WeakMap();
const transactionBySchema = new WeakMap();

export const captureSchemaRegistrations = (schema, registrations, queryable, transactionField) => {
  const snapshot = registrations.map((entry) => Object.freeze({
    ...entry,
    stateMachine: entry.stateMachine ? Object.freeze({
      initialState: entry.stateMachine.initialState
        ? Object.freeze({ ...entry.stateMachine.initialState }) : null,
    }) : null,
    queryableFields: Object.freeze(Object.fromEntries(Object.values(entry.gqltype.getFields())
      .map((field) => [field.name, queryable(entry.gqltype, field)]))),
  }));
  registrationsBySchema.set(schema, Object.freeze(snapshot));
  if (transactionField) transactionBySchema.set(schema, transactionField);
};

export const schemaRegistrations = (schema) => registrationsBySchema.get(schema);

// Exact generated field identity, scoped to the schema that owns its registrations.
export const schemaTransaction = (schema) => transactionBySchema.get(schema);
