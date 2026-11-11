import { configureIntrospection } from '@simtlix/simfinity-core/introspection';

// Clients read field metadata from the descriptor endpoint (GET /graphql-metadata), so this server
// leaves graphql-js's shared `__Field` type unpatched. The call must run before the runtime loads:
// index.yoga.js imports this module first, and it imports nothing else.
configureIntrospection({ fieldExtensions: false });
