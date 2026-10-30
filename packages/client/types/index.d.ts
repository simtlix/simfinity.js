/** HTTP-only browser client. No server or Node ambient types are required. */
export interface TypeReference { readonly kind: string; readonly name?: string | null; readonly ofType?: TypeReference | null; }
export interface UnwrappedType { name: string; kind: string; isList: boolean; isNonNull: boolean; }
export interface InputValue { readonly name: string; readonly type: string; readonly description?: string | null; readonly hasDefault?: boolean; readonly defaultValue?: string; }
export interface DescriptorOperation { readonly operation: 'get' | 'list' | 'aggregate' | 'add' | 'update' | 'delete' | 'transition' | 'transaction' | 'customQuery' | 'customMutation'; readonly type: string | null; readonly args: readonly InputValue[]; readonly returns: string; readonly description?: string | null; readonly view?: string; readonly action?: string; readonly from?: string | null; readonly to?: string | null; }
export interface DescriptorField extends InputValue { readonly kind?: string; readonly readOnly?: boolean; readonly stateMachine?: boolean; readonly queryable?: boolean; readonly unique?: boolean; readonly relation?: { readonly target: string; readonly embedded: boolean; readonly connectionField: string | null; readonly displayField: string | null; readonly inverseField?: string | null }; readonly args?: readonly InputValue[]; readonly virtual?: { readonly mcp: 'tool' | 'select' | false }; readonly rootInputUsage?: Readonly<{ add?: 'required' | 'optional'; update?: 'required' | 'optional' }>; readonly deprecationReason?: string | null; }
export interface DescriptorStateMachine { readonly field: 'state'; readonly enum: string; readonly initialState: string | null; readonly states: readonly string[]; readonly actions: readonly { readonly name: string; readonly mutation: string; readonly description: string | null; readonly from: string | null; readonly to: string | null }[]; }
export interface DescriptorType { readonly kind: 'entity' | 'object' | 'interface' | 'union' | 'input' | 'enum' | 'scalar'; readonly description?: string | null; readonly stateMachine?: DescriptorStateMachine | null; readonly fields?: readonly DescriptorField[]; readonly values?: readonly { readonly name: string; readonly description?: string | null; readonly deprecationReason?: string | null }[]; readonly endpoints?: Readonly<Partial<Record<'get' | 'list' | 'aggregate' | 'add' | 'update' | 'delete', string>>>; readonly inputs?: Readonly<{ add?: string; update?: string }>; readonly baseScalar?: string | null; readonly isOneOf?: boolean; readonly possibleTypes?: readonly string[]; readonly interfaces?: readonly string[]; }
export interface ClientDescriptorDocument { readonly formatVersion: 1; readonly generator?: { readonly name: string; readonly version: string }; readonly roots: { readonly query: string | null; readonly mutation: string | null }; readonly types: Readonly<Record<string, DescriptorType>>; readonly operations: { readonly query: Readonly<Record<string, DescriptorOperation>>; readonly mutation: Readonly<Record<string, DescriptorOperation>> }; }
export interface ClientRequestInit { method?: string; headers?: Record<string, string>; body?: string; }
export interface ClientResponse { readonly ok: boolean; readonly status: number; json(): Promise<unknown>; }
export type ClientFetch = (url: string, options?: ClientRequestInit) => Promise<ClientResponse>;
export interface SimfinityClientOptions { prepareHeaders?: (headers: Record<string, string>) => unknown; fetch?: ClientFetch; descriptor?: ClientDescriptorDocument; descriptorEndpoint?: string; introspection?: 'extended' | 'standard'; }
export interface FieldExtensions { relation?: { displayField?: string | null; embedded?: boolean | null; connectionField?: string | null; target?: string; inverseField?: string | null } | null; stateMachine?: boolean | null; readOnly?: boolean | null; virtual?: { mcp: 'tool' | 'select' | false }; queryable?: boolean; rootInputUsage?: { add?: 'required' | 'optional'; update?: 'required' | 'optional' }; }
export interface TypeField { name: string; type: UnwrappedType; rawType: TypeReference; args: ArgumentInfo[]; extensions: FieldExtensions | null; hasDefault?: boolean; defaultValue?: unknown; }
export interface TypeInfo { name: string; kind: string; fields: TypeField[]; enumValues: string[]; baseScalar?: string | null; isOneOf?: boolean; possibleTypes?: readonly string[]; interfaces?: readonly string[]; }
export interface ArgumentInfo { name: string; type: TypeReference; hasDefault?: boolean; defaultValue?: unknown; }
export interface OperationInfo { name: string; args: ArgumentInfo[]; returnType: UnwrappedType; rawReturnType: TypeReference; category?: string; typeName?: string | null; view?: string; action?: string; }
export interface SelectionSetResult { selection: string; columns: string[]; sortFieldByColumn: Record<string, string>; fieldTypeByColumn: Record<string, string>; }
export interface QueryNamesForType { pluralQueryName: string | null; singularQueryName: string | null; aggregateQueryName: string | null; }
export interface Transition { action: string; mutationName: string; }
export interface FilterTerm { path?: string; operator?: string; value?: unknown; value2?: unknown; valuePath?: string | null; }
export interface FilterCondition extends FilterTerm { field: string; }
export interface QuantifiedGroup extends FilterGroup { path: string; }
export interface FilterGroup { conditions?: readonly FilterCondition[]; AND?: readonly FilterGroup[]; OR?: readonly FilterGroup[]; ANY?: readonly QuantifiedGroup[]; ALL?: readonly QuantifiedGroup[]; NONE?: readonly QuantifiedGroup[]; }
export interface FieldFilter extends FilterTerm { terms?: readonly FilterTerm[]; quantifier?: 'ANY' | 'ALL' | 'NONE'; }
export interface ExecWithMetaResult<T = unknown> { data: T; extensions: Record<string, unknown> | null; }
export interface QueryBuilder<T = Record<string, unknown>> {
  where(field: string, operator: string, value?: unknown, value2?: unknown): this;
  where(field: string, terms: readonly FilterTerm[]): this;
  where(field: string, filter: FieldFilter): this;
  filter(group: FilterGroup): this; or(groups: readonly FilterGroup[]): this; and(groups: readonly FilterGroup[]): this;
  joinCollection(path: string, fields: string, filter?: readonly FilterTerm[]): this;
  joinObject(path: string, fields: string): this; collectionArgs(path: string, args: Record<string, unknown>): this;
  fields(selection: string): this; page(page: number, size: number, count?: boolean): this;
  sort(field: string, order: 'ASC' | 'DESC'): this; clearSort(): this; autoSelect(): this;
  exec(): Promise<(T[] & { __extensions?: Record<string, unknown> }) | null>;
  execWithMeta(): Promise<ExecWithMetaResult<T[] | null>>;
}
export interface AggregateBuilder<T = Record<string, unknown>> {
  groupBy(field: string): this; fact(operation: string, factName: string, path?: string): this;
  where(field: string, operator: string, value?: unknown, value2?: unknown): this;
  where(field: string, terms: readonly FilterTerm[]): this; where(field: string, filter: FieldFilter): this;
  filter(group: FilterGroup): this; or(groups: readonly FilterGroup[]): this; and(groups: readonly FilterGroup[]): this;
  page(page: number, size: number, count?: boolean): this; sort(field: string, order: 'ASC' | 'DESC'): this; exec(): Promise<T[]>;
}
export interface TransformInputOptions { mode?: 'create' | 'update'; skipFields?: readonly string[]; transientFields?: readonly string[]; preserveEmpty?: boolean; includeCollections?: boolean; inputType?: string; }
export interface CollectionDelta { added?: readonly Record<string, unknown>[]; updated?: readonly Record<string, unknown>[]; deleted?: readonly (string | Record<string, unknown> | null)[]; }
export interface CollectionDeltaOptions extends TransformInputOptions { connectionField?: string | null; }
export interface MutationOptions extends TransformInputOptions { transform?: boolean; }
export interface GraphQLErrorData { message: string; extensions?: Record<string, unknown>; path?: readonly (string | number)[]; locations?: readonly { line: number; column: number }[]; }
export interface GraphQLResponse<T = Record<string, unknown>> { data?: T | null; errors?: GraphQLErrorData[]; extensions?: Record<string, unknown>; }
export default class SimfinityClient {
  constructor(endpoint: string, options?: SimfinityClientOptions);
  init(): Promise<void>; getDescriptor(): ClientDescriptorDocument | null;
  find<T = Record<string, unknown>>(typeName: string): QueryBuilder<T>;
  findView<T = Record<string, unknown>>(name: string, params?: Record<string, unknown>): QueryBuilder<T>;
  getViews(typeName?: string): OperationInfo[];
  aggregate<T = Record<string, unknown>>(typeName: string): AggregateBuilder<T>;
  query<T = unknown>(name: string, args?: Record<string, unknown>, fields?: string): Promise<T>;
  findByParent<T = Record<string, unknown>>(typeName: string, connectionField: string, parentId: string): QueryBuilder<T>;
  search<T = Record<string, unknown>>(typeName: string, searchTerm: string, options?: { displayField?: string | null; page?: number; size?: number }): Promise<T[] | null>;
  getById<T = Record<string, unknown>>(typeName: string, id: string, fields?: string): Promise<T | null>;
  add<T = Record<string, unknown>>(typeName: string, input: Record<string, unknown>, fields?: string, options?: MutationOptions): Promise<T>;
  update<T = Record<string, unknown>>(typeName: string, id: string, input: Record<string, unknown>, fields?: string, options?: MutationOptions): Promise<T | null>;
  delete<T = Record<string, unknown>>(typeName: string, id: string, fields?: string, options?: { version?: number }): Promise<T | null>;
  transition<T = Record<string, unknown>>(typeName: string, action: string, id: string, inputOrFields?: Record<string, unknown> | string, fields?: string): Promise<T | null>;
  transaction<T = Record<string, unknown>>(operations: readonly Record<string, unknown>[], fields?: string, options?: { name?: string }): Promise<T[] | null>;
  customMutation<T = unknown>(name: string, args?: Record<string, unknown>, fields?: string): Promise<T>;
  execute<T = Record<string, unknown>>(query: string, variables?: Record<string, unknown>): Promise<GraphQLResponse<T>>;
  getTypes(): Record<string, TypeInfo>; getQueries(): Record<string, OperationInfo>; getMutations(): Record<string, OperationInfo>;
  buildSelectionSet(typeName: string): SelectionSetResult;
  getFieldExtensions(typeName: string, fieldName: string): FieldExtensions | null;
  getDisplayField(typeName: string, fieldName: string): string | null;
  isEmbeddedField(typeName: string, fieldName: string): boolean;
  getConnectionField(typeName: string, fieldName: string): string | null;
  isStateMachineField(typeName: string, fieldName: string): boolean;
  isReadOnlyField(typeName: string, fieldName: string): boolean;
  getEnumValues(typeName: string): string[]; getFieldsOfType(typeName: string): TypeField[];
  getDescriptionFieldType(typeName: string, descriptionField: string): string;
  getTypeNameForQuery(queryName: string): string | null;
  getPluralQueryName(typeName: string): string | null; getSingularQueryName(typeName: string): string | null;
  getListEntityNames(): string[]; getListEntityNamesOfType(typeName: string): string[];
  getQueryNamesForType(typeName: string): QueryNamesForType;
  getActualScalarType(scalarName: string): string | null; isNumericScalar(scalarName: string): boolean;
  isBooleanScalar(scalarName: string): boolean; isDateTimeScalar(scalarName: string): boolean;
  getStateMachineFields(typeName: string): string[]; getAvailableTransitions(typeName: string): Transition[];
  transformInput(typeName: string, rawInput: Record<string, unknown>, options?: TransformInputOptions): Record<string, unknown>;
  transformCollectionDelta(typeName: string, delta: CollectionDelta, options?: CollectionDeltaOptions): Record<string, unknown>;
  static condition(field: string, operator: string, value?: unknown, path?: string): FilterGroup;
}
