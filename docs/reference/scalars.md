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
| `createBoundedStringScalar(name, min, max)` | String with inclusive length bounds. |
| `createBoundedIntScalar(name, min, max)` | GraphQL integer with inclusive numeric bounds. |
| `createBoundedFloatScalar(name, min, max)` | GraphQL float with inclusive numeric bounds. |
| `createPatternStringScalar(name, pattern, message)` | String matching a `RegExp` or regex string. |

Pass `undefined` for a bound you do not need. Reuse a single scalar instance for each GraphQL name instead of creating different instances with the same name. For regex validators, prefer patterns without stateful `g` or `y` flags.

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

The scalar exposes `baseScalarType`, which lets Simfinity map it to an appropriate backend storage type. PostgreSQL accepts custom scalars only when this chain resolves to a recognized native scalar. Validation also runs during output serialization, so invalid stored values can produce GraphQL response errors.

### Literal behavior

The factory checks inline AST kinds before delegating to the base scalar. Float-based validated scalars require a float literal such as `4.0`; an integer literal such as `4` is rejected by this check. ID-based validated scalars require string literals. JSON variables go through `parseValue` instead of this literal check.

The built-in scalar failures are ordinary `Error` instances. Their presentation depends on your GraphQL server's error handling; they do not automatically carry the `VALIDATION_ERROR` code produced by declarative field validators.
