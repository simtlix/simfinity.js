# @simtlix/simfinity-descriptor

Optional schema-owned JSON client metadata for Simfinity. Depends on the exact
matching version of `@simtlix/simfinity-core`; supports both database facades.
Available since 3.15.0. Install it
as a direct application dependency at the version of your Simfinity runtime.

```javascript
import { buildClientDescriptor, createClientDescriptorHandler } from '@simtlix/simfinity-descriptor';
const descriptor = buildClientDescriptor(schema);
app.all('/graphql-metadata', createClientDescriptorHandler(schema, { authorize: 'public' }));
```

The application supplies its exact `createSchema()` result and explicitly chooses
public access or an authorization function. Importing this package does not patch
GraphQL introspection. See the [client descriptor guide](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html)
for gated access, root input hints, early opt-out and client migration limits.

`rootInputUsage` reports whether a field is required or optional in the actual
generated root add/update input. Nested collection inputs can omit the inverse
reference supplied by their parent. Descriptors do not serialize arbitrary
validators or determine dynamic permissions. Finish declarations before the first
build; create a new schema and handler for metadata changes. Clones and composed
schemas do not inherit ownership.

Core remains dependency-free; structural HTTP declarations need no Node ambient
types. Directly importing `@simtlix/simfinity-core/introspection` requires core as
a direct dependency pinned to the facade's version. The 3.x introspection default
remains enabled, and clients selecting `__Field.extensions` must migrate before
using the early opt-out.
