---
title: Validation
description: Enforce field and cross-field rules with Simfinity validators, GraphQL scalar validation, and structured errors.
---

# Validation

Use GraphQL types to describe the shape of an input and validators to express the rules for accepting it. Simfinity executes validation while materializing creation and update inputs, before controller hooks and persistence.

## Add a field validator

Each helper returns an object containing `CREATE` and `UPDATE` validator arrays. Assign it to a field's `extensions.validations`:

```javascript
import {
  GraphQLID,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { validators } from '@simtlix/simfinity-core';

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: {
    id: { type: GraphQLID },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      extensions: {
        validations: validators.stringLength('Name', 2, 120),
      },
    },
    year: {
      type: GraphQLInt,
      extensions: {
        validations: validators.numberRange('Year', 1900, 2100),
      },
    },
  },
});
```

`stringLength()` requires a value on creation even when the GraphQL field is nullable. Other built-in helpers skip missing values. On update, the built-in helpers skip both `undefined` and `null`, letting partial updates omit a field.

## Available helpers

| Helper | Rule |
| --- | --- |
| `stringLength(name, min, max)` | String length within the supplied bounds, where `undefined` or `null` means no bound; required on create |
| `maxLength(name, max)` | Maximum string length |
| `pattern(name, regex, message?)` | Match a regular expression |
| `email()` | Basic email address format |
| `url()` | Accepted by JavaScript's URL parser |
| `numberRange(name, min, max)` | Number within inclusive bounds, where `undefined` or `null` means no bound |
| `positive(name)` | Number greater than zero |
| `arrayLength(name, maxItems, itemValidator?)` | Maximum array size, where `undefined` or `null` means no limit; item rules: a validator, a helper result or an array of them |
| `dateFormat(name, format?)` | A date JavaScript can parse; ISO (`YYYY-MM-DD…`) and slashed `MM/DD/YYYY` strings must be real calendar dates; optional `YYYY-MM-DD` shape check |
| `futureDate(name)` | Date later than the current time, with the same date checks as `dateFormat()` without a format |

The helpers are also available, with TypeScript declarations, from the `@simtlix/simfinity-core/validators` subpath, which also exports the `FieldValidator`, `FieldValidations` and `ItemValidators` types; the core root exports them too.

`arrayLength()`'s optional `itemValidator` is one of:

- a validator object with `validate(typeName, fieldName, value, session)`, written as a plain object or a function;
- a helper result such as `validators.maxLength('Tag', 20)`, whose `CREATE` rules run on every item of a supplied list on create and update, so `null` items fail helpers that require a value;
- an array of them.

```javascript
tags: {
  type: new GraphQLList(GraphQLString),
  extensions: {
    validations: validators.arrayLength('Tags', 10, validators.maxLength('Tag', 20)),
  },
},
```

An array is read each time a list is validated, and its falsy entries are skipped, so `[flag && rule]` works. Inside an array, any object with `validate()` is called, as before; an entry without `validate()` that is not a helper result makes lists with items fail with a `TypeError` that names the helper. A falsy `itemValidator` adds no item checks. A single class instance with its own `validate()`, such as a Joi or yup schema, is not called, because its signature differs. Unusable values log a `Configuration issue` warning when the helper is created; nothing throws at startup.

`dateFormat()` is not a general date-format parser. Values must be dates JavaScript can parse. A string that starts with an ISO date (`YYYY-MM-DD`, alone or followed by a time), or a slashed `MM/DD/YYYY` string, must be a real calendar date, so `2024-02-31`, `2023-02-29` and `02/31/2024` fail with `<name> must be a valid date`. `format: 'YYYY-MM-DD'` also requires exactly that shape; other shapes fail with `<name> must be in format YYYY-MM-DD`, as before. Any other `format` is not checked: values only need to parse and pass the calendar checks above, and a `Configuration issue` warning naming the format is logged when the helper is created. JavaScript reads slashed dates month first, so `DD/MM/YYYY` values are not supported: on `Date` and `DateTime` fields they are stored month first or fail. Date objects and timestamps skip the string checks, and `futureDate()` applies the same date checks. Values in other layouts, such as `2024-2-31`, `Feb 31 2024` or a slashed date followed by a time, can still roll over into the next month.

