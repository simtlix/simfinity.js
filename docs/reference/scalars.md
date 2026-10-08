---
title: Scalars
description: Built-in validated scalars and factories for reusable domain-specific GraphQL values.
---

# Scalars

Use validated scalars when a constraint belongs to the GraphQL value itself, such as an email address or a bounded rating. They validate variables, inline literals, and serialized output. Use [field validators](/guide/validation) when the constraint belongs to an operation or field.

```javascript
import { scalars } from '@simtlix/simfinity-core';

const { EmailScalar, createBoundedFloatScalar } = scalars;
const RatingScalar = createBoundedFloatScalar('Rating', 0, 10);
```

## Built-in scalars

| Export on `scalars` | GraphQL name | Validation |
| --- | --- | --- |
| `EmailScalar` | `Email_String` | Basic email shape: non-whitespace text around `@` and a dotted domain. |
| `URLScalar` | `URL_String` | Accepted by JavaScript's `URL` constructor. |
| `PositiveIntScalar` | `PositiveInt_Int` | GraphQL integer greater than zero. |
| `PositiveFloatScalar` | `PositiveFloat_Float` | GraphQL float greater than zero. |

The email scalar checks format; it does not verify a mailbox. The URL scalar does not restrict the protocol to HTTP or HTTPS. Add a custom constraint if your field needs a narrower rule.

## Scalar factories

| Factory | Result |
| --- | --- |
| `createBoundedStringScalar(name, min, max)` | String with inclusive length bounds; either bound can be omitted. |
| `createBoundedIntScalar(name, min, max)` | GraphQL integer with inclusive numeric bounds; either bound can be omitted. |
| `createBoundedFloatScalar(name, min, max)` | GraphQL float with inclusive numeric bounds; either bound can be omitted. |
| `createPatternStringScalar(name, pattern, message)` | String matching a `RegExp` or regex string. |

Pass `undefined` or `null` for a bound you do not need. The scalar's description then names only the bounds you set, such as `A string with at most 120 characters`, `An integer of at least 0` or `A float`. With both bounds it reads `A string with length between 2 and 120 characters`, `An integer between 0 and 120` or `A float between 0 and 10`. A `NaN` bound is ignored, both in checks and in the description. Reuse a single scalar instance for each GraphQL name instead of creating different instances with the same name.

The `scalars` namespace is also available, with TypeScript declarations, from the `@simtlix/simfinity-core/scalars` subpath.

`createPatternStringScalar` copies the pattern when the scalar is created and tests every value from its first character. A `g` flag has no effect between values, a `y` flag anchors each match at the start of the value, and later changes to your `RegExp` object, including its `lastIndex`, do not affect the scalar. The pattern must be a `RegExp` or a string; any other value throws `TypeError` when the scalar is created.

```javascript
import { GraphQLObjectType, GraphQLID } from 'graphql';
import { scalars } from '@simtlix/simfinity-core';

const TitleScalar = scalars.createBoundedStringScalar('Title', 2, 120);
const SlugScalar = scalars.createPatternStringScalar(
  'Slug',
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'Use lowercase words separated by hyphens',
);

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: {
    id: { type: GraphQLID },
    title: { type: TitleScalar },
    slug: { type: SlugScalar },
  },
});
```

## createValidatedScalar

This factory is a named package export:

```javascript
import { GraphQLString } from 'graphql';
import { createValidatedScalar } from '@simtlix/simfinity-core';

const HTTPSURLScalar = createValidatedScalar(
  'HTTPSURL',
  'An absolute HTTPS URL',
  GraphQLString,
  (value) => {
    if (new URL(value).protocol !== 'https:') {
      throw new Error('An HTTPS URL is required');
    }
  },
);
```

The resulting GraphQL name is `HTTPSURL_String`. The supplied base must be a `GraphQLScalarType`. The synchronous validation callback should throw on invalid input; returning `false` does not reject a value.

The callback receives the base scalar's internal value. The base parses variables and inline literals first, so a DateTime base passes the parsed `Date`, and an ID base passes a string even for an integer variable. Base coercion errors, such as a number sent to a String-based scalar, are reported before the callback runs. Input that the base rejects by returning `undefined` is reported by GraphQL without calling the callback. On output, the callback receives the resolver's value before the base serializes it. In a chain of validated scalars, input runs the innermost callback first and output runs the outermost first. Keep callbacks pure and cheap: GraphQL can parse an inline literal more than once per request.

The scalar exposes `baseScalarType`, which lets Simfinity map it to an appropriate backend storage type. PostgreSQL accepts custom scalars only when this chain resolves to a recognized native scalar. You can also set `baseScalarType` on your own custom scalar as a storage hint; it affects only backend storage and MCP input schemas, never which literals the scalar accepts. MCP output schemas publish such a scalar without a JSON type, because its own `serialize` decides what it returns; only validated scalars, which serialize through their base, keep their root's JSON type there. Validation also runs during output serialization, so invalid stored values can produce GraphQL response errors.

### Literal behavior

The factory checks inline AST kinds against the root of the chain before delegating to the base scalar. It follows only scalars created by `createValidatedScalar`, so a scalar built on `PositiveIntScalar` accepts `4` just like one built on `GraphQLInt`. String- and ID-rooted validated scalars require string literals, Int-rooted ones integer literals, and Boolean-rooted ones boolean literals. Float-rooted ones accept float and integer literals, such as `4.0` and `4`, as `GraphQLFloat` does; the callback receives the same number either way. This keeps an integral default such as `defaultValue: 5`, which GraphQL prints as `5`, valid in MCP tools and introspection.

Any other scalar is the root, even if you set a `baseScalarType` storage hint on it. For a custom root such as `DateTime`, the factory does not check the kind, and the root's own `parseLiteral` decides which literals are valid. JSON variables skip this literal check: the base's `parseValue` parses them, then the callback validates them.

The built-in scalar failures are ordinary `Error` instances. Their presentation depends on your GraphQL server's error handling; they do not automatically carry the `VALIDATION_ERROR` code produced by declarative field validators. [`buildErrorFormatter`](./errors#builderrorformatter) reports them as `BAD_REQUEST` (400) with GraphQL's message, such as `Variable "$input" got invalid value "nope" at "input.email"; Expected type "Email_String". Invalid email format`.
