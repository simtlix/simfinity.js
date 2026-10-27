import type { GraphQLSchema } from 'graphql';

export interface ClientDescriptorInputValue {
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly deprecationReason?: string | null;
  readonly hasDefault: boolean;
  /** External GraphQL literal; omitted for unrepresentable custom defaults. */
  readonly defaultValue?: string;
}
export interface ClientDescriptorRelation {
  readonly target: string;
  readonly embedded: boolean;
  readonly connectionField: string | null;
  readonly displayField: string | null;
  readonly inverseField: string | null;
}
export interface ClientDescriptorField {
  readonly name: string;
  readonly type: string;
  readonly kind: 'scalar' | 'enum' | 'embedded' | 'reference' | 'collection' | 'object' | 'interface' | 'union';
  readonly description: string | null;
  readonly deprecationReason?: string | null;
  readonly readOnly: boolean;
  readonly unique: boolean;
  readonly stateMachine: boolean;
  readonly queryable?: boolean;
  /** Usage in this schema's generated root add/update inputs, not permissions or nested inputs. */
  readonly rootInputUsage?: Readonly<{ add?: 'required' | 'optional'; update?: 'required' | 'optional' }>;
  readonly virtual?: Readonly<{ mcp: 'tool' | 'select' | false }>;
  readonly relation?: ClientDescriptorRelation;
  readonly args?: readonly ClientDescriptorInputValue[];
}
export interface ClientDescriptorOperation {
  readonly type: string | null;
  readonly operation: 'get' | 'list' | 'aggregate' | 'add' | 'update' | 'delete' | 'transition' | 'transaction' | 'customQuery' | 'customMutation';
  readonly args: readonly ClientDescriptorInputValue[];
  readonly returns: string;
  readonly description: string | null;
  readonly deprecationReason?: string | null;
  readonly view?: string;
  readonly action?: string;
  readonly from?: string | null;
  readonly to?: string | null;
}
export interface ClientDescriptorStateMachine {
  readonly field: 'state';
  readonly enum: string;
  readonly initialState: string | null;
  readonly states: readonly string[];
  readonly actions: readonly Readonly<{ name: string; mutation: string; description: string | null; from: string | null; to: string | null }>[];
}
export interface ClientDescriptorType {
  readonly kind: 'entity' | 'object' | 'interface' | 'union' | 'input' | 'enum' | 'scalar';
  readonly description: string | null;
  readonly endpoints?: Readonly<Partial<Record<'get' | 'list' | 'aggregate' | 'add' | 'update' | 'delete', string>>>;
  readonly inputs?: Readonly<{ add?: string; update?: string }>;
  readonly stateMachine?: ClientDescriptorStateMachine | null;
  readonly fields?: readonly (ClientDescriptorField | ClientDescriptorInputValue)[];
  readonly isOneOf?: boolean;
  readonly interfaces?: readonly string[];
  readonly possibleTypes?: readonly string[];
  readonly values?: readonly Readonly<{ name: string; description: string | null; deprecationReason: string | null }>[];
  readonly baseScalar?: string | null;
}
export interface ClientDescriptor {
  readonly formatVersion: 1;
  readonly generator: Readonly<{ name: '@simtlix/simfinity-descriptor'; version: string }>;
  readonly roots: Readonly<{ query: string | null; mutation: string | null }>;
  readonly types: Readonly<Record<string, ClientDescriptorType>>;
  readonly operations: Readonly<{ query: Readonly<Record<string, ClientDescriptorOperation>>; mutation: Readonly<Record<string, ClientDescriptorOperation>> }>;
}
/** Immutable metadata of this exact createSchema result; rejects transformed/foreign schemas. */
export function buildClientDescriptor(schema: GraphQLSchema): ClientDescriptor;

/** Minimal structural Node/Express request; no Node ambient types are required. */
export interface DescriptorRequest {
  method?: string | undefined;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}
export interface DescriptorResponse {
  statusCode: number;
  readonly headersSent?: boolean;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): void;
  end(body?: string): unknown;
}
export interface ClientDescriptorHandlerOptions<Context = unknown> {
  authorize: 'public' | ((req: DescriptorRequest, context: Context) => boolean | void | Promise<boolean | void>);
  context?: Context | ((req: DescriptorRequest) => Context | Promise<Context>);
  /** Reports unexpected failures, not expected 401/403 denials. */
  onError?: (error: unknown, req: DescriptorRequest, res: DescriptorResponse) => void | Promise<void>;
}
export function createClientDescriptorHandler<Context = unknown>(schema: GraphQLSchema, options: ClientDescriptorHandlerOptions<Context>): (req: DescriptorRequest, res: DescriptorResponse) => Promise<void>;
