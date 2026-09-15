declare module "@simtlix/simfinity-js-client" {

  interface FieldExtensions {
    relation?: {
      displayField?: string | null;
      embedded?: boolean | null;
      connectionField?: string | null;
    } | null;
    stateMachine?: boolean | null;
    readOnly?: boolean | null;
  }

  interface TypeField {
    name: string;
    type: { kind: string; name: string; isList?: boolean };
    rawType: unknown;
    extensions?: FieldExtensions | null;
  }

  interface SelectionSetResult {
    selection: string;
    columns: string[];
    sortFieldByColumn: Record<string, string>;
    fieldTypeByColumn: Record<string, string>;
  }

  interface QueryNamesForType {
    pluralQueryName: string | null;
    singularQueryName: string | null;
    aggregateQueryName: string | null;
  }

  interface Transition {
    action: string;
    mutationName: string;
  }

  interface TransformInputOptions {
    skipFields?: string[];
    transientFields?: string[];
    mode?: "create" | "update";
    [key: string]: unknown;
  }

  interface CollectionDelta {
    added?: Record<string, unknown>[];
    updated?: Record<string, unknown>[];
    deleted?: (string | Record<string, unknown>)[];
  }

  interface CollectionDeltaOptions {
    connectionField?: string | null;
  }

  interface ExecWithMetaResult {
    data: unknown;
    extensions: Record<string, unknown> | null;
  }

  interface FilterTerm {
    path: string;
    operator: string;
    value: unknown;
  }

  class QueryBuilder {
    where(field: string, operator: string, value: unknown, value2?: unknown): this;
    where(field: string, terms: FilterTerm[]): this;
    joinCollection(path: string, fields: string, filter?: FilterTerm[]): this;
    joinObject(path: string, fields: string): this;
    fields(selectionString: string): this;
    page(page: number, size: number, count?: boolean): this;
    sort(field: string, order: "ASC" | "DESC"): this;
    clearSort(): this;
    autoSelect(): this;
    exec(): Promise<unknown>;
    execWithMeta(): Promise<ExecWithMetaResult>;
  }

  class AggregateBuilder {
    groupBy(field: string): this;
    fact(operation: string, factName: string, path?: string): this;
    where(field: string, operator: string, value: unknown, value2?: unknown): this;
    where(field: string, terms: FilterTerm[]): this;
    page(page: number, size: number, count?: boolean): this;
    sort(field: string, order: "ASC" | "DESC"): this;
    exec(): Promise<unknown>;
  }

  export interface SimfinityClientOptions {
    prepareHeaders?: (headers: Record<string, string>) => void;
  }

  class SimfinityClient {
    constructor(endpoint: string, options?: SimfinityClientOptions);

    init(): Promise<void>;

    find(typeName: string): QueryBuilder;
    aggregate(typeName: string): AggregateBuilder;
    findByParent(typeName: string, connectionField: string, parentId: string): QueryBuilder;
    search(typeName: string, searchTerm: string, options?: { displayField?: string | null; page?: number; size?: number }): Promise<unknown>;

    getById(typeName: string, id: string, fields?: string): Promise<unknown>;
    add(typeName: string, input: Record<string, unknown>, fields?: string, options?: { transform?: boolean } & TransformInputOptions): Promise<unknown>;
    update(typeName: string, id: string, input: Record<string, unknown>, fields?: string, options?: { transform?: boolean } & TransformInputOptions): Promise<unknown>;
    delete(typeName: string, id: string, fields?: string): Promise<unknown>;

    transition(typeName: string, action: string, id: string, inputOrFields?: Record<string, unknown> | string, fields?: string): Promise<unknown>;
    customMutation(mutationName: string, args?: Record<string, unknown>, fields?: string): Promise<unknown>;
    execute(query: string, variables?: Record<string, unknown>): Promise<unknown>;

    getTypes(): Record<string, unknown>;
    getQueries(): Record<string, unknown>;
    getMutations(): Record<string, unknown>;

    buildSelectionSet(typeName: string): SelectionSetResult;

    getFieldExtensions(typeName: string, fieldName: string): FieldExtensions | null;
    getDisplayField(typeName: string, fieldName: string): string | null;
    isEmbeddedField(typeName: string, fieldName: string): boolean;
    getConnectionField(typeName: string, fieldName: string): string | null;
    isStateMachineField(typeName: string, fieldName: string): boolean;
    isReadOnlyField(typeName: string, fieldName: string): boolean;
    getEnumValues(typeName: string): string[];
    getFieldsOfType(typeName: string): TypeField[];
    getDescriptionFieldType(typeName: string, descriptionField: string): string;

    getTypeNameForQuery(queryName: string): string | null;
    getPluralQueryName(typeName: string): string | null;
    getSingularQueryName(typeName: string): string | null;
    getListEntityNames(): string[];
    getListEntityNamesOfType(typeName: string): string[];
    getQueryNamesForType(typeName: string): QueryNamesForType;

    getActualScalarType(scalarName: string): string;
    isNumericScalar(scalarName: string): boolean;
    isBooleanScalar(scalarName: string): boolean;
    isDateTimeScalar(scalarName: string): boolean;

    getStateMachineFields(typeName: string): string[];
    getAvailableTransitions(typeName: string): Transition[];

    transformInput(typeName: string, rawInput: Record<string, unknown>, options?: TransformInputOptions): Record<string, unknown>;
    transformCollectionDelta(collectionTypeName: string, delta: CollectionDelta, options?: CollectionDeltaOptions): Record<string, unknown>;
  }

  export default SimfinityClient;
  export type {
    FieldExtensions,
    TypeField,
    SelectionSetResult,
    QueryNamesForType,
    Transition,
    TransformInputOptions,
    CollectionDelta,
    CollectionDeltaOptions,
    ExecWithMetaResult,
    FilterTerm,
    QueryBuilder,
    AggregateBuilder,
  };
}
