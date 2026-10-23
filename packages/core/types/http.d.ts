import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GraphQLSchema } from 'graphql';

export interface ClientDescriptorHandlerOptions<Context = unknown> {
  authorize: 'public' | ((req: IncomingMessage, context: Context) => boolean | void | Promise<boolean | void>);
  context?: Context | ((req: IncomingMessage) => Context | Promise<Context>);
  onError?: (error: unknown, req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** Explicitly mounted GET/HEAD endpoint. Context and authorization also run before 304 responses. */
export function createClientDescriptorHandler<Context = unknown>(schema: GraphQLSchema, options: ClientDescriptorHandlerOptions<Context>): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