`pattern()` copies the regular expression when the helper is created and tests each value from its first character, so `g` and `y` flags keep no state between values, and later changes to your `RegExp` do not affect it. The pattern must be a `RegExp` or a string; other values throw `TypeError` when the helper is created. `url()` rejects invalid values without logging them.

## Combine helpers

Merge the arrays for each operation. Spreading two helper objects would overwrite the first helper's arrays:

```javascript
const lengthRule = validators.stringLength('Name', 2, 120);
const formatRule = validators.pattern(
  'Name',
  /^[A-Za-z0-9 :'-]+$/,
  'Name contains unsupported characters',
);

const nameValidations = {
  CREATE: [...lengthRule.CREATE, ...formatRule.CREATE],
  UPDATE: [...lengthRule.UPDATE, ...formatRule.UPDATE],
};
```

Use `nameValidations` as the field's `extensions.validations` value. Validators in each array run in order.

## Write a custom field rule

Custom field validators receive `(typeName, fieldName, value, session)`. Async validators are awaited before persistence. They receive empty strings unchanged, `undefined` for omitted fields, and `null` for explicit null input; these values are distinct. Throw an error to reject the mutation:

```javascript
import { SimfinityError } from '@simtlix/simfinity-core';

const cannotClearName = {
  validate: async (typeName, fieldName, value) => {
    if (value === null) {
      throw new SimfinityError(
        `${fieldName} cannot be cleared`,
        'VALIDATION_ERROR',
        400,
      );
    }
  },
};

const nameRule = validators.stringLength('Name', 2, 120);
const nameValidations = {
  CREATE: nameRule.CREATE,
  UPDATE: [cannotClearName, ...nameRule.UPDATE],
};
```

This distinguishes an omitted update field (`undefined`) from an explicit attempt to clear it (`null`). GraphQL's generated partial-update inputs allow fields to be omitted; use such a rule when a value must remain present.

## Validate multiple fields together

Type-level validators receive `(typeName, args, modelArgs, session)` after field materialization. `args` is the supplied input and `modelArgs` is the data prepared for persistence.

For a `Season` type with `startYear` and `endYear` integer fields:

```javascript
const chronologicalYears = {
  validate: async (typeName, args, modelArgs) => {
    const { startYear, endYear } = modelArgs;
    if (startYear != null && endYear != null && endYear < startYear) {
      throw new SimfinityError(
        'End year must be on or after start year',
        'INVALID_YEAR_RANGE',
        400,
      );
    }
  },
};

const seasonExtensions = {
  validations: {
    CREATE: [chronologicalYears],
  },
};
```

Assign `seasonExtensions` to the `GraphQLObjectType`'s `extensions`. This rule validates creation. On update, `modelArgs` is a partial change, not the complete stored document. To validate an invariant against existing values, read the record using the supplied session and merge the incoming changes before checking it, or enforce it in `onUpdating`.

::: tip Database checks belong to the transaction
If a validator reads another record, pass the supplied session to the Mongoose query or PostgreSQL Model method. When uniqueness is required, keep a database uniqueness constraint as well; a separate existence check alone cannot prevent concurrent writes.
:::

## Validated scalars

For reusable value types, Simfinity also provides scalar helpers:

```javascript
import { scalars } from '@simtlix/simfinity-core';

const ContactType = new GraphQLObjectType({
  name: 'Contact',
  fields: {
    email: { type: scalars.EmailScalar },
    website: { type: scalars.URLScalar },
  },
});
```

Scalar validation runs during GraphQL input coercion and output serialization. Field validators run in Simfinity's mutation pipeline and can use the database session. Choose according to where the rule must apply. The [scalar reference](../reference/scalars) covers the built-in types and factories.

## Errors and server behavior

Built-in field validators throw `SimfinityError` with code `VALIDATION_ERROR` and status `400`. The HTTP server determines how errors are exposed to clients; for example, Yoga can mask unexpected errors. Configure error handling deliberately rather than assuming a thrown JavaScript error will be returned verbatim. See [errors](../reference/errors) for the error classes and server integration.

Next, use [controllers](./controllers) to prepare values or enforce rules that depend on request context.
