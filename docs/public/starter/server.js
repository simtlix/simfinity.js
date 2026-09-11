import { createServer } from 'node:http';
import { createYoga } from 'graphql-yoga';
import * as simfinity from '@simtlix/simfinity-js';
import { schema } from './schema.js';

const yoga = createYoga({
  schema,
  plugins: [simfinity.plugins.envelopCountPlugin()],
});

const port = Number(process.env.PORT || 4000);
createServer(yoga).listen(port, '127.0.0.1', () => {
  console.log(`GraphQL ready at http://localhost:${port}/graphql`);
});
