# Simfinity.js

A powerful Node.js framework that automatically generates GraphQL schemas from your data models, bringing all the power and flexibility of MongoDB query language to GraphQL interfaces.

## 📑 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Core Concepts](#-core-concepts)
  - [Connecting Models](#connecting-models)
  - [Creating Schemas](#creating-schemas)
  - [Global Configuration](#global-configuration)
- [Basic Usage](#-basic-usage)
  - [Automatic Query Generation](#automatic-query-generation)
  - [Automatic Mutation Generation](#automatic-mutation-generation)
  - [Filtering and Querying](#filtering-and-querying)
  - [Collection Field Filtering](#collection-field-filtering)
- [Relationships](#-relationships)
  - [Defining Relationships](#defining-relationships)
  - [Auto-Generated Resolve Methods](#auto-generated-resolve-methods)
  - [Adding Types Without Endpoints](#adding-types-without-endpoints)
  - [Embedded vs Referenced Relationships](#embedded-vs-referenced-relationships)
  - [Querying Relationships](#querying-relationships)
- [Validations](#-validations)
  - [Field-Level Validations](#field-level-validations)
  - [Type-Level Validations](#type-level-validations)
  - [Custom Validated Scalar Types](#custom-validated-scalar-types)
  - [Custom Error Classes](#custom-error-classes)
- [State Machines](#-state-machines)
- [Controllers & Lifecycle Hooks](#️-controllers--lifecycle-hooks)
  - [Hook Parameters](#hook-parameters)
- [Query Scope](#-query-scope)
  - [Overview](#overview)
  - [Defining Scope](#defining-scope)
  - [Scope for Find Operations](#scope-for-find-operations)
  - [Scope for Aggregate Operations](#scope-for-aggregate-operations)
  - [Scope for Get By ID Operations](#scope-for-get-by-id-operations)
  - [Scope Function Parameters](#scope-function-parameters)
- [Authorization](#-authorization)
  - [Quick Start](#quick-start-1)
  - [Permission Schema](#permission-schema)
  - [Rule Helpers](#rule-helpers)
  - [Policy Expressions (JSON AST)](#policy-expressions-json-ast)
  - [Integration with GraphQL Yoga / Envelop](#integration-with-graphql-yoga--envelop)
  - [Legacy: Integration with graphql-middleware](#legacy-integration-with-graphql-middleware)
- [Middlewares](#-middlewares)
  - [Adding Middlewares](#adding-middlewares)
  - [Middleware Parameters](#middleware-parameters)
  - [Common Use Cases](#common-use-cases)
- [Advanced Features](#-advanced-features)
  - [Field Extensions](#field-extensions)
  - [Custom Mutations](#custom-mutations)
  - [Working with Existing Mongoose Models](#working-with-existing-mongoose-models)
  - [Programmatic Data Access](#programmatic-data-access)
- [MCP Generation](#-mcp-generation)
  - [Generating tool definitions](#generating-tool-definitions)
  - [Standalone MCP server (stdio)](#standalone-mcp-server-stdio)
  - [HTTP MCP endpoint (alongside GraphQL)](#http-mcp-endpoint-alongside-graphql)
  - [Options](#options)
  - [Selecting and naming tools](#selecting-and-naming-tools)
  - [Customizing tools](#customizing-tools)
  - [Limits](#limits)
  - [Tool middleware](#tool-middleware)
  - [Remote execution](#remote-execution)
  - [Tool results and errors](#tool-results-and-errors)
  - [Authentication](#authentication)
- [Aggregation Queries](#-aggregation-queries)
- [Complete Example](#-complete-example)
- [Resources](#-resources)
- [License](#-license)
- [Contributing](#-contributing)

## ✨ Features

- **Automatic Schema Generation**: Define your object model, and Simfinity.js generates all queries and mutations
- **MongoDB Integration**: Seamless translation between GraphQL and MongoDB
- **Powerful Querying**: Any query that can be executed in MongoDB can be executed in GraphQL
- **Aggregation Queries**: Built-in support for GROUP BY queries with aggregation operations (SUM, COUNT, AVG, MIN, MAX)
- **Auto-Generated Resolvers**: Automatically generates resolve methods for relationship fields
- **Automatic Index Creation**: Automatically creates MongoDB indexes for all ObjectId fields, including nested embedded objects and relationship fields
- **Business Logic**: Implement business logic and domain validations declaratively
- **State Machines**: Built-in support for declarative state machine workflows
- **Lifecycle Hooks**: Controller methods for granular control over operations
- **Custom Validation**: Field-level and type-level custom validations
- **Relationship Management**: Support for embedded and referenced relationships
- **Authorization**: Production-grade GraphQL authorization with RBAC/ABAC, function-based rules, declarative policy expressions, and native Envelop/Yoga plugin support

## 📦 Installation

```bash
npm install mongoose graphql @simtlix/simfinity-js
```

**Prerequisites**: Simfinity.js requires `mongoose` and `graphql` as peer dependencies.

## 🚀 Quick Start

### 1. Basic Setup

```javascript
const express = require('express');
const { graphqlHTTP } = require('express-graphql');
const mongoose = require('mongoose');
const simfinity = require('@simtlix/simfinity-js');

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/bookstore', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const app = express();
```

### 2. Define Your GraphQL Type

```javascript
const { GraphQLObjectType, GraphQLString, GraphQLNonNull, GraphQLID } = require('graphql');

const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    author: { type: GraphQLString },
  }),
});
```

### 3. Connect to Simfinity

```javascript
// Connect the type to Simfinity
simfinity.connect(null, BookType, 'book', 'books');

// Create the GraphQL schema
const schema = simfinity.createSchema();
```

### 4. Setup GraphQL Endpoint

```javascript
app.use('/graphql', graphqlHTTP({
  schema,
  graphiql: true,
  formatError: simfinity.buildErrorFormatter((err) => {
    console.log(err);
  })
}));

app.listen(4000, () => {
  console.log('Server is running on port 4000');
});
```

### 5. Try It Out

Open [http://localhost:4000/graphql](http://localhost:4000/graphql) and try these queries:

**Create a book:**
```graphql
mutation {
  addBook(input: {
    title: "The Hitchhiker's Guide to the Galaxy"
    author: "Douglas Adams"
  }) {
    id
    title
    author
  }
}
```

**List all books:**
```graphql
query {
  books {
    id
    title
    author
  }
}
```

> For a full working application, see the [Series Sample Project](https://github.com/simtlix/series-sample) -- a complete TV series microservice with types, relationships, state machines, controllers, and authorization.

## 🔧 Core Concepts

### Connecting Models

The `simfinity.connect()` method links your GraphQL types to Simfinity's automatic schema generation:

```javascript
simfinity.connect(
  mongooseModel,           // Optional: Custom Mongoose model (null for auto-generation)
  graphQLType,            // Required: Your GraphQLObjectType
  singularEndpointName,   // Required: Singular name for mutations (e.g., 'book')
  pluralEndpointName,     // Required: Plural name for queries (e.g., 'books')
  controller,             // Optional: Controller with lifecycle hooks
  onModelCreated,         // Optional: Callback when Mongoose model is created
  stateMachine            // Optional: State machine configuration
);
```

### Creating Schemas

Generate your complete GraphQL schema with optional type filtering:

```javascript
const schema = simfinity.createSchema(
  includedQueryTypes,     // Optional: Array of types to include in queries
  includedMutationTypes,  // Optional: Array of types to include in mutations
  includedCustomMutations // Optional: Array of custom mutations to include
);
```

### Global Configuration

```javascript
// Prevent automatic MongoDB collection creation (useful for testing)
simfinity.preventCreatingCollection(true);
```

## 📋 Basic Usage

### Automatic Query Generation

Simfinity automatically generates queries for each connected type:

```javascript
// For a BookType, you get:
// - book(id: ID): Book          - Get single book by ID
// - books(...filters): [Book]   - Get filtered list of books
```

### Automatic Mutation Generation

Simfinity automatically generates mutations for each connected type:

```javascript
// For a BookType, you get:
// - addBook(input: BookInput): Book
// - updateBook(input: BookInputForUpdate): Book  
// - deleteBook(id: ID): Book
```

### Filtering and Querying

Query with powerful filtering options:

```graphql
query {
  books(
    title: { operator: LIKE, value: "Galaxy" }
    author: { operator: EQ, value: "Douglas Adams" }
    pagination: { page: 1, size: 10, count: true }
    sort: { terms: [{ field: "title", order: ASC }] }
  ) {
    id
    title
    author
  }
}
```

#### Available Operators

- `EQ` - Equal
- `NE` - Not equal
- `GT` - Greater than
- `LT` - Less than
- `GTE` - Greater than or equal
- `LTE` - Less than or equal
- `LIKE` - Pattern matching
- `IN` - In array
- `NIN` - Not in array
- `BTW` - Between two values

### Logical Filters (AND / OR)

By default, all field-level filters are combined with implicit AND logic. For complex conditions requiring OR logic or nested combinations, use the `AND` and `OR` query arguments.

#### Simple OR

Return books in either the Sci-Fi or Fantasy category:

```graphql
query {
  books(
    OR: [
      { conditions: [{ field: "category", operator: EQ, value: "Sci-Fi" }] }
      { conditions: [{ field: "category", operator: EQ, value: "Fantasy" }] }
    ]
  ) {
    id
    title
    category
  }
}
```

#### Flat Filters Combined with OR

Flat field filters are always ANDed at the top level, making them ideal for scope/security conditions that cannot be bypassed by user OR logic:

```graphql
query {
  books(
    rating: { operator: GTE, value: 7.0 }
    OR: [
      { conditions: [{ field: "category", operator: EQ, value: "Sci-Fi" }] }
      { conditions: [{ field: "category", operator: EQ, value: "Fantasy" }] }
    ]
  ) {
    id
    title
  }
}
```

This translates to: `rating >= 7.0 AND (category = "Sci-Fi" OR category = "Fantasy")`.

#### Nested AND inside OR

```graphql
query {
  books(
    OR: [
      { AND: [
        { conditions: [{ field: "rating", operator: GTE, value: 9.0 }] }
        { conditions: [{ field: "category", operator: EQ, value: "Sci-Fi" }] }
      ]}
      { AND: [
        { conditions: [{ field: "rating", operator: GTE, value: 8.0 }] }
        { conditions: [{ field: "category", operator: EQ, value: "Fantasy" }] }
      ]}
    ]
  ) {
    id
    title
  }
}
```

This translates to: `(rating >= 9.0 AND category = "Sci-Fi") OR (rating >= 8.0 AND category = "Fantasy")`.

#### Filtering on Relationships within AND/OR

Use the `path` parameter to filter on related entity fields:

```graphql
query {
  books(
    OR: [
      { conditions: [{ field: "author", path: "name", operator: LIKE, value: "Adams" }] }
      { conditions: [{ field: "author", path: "name", operator: LIKE, value: "Pratchett" }] }
    ]
  ) {
    id
    title
    author { name }
  }
}
```

As an equivalent shorthand, you can pass the full dotted path in `field` and omit `path`:

```graphql
query {
  books(
    OR: [
      { conditions: [{ field: "author.name", operator: LIKE, value: "Adams" }] }
      { conditions: [{ field: "author.name", operator: LIKE, value: "Pratchett" }] }
    ]
  ) {
    id
    title
    author { name }
  }
}
```

Both forms produce the same query. Multi-segment paths work too — e.g. `field: "author.country.code"` is equivalent to `field: "author", path: "country.code"`. Supplying both a dotted `field` and a separate `path` is rejected as ambiguous.

#### Mixing Flat Filters with AND/OR

You can freely combine the existing flat filter syntax with AND/OR groups. Flat filters and AND groups are all ANDed together at the top level:

```graphql
query {
  books(
    rating: { operator: GTE, value: 7.0 }
    author: { terms: [{ path: "country", operator: EQ, value: "UK" }] }
    OR: [
      { conditions: [{ field: "category", operator: EQ, value: "Sci-Fi" }] }
      { conditions: [{ field: "category", operator: EQ, value: "Fantasy" }] }
    ]
  ) {
    id
    title
    rating
    category
    author { name country }
  }
}
```

This translates to: `rating >= 7.0 AND author.country = "UK" AND (category = "Sci-Fi" OR category = "Fantasy")`. The flat field filters (`rating`, `author`) use the existing syntax while the OR group uses the new `QLFilterGroup` syntax.

You can also combine flat filters with explicit AND groups for more complex logic:

```graphql
query {
  books(
    rating: { operator: GTE, value: 5.0 }
    AND: [
      {
        OR: [
          { conditions: [{ field: "category", operator: EQ, value: "Sci-Fi" }] }
          { conditions: [{ field: "category", operator: EQ, value: "Fantasy" }] }
        ]
      }
      {
        OR: [
          { conditions: [{ field: "author", path: "country", operator: EQ, value: "UK" }] }
          { conditions: [{ field: "author", path: "country", operator: EQ, value: "US" }] }
        ]
      }
    ]
  ) {
    id
    title
  }
}
```

This translates to: `rating >= 5.0 AND (category = "Sci-Fi" OR category = "Fantasy") AND (author.country = "UK" OR author.country = "US")`.

#### Collection Filtering with AND/OR

AND/OR filters are also available on collection fields (one-to-many relationships). The auto-generated resolvers for collection fields support the same `AND` and `OR` arguments:

```graphql
query {
  series {
    seasons(
      OR: [
        { conditions: [{ field: "year", operator: EQ, value: 2020 }] }
        { conditions: [{ field: "year", operator: EQ, value: 2021 }] }
      ]
    ) {
      number
      year
    }
  }
}
```

You can mix flat collection filters with AND/OR:

```graphql
query {
  series {
    seasons(
      number: { operator: GT, value: 1 }
      OR: [
        { conditions: [{ field: "year", operator: EQ, value: 2020 }] }
        {
          AND: [
            { conditions: [{ field: "year", operator: GTE, value: 2022 }] }
            { conditions: [
                # Equivalent to: { field: "episodes", path: "name", ... }
                { field: "episodes.name", operator: LIKE, value: "Final" }
            ] }
          ]
        }
      ]
    ) {
      number
      year
      episodes { name }
    }
  }
}
```

This translates to: `number > 1 AND (year = 2020 OR (year >= 2022 AND episodes.name LIKE "Final"))`.

#### Filter Types Reference

| Type | Fields | Description |
|------|--------|-------------|
| `QLFilterGroup` | `AND: [QLFilterGroup]`, `OR: [QLFilterGroup]`, `conditions: [QLFilterCondition]` | Recursive logical group |
| `QLFilterCondition` | `field: String!`, `operator: QLOperator`, `value: QLValue`, `path: String` | Individual filter condition |

- `field` identifies the entity field by name (e.g., `"title"`, `"author"`). For object/relationship fields you can also pass the full dotted path here as a shorthand (e.g., `"author.name"`, `"author.country.name"`)
- `path` is required for object/relationship fields when `field` is just the top-level name (e.g., `"name"`, `"country.name"`). Omit `path` if you used the dotted-`field` shorthand. Supplying both is an error.
- Multiple `conditions` in the same group are combined with AND
- Maximum nesting depth: 5 levels

### Collection Field Filtering

Simfinity.js now supports filtering collection fields (one-to-many relationships) using the same powerful query format. This allows you to filter related objects directly within your GraphQL queries.

#### Basic Collection Filtering

Filter collection fields using the same operators and format as main queries:

```graphql
query {
  series {
    seasons(number: { operator: EQ, value: 1 }) {
      number
      id
      year
    }
  }
}
```

#### Advanced Collection Filtering

You can use complex filtering with nested object properties:

```graphql
query {
  series {
    seasons(
      year: { operator: GTE, value: 2020 }
      episodes: {
        terms: [
          {
            path: "name",
            operator: LIKE,
            value: "Pilot"
          }
        ]
      }
    ) {
      number
      year
      episodes {
        name
        date
      }
    }
  }
}
```

#### Collection Filtering with Multiple Conditions

Combine multiple filter conditions for collection fields:

```graphql
query {
  series {
    seasons(
      number: { operator: GT, value: 1 }
      year: { operator: BTW, value: [2015, 2023] }
    ) {
      number
      year
      state
    }
  }
}
```

#### Nested Collection Filtering

Filter deeply nested collections using dot notation:

```graphql
query {
  series {
    seasons(
      episodes: {
        terms: [
          {
            path: "name",
            operator: LIKE,
            value: "Final"
          }
        ]
      }
    ) {
      number
      episodes {
        name
        date
      }
    }
  }
}
```

#### Collection Filtering with Array Operations

Use array operations for collection fields:

```graphql
query {
  series {
    seasons(
      categories: { operator: IN, value: ["Drama", "Crime"] }
    ) {
      number
      categories
    }
  }
}
```

**Note**: Collection field filtering uses the exact same format as main query filtering, ensuring consistency across your GraphQL API. All available operators (`EQ`, `NE`, `GT`, `LT`, `GTE`, `LTE`, `LIKE`, `IN`, `NIN`, `BTW`) work with collection fields.

## 🔗 Relationships

### Defining Relationships

Use the `extensions.relation` field to define relationships between types:

```javascript
const AuthorType = new GraphQLObjectType({
  name: 'Author',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    books: {
      type: new GraphQLList(BookType),
      extensions: {
        relation: {
          connectionField: 'author',
          displayField: 'title'
        },
      },
      // resolve method automatically generated! 🎉
    },
  }),
});

const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    author: {
      type: AuthorType,
      extensions: {
        relation: {
          displayField: 'name'
        },
      },
      // resolve method automatically generated! 🎉
    },
  }),
});
```

### Relationship Configuration

- `connectionField`: **(Required for collections)** The field storing the related object's ID - only needed for one-to-many relationships (GraphQLList). For single object relationships, the field name is automatically inferred from the GraphQL field name.
- `displayField`: **(Optional)** Field to use for display in UI components
- `embedded`: **(Optional)** Whether the relation is embedded (default: false)

### Auto-Generated Resolve Methods

🎉 **NEW**: Simfinity.js automatically generates resolve methods for relationship fields when types are connected, eliminating the need for manual resolver boilerplate.

#### Before (Manual Resolvers)

```javascript
const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    author: {
      type: AuthorType,
      extensions: {
        relation: {
          displayField: 'name'
        },
      },
      // You had to manually write this
      resolve(parent) {
        return simfinity.getModel(AuthorType).findById(parent.author);
      }
    },
    comments: {
      type: new GraphQLList(CommentType),
      extensions: {
        relation: {
          connectionField: 'bookId',
          displayField: 'text'
        },
      },
      // You had to manually write this too
      resolve(parent) {
        return simfinity.getModel(CommentType).find({ bookId: parent.id });
      }
    }
  }),
});
```

#### After (Auto-Generated Resolvers)

```javascript
const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    author: {
      type: AuthorType,
      extensions: {
        relation: {
          displayField: 'name'
        },
      },
      // resolve method automatically generated! 🎉
    },
    comments: {
      type: new GraphQLList(CommentType),
      extensions: {
        relation: {
          connectionField: 'bookId',
          displayField: 'text'
        },
      },
      // resolve method automatically generated! 🎉
    }
  }),
});
```

#### How It Works

- **Single Object Relationships**: Automatically generates `findById()` resolvers using the field name or `connectionField`
- **Collection Relationships**: Automatically generates `find()` resolvers using the `connectionField` to query related objects
- **Lazy Loading**: Models are looked up at runtime, so types can be connected in any order
- **Backwards Compatible**: Existing manual resolve methods are preserved and not overwritten
- **Type Safety**: Clear error messages if related types aren't properly connected

#### Connect Your Types

```javascript
// Connect all your types to Simfinity
simfinity.connect(null, AuthorType, 'author', 'authors');
simfinity.connect(null, BookType, 'book', 'books');
simfinity.connect(null, CommentType, 'comment', 'comments');

// Or use addNoEndpointType for types that don't need direct queries/mutations
simfinity.addNoEndpointType(AuthorType);
```

That's it! All relationship resolvers are automatically generated when you connect your types.

### Adding Types Without Endpoints

Use `addNoEndpointType()` for types that should be included in the GraphQL schema but don't need their own CRUD operations:

```javascript
simfinity.addNoEndpointType(TypeName);
```

**When to use `addNoEndpointType()` vs `connect()`:**

| Method | Use Case | Creates Endpoints | Use Example |
|--------|----------|-------------------|-------------|
| `connect()` | Types that need CRUD operations | ✅ Yes | User, Product, Order |
| `addNoEndpointType()` | Types only used in relationships | ❌ No | Address, Settings, Director |

#### Perfect Example: TV Series with Embedded Director

From the [series-sample](https://github.com/simtlix/series-sample) project:

```javascript
// Director type - Used only as embedded data, no direct API access needed
const directorType = new GraphQLObjectType({
  name: 'director',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    country: { type: GraphQLString }
  })
});

// Add to schema WITHOUT creating endpoints
simfinity.addNoEndpointType(directorType);

// Serie type - Has its own endpoints and embeds director data
const serieType = new GraphQLObjectType({
  name: 'serie',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    categories: { type: new GraphQLList(GraphQLString) },
    director: {
      type: new GraphQLNonNull(directorType),
      extensions: {
        relation: {
          embedded: true,  // Director data stored within serie document
          displayField: 'name'
        }
      }
    }
  })
});

// Create full CRUD endpoints for series
simfinity.connect(null, serieType, 'serie', 'series');
```

**Result:**
- ✅ `addserie`, `updateserie`, `deleteserie` mutations available
- ✅ `serie`, `series` queries available  
- ❌ No `adddirector`, `director`, `directors` endpoints (director is embedded)

**Usage:**
```graphql
mutation {
  addserie(input: {
    name: "Breaking Bad"
    categories: ["crime", "drama", "thriller"]
    director: { 
      name: "Vince Gilligan" 
      country: "United States" 
    }
  }) {
    id
    name
    director {
      name
      country
    }
  }
}
```

#### When to Use Each Approach

**Use `addNoEndpointType()` for:**
- Simple data objects with few fields
- Data that doesn't need CRUD operations  
- Objects that belong to a single parent (1:1 relationships)
- Configuration or settings objects
- **Examples**: Address, Director info, Product specifications

**Use `connect()` for:**
- Complex entities that need their own endpoints
- Data that needs CRUD operations
- Objects shared between multiple parents (many:many relationships)  
- Objects with business logic (controllers, state machines)
- **Examples**: User, Product, Order, Season, Episode

### Embedded vs Referenced Relationships

**Referenced Relationships** (default):
```javascript
// Stores author ID in the book document
author: {
  type: AuthorType,
  extensions: {
    relation: {
      // connectionField not needed for single object relationships
      embedded: false  // This is the default
    }
  }
}
```

**Embedded Relationships**:
```javascript
// Stores the full publisher object in the book document
publisher: {
  type: PublisherType,
  extensions: {
    relation: {
      embedded: true
    }
  }
}
```

### Querying Relationships

Query nested relationships with dot notation:

```graphql
query {
  books(author: {
    terms: [
      {
        path: "country.name",
        operator: EQ,
        value: "England"
      }
    ]
  }) {
    id
    title
    author {
      name
      country {
        name
      }
    }
  }
}
```

### Creating Objects with Relationships

**Link to existing objects:**
```graphql
mutation {
  addBook(input: {
    title: "New Book"
    author: {
      id: "existing_author_id"
    }
  }) {
    id
    title
    author {
      name
    }
  }
}
```

**Create embedded objects:**
```graphql
mutation {
  addBook(input: {
    title: "New Book"
    publisher: {
      name: "Penguin Books"
      location: "London"
    }
  }) {
    id
    title
    publisher {
      name
      location
    }
  }
}
```

### Collection Fields

Work with arrays of related objects:

```graphql
mutation {
  updateBook(input: {
    id: "book_id"
    reviews: {
      added: [
        { rating: 5, comment: "Amazing!" }
        { rating: 4, comment: "Good read" }
      ]
      updated: [
        { id: "review_id", rating: 3 }
      ]
      deleted: ["review_id_to_delete"]
    }
  }) {
    id
    title
    reviews {
      rating
      comment
    }
  }
}
```

## ✅ Validations

### Declarative Validation Helpers

Simfinity.js provides built-in validation helpers to simplify common validation patterns, eliminating verbose boilerplate code.

#### Using Validators

```javascript
const { validators } = require('@simtlix/simfinity-js');

const PersonType = new GraphQLObjectType({
  name: 'Person',
  fields: () => ({
    id: { type: GraphQLID },
    name: {
      type: GraphQLString,
      extensions: {
        validations: validators.stringLength('Name', 2, 100)
      }
    },
    email: {
      type: GraphQLString,
      extensions: {
        validations: validators.email()
      }
    },
    website: {
      type: GraphQLString,
      extensions: {
        validations: validators.url()
      }
    },
    age: {
      type: GraphQLInt,
      extensions: {
        validations: validators.numberRange('Age', 0, 120)
      }
    },
    price: {
      type: GraphQLFloat,
      extensions: {
        validations: validators.positive('Price')
      }
    }
  })
});
```

#### Available Validators

**String Validators:**
- `validators.stringLength(name, min, max)` - Validates string length with min/max bounds (required for CREATE)
- `validators.maxLength(name, max)` - Validates maximum string length
- `validators.pattern(name, regex, message)` - Validates against a regex pattern
- `validators.email()` - Validates email format
- `validators.url()` - Validates URL format

**Number Validators:**
- `validators.numberRange(name, min, max)` - Validates number range
- `validators.positive(name)` - Ensures number is positive

**Array Validators:**
- `validators.arrayLength(name, maxItems, itemValidator)` - Validates array length and optionally each item

**Date Validators:**
- `validators.dateFormat(name, format)` - Validates date format
- `validators.futureDate(name)` - Ensures date is in the future

#### Validator Features

- **Automatic Operation Handling**: Validators work for both `CREATE` (save) and `UPDATE` operations
- **Smart Validation**: For CREATE operations, values are required. For UPDATE operations, undefined/null values are allowed (field might not be updated)
- **Consistent Error Messages**: All validators throw `SimfinityError` with appropriate messages

#### Example: Multiple Validators

```javascript
const ProductType = new GraphQLObjectType({
  name: 'Product',
  fields: () => ({
    id: { type: GraphQLID },
    name: {
      type: GraphQLString,
      extensions: {
        validations: validators.stringLength('Product Name', 3, 200)
      }
    },
    sku: {
      type: GraphQLString,
      extensions: {
        validations: validators.pattern('SKU', /^[A-Z0-9-]+$/, 'SKU must be uppercase alphanumeric with hyphens')
      }
    },
    price: {
      type: GraphQLFloat,
      extensions: {
        validations: validators.positive('Price')
      }
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      extensions: {
        validations: validators.arrayLength('Tags', 10)
      }
    }
  })
});
```

### Field-Level Validations (Manual)

For custom validation logic, you can still write manual validators:

```javascript
const { SimfinityError } = require('@simtlix/simfinity-js');

const validateAge = {
  validate: async (typeName, fieldName, value, session) => {
    if (value < 0 || value > 120) {
      throw new SimfinityError(`Invalid age: ${value}`, 'VALIDATION_ERROR', 400);
    }
  }
};

const PersonType = new GraphQLObjectType({
  name: 'Person',
  fields: () => ({
    id: { type: GraphQLID },
    name: { 
      type: GraphQLString,
      extensions: {
        validations: {
          save: [{
            validate: async (typeName, fieldName, value, session) => {
              if (!value || value.length < 2) {
                throw new SimfinityError('Name must be at least 2 characters', 'VALIDATION_ERROR', 400);
              }
            }
          }],
          update: [{
            validate: async (typeName, fieldName, value, session) => {
              if (value && value.length < 2) {
                throw new SimfinityError('Name must be at least 2 characters', 'VALIDATION_ERROR', 400);
              }
            }
          }]
        }
      }
    },
    age: {
      type: GraphQLInt,
      extensions: {
        validations: {
          save: [validateAge],
          update: [validateAge]
        }
      }
    }
  })
});
```

### Type-Level Validations

Validate objects as a whole:

```javascript
const orderValidator = {
  validate: async (typeName, args, modelArgs, session) => {
    // Cross-field validation
    if (modelArgs.deliveryDate < modelArgs.orderDate) {
      throw new SimfinityError('Delivery date cannot be before order date', 'VALIDATION_ERROR', 400);
    }
    
    // Business rule validation
    if (modelArgs.items.length === 0) {
      throw new SimfinityError('Order must contain at least one item', 'BUSINESS_ERROR', 400);
    }
  }
};

const OrderType = new GraphQLObjectType({
  name: 'Order',
  extensions: {
    validations: {
      save: [orderValidator],
      update: [orderValidator]
    }
  },
  fields: () => ({
    // ... fields
  })
});
```

### Custom Validated Scalar Types

Create custom scalar types with built-in validation. The generated type names follow the pattern `{name}_{baseScalarTypeName}`.

#### Pre-built Scalars

Simfinity.js provides ready-to-use validated scalars for common patterns:

```javascript
const { scalars } = require('@simtlix/simfinity-js');

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    email: { type: scalars.EmailScalar },      // Type name: Email_String
    website: { type: scalars.URLScalar },       // Type name: URL_String
    age: { type: scalars.PositiveIntScalar },  // Type name: PositiveInt_Int
    price: { type: scalars.PositiveFloatScalar } // Type name: PositiveFloat_Float
  }),
});
```

**Available Pre-built Scalars:**
- `scalars.EmailScalar` - Validates email format (`Email_String`)
- `scalars.URLScalar` - Validates URL format (`URL_String`)
- `scalars.PositiveIntScalar` - Validates positive integers (`PositiveInt_Int`)
- `scalars.PositiveFloatScalar` - Validates positive floats (`PositiveFloat_Float`)

#### Factory Functions for Custom Scalars

Create custom validated scalars with parameters:

```javascript
const { scalars } = require('@simtlix/simfinity-js');

// Create a bounded string scalar (name length between 2-100 characters)
const NameScalar = scalars.createBoundedStringScalar('Name', 2, 100);

// Create a bounded integer scalar (age between 0-120)
const AgeScalar = scalars.createBoundedIntScalar('Age', 0, 120);

// Create a bounded float scalar (rating between 0-10)
const RatingScalar = scalars.createBoundedFloatScalar('Rating', 0, 10);

// Create a pattern-based string scalar (phone number format)
const PhoneScalar = scalars.createPatternStringScalar(
  'Phone',
  /^\+?[\d\s\-()]+$/,
  'Invalid phone number format'
);

// Use in your types
const PersonType = new GraphQLObjectType({
  name: 'Person',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: NameScalar },        // Type name: Name_String
    age: { type: AgeScalar },          // Type name: Age_Int
    rating: { type: RatingScalar },    // Type name: Rating_Float
    phone: { type: PhoneScalar }       // Type name: Phone_String
  }),
});
```

**Available Factory Functions:**
- `scalars.createBoundedStringScalar(name, min, max)` - String with length bounds
- `scalars.createBoundedIntScalar(name, min, max)` - Integer with range validation
- `scalars.createBoundedFloatScalar(name, min, max)` - Float with range validation
- `scalars.createPatternStringScalar(name, pattern, message)` - String with regex pattern validation

#### Creating Custom Scalars Manually

You can also create custom scalars using `createValidatedScalar` directly:

```javascript
const { GraphQLString, GraphQLInt } = require('graphql');
const { createValidatedScalar } = require('@simtlix/simfinity-js');

// Email scalar with validation (generates type name: Email_String)
const EmailScalar = createValidatedScalar(
  'Email',
  'A valid email address',
  GraphQLString,
  (value) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      throw new Error('Invalid email format');
    }
  }
);

// Positive integer scalar (generates type name: PositiveInt_Int)
const PositiveIntScalar = createValidatedScalar(
  'PositiveInt',
  'A positive integer',
  GraphQLInt,
  (value) => {
    if (value <= 0) {
      throw new Error('Value must be positive');
    }
  }
);

// Use in your types
const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    email: { type: EmailScalar }, // Type name: Email_String
    age: { type: PositiveIntScalar }, // Type name: PositiveInt_Int
  }),
});
```

### Custom Error Classes

Create domain-specific error classes:

```javascript
const { SimfinityError } = require('@simtlix/simfinity-js');

// Business logic error
class BusinessError extends SimfinityError {
  constructor(message) {
    super(message, 'BUSINESS_ERROR', 400);
  }
}

// Authorization error
class AuthorizationError extends SimfinityError {
  constructor(message) {
    super(message, 'UNAUTHORIZED', 401);
  }
}

// Not found error
class NotFoundError extends SimfinityError {
  constructor(message) {
    super(message, 'NOT_FOUND', 404);
  }
}
```

## 🔄 State Machines

Implement declarative state machine workflows:

### 1. Define States

```javascript
const { GraphQLEnumType } = require('graphql');

const OrderState = new GraphQLEnumType({
  name: 'OrderState',
  values: {
    PENDING: { value: 'PENDING' },
    PROCESSING: { value: 'PROCESSING' },
    SHIPPED: { value: 'SHIPPED' },
    DELIVERED: { value: 'DELIVERED' },
    CANCELLED: { value: 'CANCELLED' }
  }
});
```

### 2. Define Type with State Field

```javascript
const OrderType = new GraphQLObjectType({
  name: 'Order',
  fields: () => ({
    id: { type: GraphQLID },
    customer: { type: GraphQLString },
    state: { type: OrderState }
  })
});
```

### 3. Configure State Machine

```javascript
const stateMachine = {
  initialState: { name: 'PENDING', value: 'PENDING' },
  actions: {
    process: {
      from: { name: 'PENDING', value: 'PENDING' },
      to: { name: 'PROCESSING', value: 'PROCESSING' },
      description: 'Process the order',
      action: async (args, session) => {
        // Business logic for processing
        console.log(`Processing order ${args.id}`);
        // You can perform additional operations here
      }
    },
    ship: {
      from: { name: 'PROCESSING', value: 'PROCESSING' },
      to: { name: 'SHIPPED', value: 'SHIPPED' },
      description: 'Ship the order',
      action: async (args, session) => {
        // Business logic for shipping
        console.log(`Shipping order ${args.id}`);
      }
    },
    deliver: {
      from: { name: 'SHIPPED', value: 'SHIPPED' },
      to: { name: 'DELIVERED', value: 'DELIVERED' },
      description: 'Mark as delivered'
    },
    cancel: {
      from: { name: 'PENDING', value: 'PENDING' },
      to: { name: 'CANCELLED', value: 'CANCELLED' },
      description: 'Cancel the order'
    }
  }
};
```

### 4. Connect with State Machine

```javascript
simfinity.connect(null, OrderType, 'order', 'orders', null, null, stateMachine);
```

### 5. Use State Machine Mutations

The state machine automatically generates mutations for each action:

```graphql
mutation {
  process_order(input: {
    id: "order_id"
  }) {
    id
    state
    customer
  }
}
```

**Important Notes**:
- The `state` field is automatically read-only and managed by the state machine
- State transitions are only allowed based on the defined actions
- Business logic in the `action` function is executed during transitions
- Invalid transitions throw errors automatically

## 🎛️ Controllers & Lifecycle Hooks

Controllers provide fine-grained control over operations with lifecycle hooks:

```javascript
const bookController = {
  onSaving: async (doc, args, session, context) => {
    // Before saving - doc is a Mongoose document
    if (!doc.title || doc.title.trim().length === 0) {
      throw new Error('Book title cannot be empty');
    }
    // Access user from context to set owner
    if (context && context.user) {
      doc.owner = context.user.id;
    }
    console.log(`Creating book: ${doc.title}`);
  },

  onSaved: async (doc, args, session, context) => {
    // After saving - doc is a plain object
    console.log(`Book saved: ${doc._id}`);
    // Can access context.user for post-save operations like notifications
  },

  onUpdating: async (id, doc, session, context) => {
    // Before updating - doc contains only changed fields
    // Validate user has permission to update
    if (context && context.user && context.user.role !== 'admin') {
      throw new simfinity.SimfinityError('Only admins can update books', 'FORBIDDEN', 403);
    }
    console.log(`Updating book ${id}`);
  },

  onUpdated: async (doc, session, context) => {
    // After updating - doc is the updated document
    console.log(`Book updated: ${doc.title}`);
  },

  onDelete: async (doc, session, context) => {
    // Before deleting - doc is the document to be deleted
    // Validate user has permission to delete
    if (context && context.user && context.user.role !== 'admin') {
      throw new simfinity.SimfinityError('Only admins can delete books', 'FORBIDDEN', 403);
    }
    console.log(`Deleting book: ${doc.title}`);
  }
};

// Connect with controller
simfinity.connect(null, BookType, 'book', 'books', bookController);
```

### Hook Parameters

**`onSaving(doc, args, session, context)`**:
- `doc`: Mongoose Document instance (not yet saved)
- `args`: Raw GraphQL mutation input
- `session`: Mongoose session for transaction
- `context`: GraphQL context object (includes request info, user data, etc.)

**`onSaved(doc, args, session, context)`**:
- `doc`: Plain object of saved document
- `args`: Raw GraphQL mutation input
- `session`: Mongoose session for transaction
- `context`: GraphQL context object (includes request info, user data, etc.)

**`onUpdating(id, doc, session, context)`**:
- `id`: Document ID being updated
- `doc`: Plain object with only changed fields
- `session`: Mongoose session for transaction
- `context`: GraphQL context object (includes request info, user data, etc.)

**`onUpdated(doc, session, context)`**:
- `doc`: Full updated Mongoose document
- `session`: Mongoose session for transaction
- `context`: GraphQL context object (includes request info, user data, etc.)

**`onDelete(doc, session, context)`**:
- `doc`: Plain object of document to be deleted
- `session`: Mongoose session for transaction
- `context`: GraphQL context object (includes request info, user data, etc.)

### Using Context in Controllers

The `context` parameter provides access to the GraphQL request context, which typically includes user information, request metadata, and other application-specific data. This is particularly useful for:

- **Setting ownership**: Automatically assign the current user as the owner of new entities
- **Authorization checks**: Validate user permissions before allowing operations
- **Audit logging**: Track who performed which operations
- **User-specific business logic**: Apply different logic based on user roles or attributes

**Example: Setting Owner on Creation**

```javascript
const documentController = {
  onSaving: async (doc, args, session, context) => {
    // Automatically set the owner to the current user
    if (context && context.user) {
      doc.owner = context.user.id;
    }
  }
};
```

**Example: Role-Based Authorization**

```javascript
const adminOnlyController = {
  onUpdating: async (id, doc, session, context) => {
    if (!context || !context.user || context.user.role !== 'admin') {
      throw new simfinity.SimfinityError('Admin access required', 'FORBIDDEN', 403);
    }
  },
  
  onDelete: async (doc, session, context) => {
    if (!context || !context.user || context.user.role !== 'admin') {
      throw new simfinity.SimfinityError('Admin access required', 'FORBIDDEN', 403);
    }
  }
};
```

**Note**: When using `saveObject` programmatically (outside of GraphQL), the `context` parameter is optional and may be `undefined`. Always check for context existence before accessing its properties.

## 🔒 Query Scope

### Overview

Query scope allows you to automatically modify query arguments based on context (e.g., user permissions). This enables automatic filtering so that users can only see documents they're authorized to access. Scope functions are executed after middleware and before query execution, allowing you to append filter conditions to queries and aggregations.

### Defining Scope

Define scope in the type extensions, similar to how validations are defined:

```javascript
const EpisodeType = new GraphQLObjectType({
  name: 'episode',
  extensions: {
    validations: {
      create: [validateEpisodeFields],
      update: [validateEpisodeBusinessRules]
    },
    scope: {
      find: async ({ type, args, operation, context }) => {
        // Modify args in place to add filter conditions
        args.owner = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      },
      aggregate: async ({ type, args, operation, context }) => {
        // Apply same scope to aggregate queries
        args.owner = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      },
      get_by_id: async ({ type, args, operation, context }) => {
        // For get_by_id, scope is automatically merged with id filter
        args.owner = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      }
    }
  },
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    owner: {
      type: new GraphQLNonNull(simfinity.getType('user')),
      extensions: {
        relation: {
          connectionField: 'owner',
          displayField: 'name'
        }
      }
    }
  })
});
```

### Scope for Find Operations

Scope functions for `find` operations modify the query arguments that are passed to `buildQuery`. The modified arguments are automatically used to filter results:

```javascript
const DocumentType = new GraphQLObjectType({
  name: 'Document',
  extensions: {
    scope: {
      find: async ({ type, args, operation, context }) => {
        // Only show documents owned by the current user
        args.owner = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      }
    }
  },
  fields: () => ({
    id: { type: GraphQLID },
    title: { type: GraphQLString },
    owner: {
      type: new GraphQLNonNull(simfinity.getType('user')),
      extensions: {
        relation: {
          connectionField: 'owner',
          displayField: 'name'
        }
      }
    }
  })
});
```

**Result**: All `documents` queries will automatically filter to only return documents where `owner.id` equals `context.user.id`.

### Scope for Aggregate Operations

Scope functions for `aggregate` operations work the same way, ensuring aggregation queries also respect the scope:

```javascript
const OrderType = new GraphQLObjectType({
  name: 'Order',
  extensions: {
    scope: {
      aggregate: async ({ type, args, operation, context }) => {
        // Only aggregate orders for the current user's organization
        args.organization = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.organizationId
            }
          ]
        };
      }
    }
  },
  fields: () => ({
    // ... fields
  })
});
```

**Result**: All `orders_aggregate` queries will automatically filter to only aggregate orders from the user's organization.

### Scope for Get By ID Operations

For `get_by_id` operations, scope functions modify a temporary query arguments object that includes the id filter. The system automatically combines the id filter with scope filters:

```javascript
const PrivateDocumentType = new GraphQLObjectType({
  name: 'PrivateDocument',
  extensions: {
    scope: {
      get_by_id: async ({ type, args, operation, context }) => {
        // Ensure user can only access their own documents
        args.owner = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      }
    }
  },
  fields: () => ({
    // ... fields
  })
});
```

**Result**: When querying `privatedocument(id: "some_id")`, the system will:
1. Create a query that includes both the id filter and the owner scope filter
2. Only return the document if it matches both conditions
3. Return `null` if the document exists but doesn't match the scope

### Scope Function Parameters

Scope functions receive the same parameters as middleware for consistency:

```javascript
{
  type,        // Type information (model, gqltype, controller, etc.)
  args,        // GraphQL arguments passed to the operation (modify this object)
  operation,   // Operation type: 'find', 'aggregate', or 'get_by_id'
  context      // GraphQL context object (includes request info, user data, etc.)
}
```

### Filter Structure

When modifying `args` in scope functions, use the appropriate filter structure:

**For scalar fields:**
```javascript
args.fieldName = {
  operator: 'EQ',
  value: 'someValue'
};
```

**For object/relation fields (QLTypeFilterExpression):**
```javascript
args.relationField = {
  terms: [
    {
      path: 'fieldName',
      operator: 'EQ',
      value: 'someValue'
    }
  ]
};
```

### Complete Example

Here's a complete example showing scope for all query operations:

```javascript
const EpisodeType = new GraphQLObjectType({
  name: 'episode',
  extensions: {
    validations: {
      save: [validateEpisodeFields],
      update: [validateEpisodeBusinessRules]
    },
    scope: {
      find: async ({ type, args, operation, context }) => {
        // Only show episodes from seasons the user has access to
        args.season = {
          terms: [
            {
              path: 'owner.id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      },
      aggregate: async ({ type, args, operation, context }) => {
        // Apply same scope to aggregations
        args.season = {
          terms: [
            {
              path: 'owner.id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      },
      get_by_id: async ({ type, args, operation, context }) => {
        // Ensure user can only access their own episodes
        args.owner = {
          terms: [
            {
              path: 'id',
              operator: 'EQ',
              value: context.user.id
            }
          ]
        };
      }
    }
  },
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: GraphQLInt },
    name: { type: GraphQLString },
    season: {
      type: new GraphQLNonNull(simfinity.getType('season')),
      extensions: {
        relation: {
          connectionField: 'season',
          displayField: 'number'
        }
      }
    },
    owner: {
      type: new GraphQLNonNull(simfinity.getType('user')),
      extensions: {
        relation: {
          connectionField: 'owner',
          displayField: 'name'
        }
      }
    }
  })
});
```

### Important Notes

- **Execution Order**: Scope functions are executed **after** middleware, so middleware can set up context (e.g., user info) that scope functions can use
- **Modify Args In Place**: Scope functions should modify the `args` object directly
- **Filter Structure**: Use the correct filter structure (`QLFilter` for scalars, `QLTypeFilterExpression` for relations)
- **All Query Operations**: Scope applies to `find`, `aggregate`, and `get_by_id` operations
- **Automatic Merging**: For `get_by_id`, the id filter is automatically combined with scope filters
- **Context Access**: Use `context.user`, `context.ip`, or other context properties to determine scope

### Use Cases

- **Multi-tenancy**: Filter documents by organization or tenant
- **User-specific data**: Only show documents owned by the current user
- **Role-based access**: Filter based on user roles or permissions
- **Department/Team scoping**: Show only data relevant to user's department
- **Geographic scoping**: Filter by user's location or region

## 🔐 Authorization

Simfinity.js provides production-grade centralized GraphQL authorization supporting RBAC/ABAC, function-based rules, declarative policy expressions (JSON AST), wildcard permissions, and configurable default policies. It ships as a native Envelop plugin for GraphQL Yoga (recommended) and also supports the legacy graphql-middleware approach.

### Quick Start

```javascript
const { auth } = require('@simtlix/simfinity-js');
const { createYoga } = require('graphql-yoga');

const { createAuthPlugin, requireAuth, requireRole } = auth;

// Define your permission schema
// Query/Mutation names match the ones generated by simfinity.connect()
const permissions = {
  Query: {
    series: requireAuth(),
    seasons: requireAuth(),
  },
  Mutation: {
    deleteserie: requireRole('admin'),
    deletestar: requireRole('admin'),
  },
  serie: {
    '*': requireAuth(),           // Wildcard: all fields require auth
  },
};

// Create the Envelop auth plugin and pass it to your server
const authPlugin = createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' });
const yoga = createYoga({ schema, plugins: [authPlugin] });
```

### Permission Schema

The permission schema defines authorization rules per type and field:

```javascript
const permissions = {
  // Operation types (Query, Mutation, Subscription)
  Query: {
    fieldName: ruleOrRules,
  },
  
  // Object types
  TypeName: {
    '*': wildcardRule,      // Applies to all fields unless overridden
    fieldName: specificRule, // Overrides wildcard for this field
  },
};
```

**Resolution Order:**
1. Check exact field rule: `permissions[TypeName][fieldName]`
2. Fallback to wildcard: `permissions[TypeName]['*']`
3. Apply default policy (ALLOW or DENY)

**Rule Types:**
- **Function**: `(parent, args, ctx, info) => boolean | void | Promise<boolean | void>`
- **Array of functions**: All rules must pass (AND logic)
- **Policy expression**: JSON AST object (see below)

**Rule Semantics:**
- `return true` or `return void` → allow
- `return false` → deny
- `throw Error` → deny with error

### Rule Helpers

Simfinity.js provides reusable rule builders:

```javascript
const { auth } = require('@simtlix/simfinity-js');

const {
  resolvePath,       // Utility to resolve dotted paths in objects
  requireAuth,       // Requires ctx.user to exist
  requireRole,       // Requires specific role(s)
  requirePermission, // Requires specific permission(s)
  composeRules,      // Combine rules (AND logic)
  anyRule,           // Combine rules (OR logic)
  isOwner,           // Check resource ownership
  allow,             // Always allow
  deny,              // Always deny
  createRule,        // Create custom rule
} = auth;
```

#### requireAuth(userPath?)

Requires the user to be authenticated. Supports custom user paths in context:

```javascript
const permissions = {
  Query: {
    // Default: checks ctx.user
    me: requireAuth(),
    
    // Custom path: checks ctx.auth.currentUser
    profile: requireAuth('auth.currentUser'),
    
    // Deep path: checks ctx.session.data.user
    settings: requireAuth('session.data.user'),
  },
};
```

#### requireRole(role, options?)

Requires the user to have a specific role. Supports custom paths:

```javascript
const permissions = {
  Query: {
    // Default: checks ctx.user.role
    adminDashboard: requireRole('ADMIN'),
    modTools: requireRole(['ADMIN', 'MODERATOR']), // Any of these roles
    
    // Custom paths: checks ctx.auth.user.profile.role
    superAdmin: requireRole('SUPER_ADMIN', { 
      userPath: 'auth.user', 
      rolePath: 'profile.role',
    }),
  },
};
```

#### requirePermission(permission, options?)

Requires the user to have specific permission(s). Supports custom paths:

```javascript
const permissions = {
  Mutation: {
    // Default: checks ctx.user.permissions
    deletePost: requirePermission('posts:delete'),
    manageUsers: requirePermission(['users:read', 'users:write']), // All required
    
    // Custom paths: checks ctx.session.user.access.grants
    admin: requirePermission('admin:all', {
      userPath: 'session.user',
      permissionsPath: 'access.grants',
    }),
  },
};
```

#### composeRules(...rules)

Combines multiple rules with AND logic (all must pass):

```javascript
const permissions = {
  Mutation: {
    updatePost: composeRules(
      requireAuth(),
      requireRole('EDITOR'),
      async (post, args, ctx) => post.authorId === ctx.user.id,
    ),
  },
};
```

#### anyRule(...rules)

Combines multiple rules with OR logic (any must pass):

```javascript
const permissions = {
  Post: {
    content: anyRule(
      requireRole('ADMIN'),
      async (post, args, ctx) => post.authorId === ctx.user.id,
    ),
  },
};
```

#### isOwner(ownerField, userIdField)

Checks if the authenticated user owns the resource:

```javascript
const permissions = {
  Post: {
    '*': composeRules(
      requireAuth(),
      isOwner('authorId', 'id'), // Compares post.authorId with ctx.user.id
    ),
  },
};
```

### Policy Expressions (JSON AST)

For declarative rules, use JSON AST policy expressions:

```javascript
const permissions = {
  Post: {
    content: {
      anyOf: [
        { eq: [{ ref: 'parent.published' }, true] },
        { eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }] },
      ],
    },
  },
};
```

**Supported Operators:**

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equals | `{ eq: [{ ref: 'parent.status' }, 'active'] }` |
| `in` | Value in array | `{ in: [{ ref: 'ctx.user.role' }, ['ADMIN', 'MOD']] }` |
| `allOf` | All must be true (AND) | `{ allOf: [expr1, expr2] }` |
| `anyOf` | Any must be true (OR) | `{ anyOf: [expr1, expr2] }` |
| `not` | Negation | `{ not: { eq: [{ ref: 'parent.deleted' }, true] } }` |

**References:**

Use `{ ref: 'path' }` to reference values:
- `parent.*` - Parent resolver result (the object being resolved)
- `args.*` - GraphQL arguments
- `ctx.*` - GraphQL context

**Security:**
- Only `parent`, `args`, and `ctx` roots are allowed
- Unknown operators fail closed (deny)
- No `eval()` or `Function()` - pure object traversal

### Integration with GraphQL Yoga / Envelop

The recommended way to use the auth system is via the Envelop plugin, which works natively with GraphQL Yoga and any Envelop-based server. The plugin wraps resolvers in-place without rebuilding the schema, avoiding compatibility issues.

```javascript
const { createYoga } = require('graphql-yoga');
const { createServer } = require('http');
const simfinity = require('@simtlix/simfinity-js');

const { auth } = simfinity;
const { createAuthPlugin, requireAuth, requireRole, composeRules, isOwner, deny } = auth;

// Define your types and connect them
simfinity.connect(null, SerieType, 'serie', 'series');
simfinity.connect(null, SeasonType, 'season', 'seasons');
simfinity.connect(null, StarType, 'star', 'stars');

// Create base schema
const schema = simfinity.createSchema();

// Define permissions
// Query/Mutation names match the ones generated by simfinity.connect()
const permissions = {
  Query: {
    series: requireAuth(),
    seasons: requireAuth(),
    stars: requireAuth(),
  },
  Mutation: {
    addserie: requireAuth(),
    updateserie: composeRules(requireAuth(), isOwner('createdBy')),
    deleteserie: requireRole('admin'),
    deletestar: requireRole('admin'),
  },
  serie: {
    '*': requireAuth(),
  },
  season: {
    '*': requireAuth(),
  },
};

// Create auth plugin
const authPlugin = createAuthPlugin(permissions, {
  defaultPolicy: 'ALLOW',
  debug: false,
});

// Setup Yoga with the auth plugin
const yoga = createYoga({
  schema,
  plugins: [authPlugin],
  context: (req) => ({
    user: req.user,  // Set by your authentication layer
  }),
});

const server = createServer(yoga);
server.listen(4000);
```

### Legacy: Integration with graphql-middleware

> **Deprecated:** `applyMiddleware` from `graphql-middleware` rebuilds the schema via `mapSchema`,
> which can cause `"Schema must contain uniquely named types"` errors with Simfinity schemas.
> Use `createAuthPlugin` with GraphQL Yoga / Envelop instead.

```javascript
const { applyMiddleware } = require('graphql-middleware');
const simfinity = require('@simtlix/simfinity-js');

const { auth } = simfinity;
const { createAuthMiddleware, requireAuth, requireRole } = auth;

const baseSchema = simfinity.createSchema();

const authMiddleware = createAuthMiddleware(permissions, {
  defaultPolicy: 'DENY',
});

const schema = applyMiddleware(baseSchema, authMiddleware);
```

### Plugin / Middleware Options

```javascript
const plugin = createAuthPlugin(permissions, {
  defaultPolicy: 'DENY',  // 'ALLOW' or 'DENY' (default: 'DENY')
  debug: false,           // Enable debug logging
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultPolicy` | `'ALLOW' \| 'DENY'` | `'DENY'` | Policy when no rule matches |
| `debug` | `boolean` | `false` | Log authorization decisions |

### Error Handling

The auth middleware uses Simfinity error classes:

```javascript
const { auth } = require('@simtlix/simfinity-js');

const { UnauthenticatedError, ForbiddenError } = auth;

// UnauthenticatedError: code 'UNAUTHENTICATED', status 401
// ForbiddenError: code 'FORBIDDEN', status 403
```

Custom error handling in rules:

```javascript
const permissions = {
  Mutation: {
    deleteserie: async (parent, args, ctx) => {
      if (!ctx.user) {
        throw new auth.UnauthenticatedError('Please log in');
      }
      if (ctx.user.role !== 'admin') {
        throw new auth.ForbiddenError('Only admins can delete series');
      }
      return true;
    },
  },
};
```

### Best Practices

1. **Default to DENY**: Use `defaultPolicy: 'DENY'` for security
2. **Use wildcards wisely**: `'*'` rules provide baseline security per type
3. **Prefer helper rules**: Use `requireAuth()`, `requireRole()` over custom functions
4. **Fail closed**: Custom rules should deny on unexpected conditions
5. **Keep rules simple**: Complex logic belongs in controllers, not auth rules
6. **Test thoroughly**: Auth rules are critical - test all scenarios

## 🔧 Middlewares

Middlewares provide a powerful way to intercept and process all GraphQL operations before they execute. Use them for cross-cutting concerns like authentication, logging, validation, and performance monitoring.

### Adding Middlewares

Register middlewares using `simfinity.use()`. Middlewares execute in the order they're registered:

```javascript
// Basic logging middleware
simfinity.use((params, next) => {
  console.log(`Executing ${params.operation} on ${params.type?.name || 'custom mutation'}`);
  next();
});
```

### Middleware Parameters

Each middleware receives a `params` object containing:

```javascript
simfinity.use((params, next) => {
  // params object contains:
  const {
    type,        // Type information (model, gqltype, controller, etc.)
    args,        // GraphQL arguments passed to the operation
    operation,   // Operation type: 'save', 'update', 'delete', 'get_by_id', 'find', 'state_changed', 'custom_mutation'
    context,     // GraphQL context object (includes request info, user data, etc.)
    actionName,  // For state machine actions (only present for state_changed operations)
    actionField, // State machine action details (only present for state_changed operations)
    entry        // Custom mutation name (only present for custom_mutation operations)
  } = params;
  
  // Always call next() to continue the middleware chain
  next();
});
```

### Common Use Cases

#### 1. Authentication & Authorization

```javascript
simfinity.use((params, next) => {
  const { context, operation, type } = params;
  
  // Skip authentication for read operations
  if (operation === 'get_by_id' || operation === 'find') {
    return next();
  }
  
  // Check if user is authenticated
  if (!context.user) {
    throw new simfinity.SimfinityError('Authentication required', 'UNAUTHORIZED', 401);
  }
  
  // Check permissions for specific types
  if (type?.name === 'User' && context.user.role !== 'admin') {
    throw new simfinity.SimfinityError('Admin access required', 'FORBIDDEN', 403);
  }
  
  next();
});
```

#### 2. Request Logging & Monitoring

```javascript
simfinity.use((params, next) => {
  const { operation, type, args, context } = params;
  const startTime = Date.now();
  
  console.log(`[${new Date().toISOString()}] Starting ${operation}${type ? ` on ${type.name}` : ''}`);
  
  // Continue with the operation
  next();
  
  const duration = Date.now() - startTime;
  console.log(`[${new Date().toISOString()}] Completed ${operation} in ${duration}ms`);
});
```

#### 3. Input Validation & Sanitization

```javascript
simfinity.use((params, next) => {
  const { operation, args, type } = params;
  
  // Validate input for save operations
  if (operation === 'save' && args.input) {
    // Trim string fields
    Object.keys(args.input).forEach(key => {
      if (typeof args.input[key] === 'string') {
        args.input[key] = args.input[key].trim();
      }
    });
    
    // Validate required business rules
    if (type?.name === 'Book' && args.input.title && args.input.title.length < 3) {
      throw new simfinity.SimfinityError('Book title must be at least 3 characters', 'VALIDATION_ERROR', 400);
    }
  }
  
  next();
});
```

#### 4. Rate Limiting

```javascript
const requestCounts = new Map();

simfinity.use((params, next) => {
  const { context, operation } = params;
  const userId = context.user?.id || context.ip;
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const maxRequests = 100;
  
  // Only apply rate limiting to mutations
  if (operation === 'save' || operation === 'update' || operation === 'delete') {
    const userRequests = requestCounts.get(userId) || [];
    const recentRequests = userRequests.filter(time => now - time < windowMs);
    
    if (recentRequests.length >= maxRequests) {
      throw new simfinity.SimfinityError('Rate limit exceeded', 'TOO_MANY_REQUESTS', 429);
    }
    
    recentRequests.push(now);
    requestCounts.set(userId, recentRequests);
  }
  
  next();
});
```

#### 5. Audit Trail

```javascript
simfinity.use((params, next) => {
  const { operation, type, args, context } = params;
  
  // Log all mutations for audit purposes
  if (operation === 'save' || operation === 'update' || operation === 'delete') {
    const auditEntry = {
      timestamp: new Date(),
      user: context.user?.id,
      operation,
      type: type?.name,
      entityId: args.id || 'new',
      data: operation === 'delete' ? null : args.input,
      ip: context.ip,
      userAgent: context.userAgent
    };
    
    // Save to audit log (could be database, file, or external service)
    console.log('AUDIT:', JSON.stringify(auditEntry));
  }
  
  next();
});
```

### Multiple Middlewares

Middlewares execute in registration order. Each middleware must call `next()` to continue the chain:

```javascript
// Middleware 1: Authentication
simfinity.use((params, next) => {
  console.log('1. Checking authentication...');
  // Authentication logic here
  next(); // Continue to next middleware
});

// Middleware 2: Authorization  
simfinity.use((params, next) => {
  console.log('2. Checking permissions...');
  // Authorization logic here
  next(); // Continue to next middleware
});

// Middleware 3: Logging
simfinity.use((params, next) => {
  console.log('3. Logging request...');
  // Logging logic here
  next(); // Continue to GraphQL operation
});
```

### Error Handling in Middlewares

Middlewares can throw errors to stop the operation:

```javascript
simfinity.use((params, next) => {
  const { context, operation } = params;
  
  try {
    // Validation logic
    if (!context.user && operation !== 'find') {
      throw new simfinity.SimfinityError('Authentication required', 'UNAUTHORIZED', 401);
    }
    
    next(); // Continue only if validation passes
  } catch (error) {
    // Error automatically bubbles up to GraphQL error handling
    throw error;
  }
});
```

### Conditional Middleware Execution

Execute middleware logic conditionally based on operation type or context:

```javascript
simfinity.use((params, next) => {
  const { operation, type, context } = params;
  
  // Only apply to specific types
  if (type?.name === 'SensitiveData') {
    // Special handling for sensitive data
    if (!context.user?.hasHighSecurity) {
      throw new simfinity.SimfinityError('High security clearance required', 'FORBIDDEN', 403);
    }
  }
  
  // Only apply to mutation operations
  if (['save', 'update', 'delete', 'state_changed'].includes(operation)) {
    // Mutation-specific logic
    console.log(`Mutation ${operation} executing...`);
  }
  
  next();
});
```

### Best Practices

1. **Always call `next()`**: Failing to call `next()` will hang the request
2. **Handle errors gracefully**: Use try-catch blocks for error-prone operations
3. **Keep middlewares focused**: Each middleware should handle one concern
4. **Order matters**: Register middlewares in logical order (auth → validation → logging)
5. **Performance consideration**: Middlewares run on every operation, keep them lightweight
6. **Use context wisely**: Store request-specific data in the GraphQL context object

## 🔧 Advanced Features

### Field Extensions

Control field behavior with extensions:

```javascript
const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: GraphQLID },
    title: { 
      type: GraphQLString,
      extensions: {
        unique: true,        // Creates unique index in MongoDB
        readOnly: true       // Excludes from input types
      }
    },
    isbn: {
      type: GraphQLString,
      extensions: {
        unique: true
      }
    }
  })
});
```

### Custom Mutations

Register custom mutations beyond the automatic CRUD operations:

```javascript
simfinity.registerMutation(
  'sendBookNotification',
  'Send notification about a book',
  BookNotificationInput,    // Input type
  NotificationResult,       // Output type
  async (args, session) => {
    // Custom business logic
    const book = await BookModel.findById(args.bookId);
    // Send notification logic here
    return { success: true, message: 'Notification sent' };
  }
);
```

### Adding Types Without Endpoints

Include types in the schema without generating endpoints. See the [detailed guide on addNoEndpointType()](#adding-types-without-endpoints) for when and how to use this pattern:

```javascript
// This type can be used in relationships but won't have queries/mutations
simfinity.addNoEndpointType(AddressType);
```

### Working with Existing Mongoose Models

Use your existing Mongoose models:

```javascript
const mongoose = require('mongoose');

const BookSchema = new mongoose.Schema({
  title: String,
  author: String,
  publishedDate: Date
});

const BookModel = mongoose.model('Book', BookSchema);

// Use existing model
simfinity.connect(BookModel, BookType, 'book', 'books');
```

### Programmatic Data Access

Access data programmatically outside of GraphQL:

```javascript
// Save an object programmatically
const newBook = await simfinity.saveObject('Book', {
  title: 'New Book',
  author: 'Author Name'
}, session);

// Get the Mongoose model for a type
const BookModel = simfinity.getModel(BookType);
const books = await BookModel.find({ author: 'Douglas Adams' });

// Get the GraphQL type definition by name
const UserType = simfinity.getType('User');
console.log(UserType.name); // 'User'
console.log(UserType.getFields()); // Access GraphQL fields

// Get the input type for a GraphQL type
const BookInput = simfinity.getInputType(BookType);
```

## 🤖 MCP Generation

Simfinity can automatically expose every generated GraphQL operation as a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) tool. For each connected type you get one MCP tool per generated query and mutation — exactly mirroring the GraphQL surface:

| GraphQL operation | MCP tool name |
| --- | --- |
| Single-entity query | `book` |
| List query | `books` |
| Aggregate query | `books_aggregate` |
| Add mutation | `addbook` |
| Update mutation | `updatebook` |
| Delete mutation | `deletebook` |
| State-machine action | `publish_book` |
| Custom mutation | _the registered name_ |

Each generated tool follows MCP best practices so an agent can use it without extra context:

- **`description`**: reuses the GraphQL type/field descriptions and adds an actionable summary. List and aggregate tools spell out the available filter operators (`EQ, NE, LT, LTE, GT, GTE, IN, NIN, BTW, LIKE`), `AND`/`OR` groups, pagination and sorting; aggregate tools additionally document the `SUM/COUNT/AVG/MIN/MAX` operations and the `aggregation` argument.
- **`title`**: a human-readable label (e.g. `List Book`, `Create Book`, `Aggregate Book`).
- **`inputSchema`**: JSON Schema derived with full fidelity from the GraphQL arguments (scalars, enums, input objects, lists, non-null wrappers, and recursive filter types such as `QLFilterGroup` via `$defs`/`$ref`). GraphQL type and field descriptions are propagated, with curated descriptions for the synthetic filter/pagination/sort/aggregation types. `Date`/`DateTime`/`Time` scalars map to `string` with the matching JSON Schema `format` (`date` / `date-time` / `time`), and arguments with a GraphQL default value carry a JSON Schema `default` and are never listed as `required`.
- **`outputSchema`**: JSON Schema describing the returned data (mirroring the auto-generated selection set), with type/field descriptions. Every nullable GraphQL position also accepts `null` (e.g. `type: ['string', 'null']`; enums get `null` appended), so validating MCP clients accept the `null`s GraphQL legitimately returns in `structuredContent` (get-by-id misses, unset optional fields). Non-null positions stay single-typed, and input schemas are never null-widened.
- **`annotations`**: behavioral hints — queries are `readOnlyHint: true`, `delete*` is `destructiveHint: true`, `update*` is `idempotentHint: true`. Generated CRUD mutations are recognized by the placeholder descriptions Simfinity stamps on them, so a custom mutation that happens to be named `updateReport` (and carries its own description) keeps that description and gets no inferred hints.

On execution, each tool returns both a serialized JSON `text` content block and a machine-readable `structuredContent` (the GraphQL `data`) that conforms to the `outputSchema`. When the caller requests `pagination: { count: true }` on a **list** tool, the total record count is delivered in the tool result `_meta.count` (aggregate tools ignore the flag — their resolver never computes a total).

> The MCP transports require the optional `@modelcontextprotocol/sdk` dependency (`^1.13.0` or newer). Install it with `npm install @modelcontextprotocol/sdk`. `generateMCPTools` works without it. SDK load problems raise distinct error codes: `MCP_SDK_NOT_INSTALLED` (not installed), `MCP_SDK_INCOMPATIBLE` (installed but too old to provide the requested transport — upgrade it), `MCP_SDK_LOAD_FAILED` (any other import failure).

### Installation

```bash
npm install @modelcontextprotocol/sdk
```

### Generating tool definitions

`generateMCPTools(schema, options)` returns the tool list, a `callTool` executor and a `getOperation` inspector. It does not require the SDK and is handy for inspection or custom wiring:

```javascript
import * as simfinity from '@simtlix/simfinity-js';

const schema = simfinity.createSchema();
const { tools, callTool, getOperation } = simfinity.generateMCPTools(schema);

// tools: [{ name, title, description, inputSchema, outputSchema, annotations, kind }, ...]
const result = await callTool('addbook', { input: { title: 'Dune' } });
// result: { content: [{ type: 'text', text: '...JSON...' }],
//           structuredContent: { addbook: { ... } }, isError: false }

// getOperation returns the prebuilt GraphQL document a tool executes
console.log(getOperation('books'));
// query booksOperation($id: QLFilter, $pagination: QLPagination, ...) {
//   books(id: $id, pagination: $pagination, ...) { id title ... }
// }
```

Both `callTool` and `getOperation` throw a `SimfinityError` with code `MCP_TOOL_NOT_FOUND` for unknown tool names.

### Standalone MCP server (stdio)

Use stdio for a standalone executable consumed by clients like Cursor or Claude Desktop:

```javascript
import * as simfinity from '@simtlix/simfinity-js';

const schema = simfinity.createSchema();
await simfinity.startStdioMCPServer(schema, {
  serverName: 'my-api-mcp',
  context: { user: { id: 'system' } },
});
```

### HTTP MCP endpoint (alongside GraphQL)

Mount an MCP endpoint (Streamable HTTP) next to your existing GraphQL server:

```javascript
import express from 'express';
import * as simfinity from '@simtlix/simfinity-js';

const schema = simfinity.createSchema();
const app = express();
app.use(express.json());

const mcpHandler = await simfinity.createHTTPMCPHandler(schema, {
  // In HTTP mode the context factory receives the Express `req`,
  // so you can authenticate per request (e.g. from the Authorization header).
  context: (req) => ({ user: resolveUserFrom(req.headers.authorization) }),
});
app.post('/mcp', mcpHandler);
```

For deployments reachable from a browser (especially localhost), enable the SDK's DNS-rebinding protection via `transportOptions`, and observe failures with `onError`:

```javascript
const mcpHandler = await simfinity.createHTTPMCPHandler(schema, {
  context: (req) => ({ user: resolveUserFrom(req.headers.authorization) }),
  // Spread into the SDK's StreamableHTTPServerTransport options
  transportOptions: {
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
    allowedOrigins: ['http://localhost:3000'],
  },
  onError: (err, req, res) => console.error('MCP request failed', err),
});
```

The handler catches all errors itself: `onError` is for logging/metrics, and a JSON-RPC internal error (HTTP 500) is sent automatically when response headers were not already written.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `execution` | `{ mode: 'in-process' }` | `in-process` runs against the in-memory `schema`. `remote` issues HTTP GraphQL requests: `{ mode: 'remote', endpoint, headers, timeoutMs, retry: { attempts, backoffMs } }`. See [Remote execution](#remote-execution). |
| `context` | `{}` | GraphQL context value, or a factory. For in-process/stdio it is called as `(extra) => context`; for the HTTP handler it is called as `(req, extra) => context` so you can authenticate per request. Passed through to execution so `scope` functions and auth rules work (they read `context.user`). |
| `include` / `exclude` | — | String or array: raw GraphQL field names, prefixed tool names, or the categories `'query'` / `'mutation'`. `exclude` wins over `include`. |
| `includeTypes` / `excludeTypes` | — | String or array of entity (return) type names — one entry covers every tool for that entity (`'Book'` matches `book`, `books`, `books_aggregate`, `addbook`, ...). `excludeTypes` wins. |
| `selectionDepth` | `1` | Nesting depth for the auto-generated output selection set (and the mirrored `outputSchema`). |
| `includeId` | `true` | Always select `id` when nothing else is selectable on an object type. |
| `toolNamePrefix` | — | Prefix prepended to every published tool name (e.g. `'catalog_'`). Must match `/^[a-zA-Z0-9_-]+$/`; the resulting names must match `/^[a-zA-Z0-9_-]{1,128}$/` (`MCP_INVALID_TOOL_NAME` otherwise). |
| `toolOverrides` | `{}` | Per-tool overrides keyed by tool (or unprefixed field) name: `{ description, title, annotations, selectionDepth, includeId, selection }`. See [Customizing tools](#customizing-tools). |
| `toolMiddleware` | — | Array of koa-style `async (call, next)` functions run around every tool call. See [Tool middleware](#tool-middleware). |
| `limits` | — | Guardrails: `{ maxPageSize, defaultPagination, maxResultBytes }`. See [Limits](#limits). |
| `schemaPlugins` | — | Envelop-style plugins whose `onSchemaChange` hook is applied once before serving (in-process execution only). See [Authentication](#authentication). |
| `serverName` / `serverVersion` | `'simfinity-mcp'` / `'1.0.0'` | Identity reported by the MCP server. |
| `transportOptions` | — | `createHTTPMCPHandler` only: extra options spread into the SDK's `StreamableHTTPServerTransport` (e.g. `enableDnsRebindingProtection`, `allowedHosts`, `allowedOrigins`). |
| `onError` | — | `createHTTPMCPHandler` only: `(err, req, res)` callback invoked when a request fails; the handler still responds with a JSON-RPC internal error (HTTP 500) if headers were not sent. |

Selection sets always fall back to `id` and then `__typename` when nothing else is selectable (interface/union return types select `__typename`), so the generated documents are always statically valid — and the output schemas mirror the same fallbacks.

### Selecting and naming tools

Trim and namespace the published surface with `include`/`exclude`, `includeTypes`/`excludeTypes` and `toolNamePrefix`:

```javascript
const { tools, callTool, getOperation } = simfinity.generateMCPTools(schema, {
  exclude: 'mutation',          // read-only server
  excludeTypes: 'AuditLog',     // hide every tool whose entity type is AuditLog
  toolNamePrefix: 'catalog_',   // books -> catalog_books
});

// callTool/getOperation use the published (prefixed) name;
// the underlying GraphQL document still uses the raw field name.
console.log(getOperation('catalog_books'));
// query booksOperation(...) { books(...) { ... } }
```

- `include`/`exclude` entries match the raw GraphQL field name, the prefixed tool name, or the categories `'query'` / `'mutation'`. `exclude` always wins over `include`.
- `includeTypes`/`excludeTypes` match the entity (return) type. Aggregate queries resolve their entity through the sibling list field (`books_aggregate` → `books`), so `excludeTypes: 'Book'` also hides the aggregate tool. With an `includeTypes` allowlist, tools without an object return type are dropped too.
- Duplicate tool names (e.g. a Query field and a Mutation field sharing a name) are not allowed by MCP: the first tool wins and the later one is skipped with a `console.warn` — rename one of the GraphQL fields or use `include`/`exclude`.

### Customizing tools

`toolOverrides` tunes individual tools without touching the schema. Keys accept either the published tool name or the unprefixed field name:

```javascript
const { tools } = simfinity.generateMCPTools(schema, {
  toolOverrides: {
    books: {
      title: 'Search books',
      description: 'Search the book catalog. Filter by title, author or publication year.',
      selectionDepth: 2,                        // deeper selection set for this tool only
    },
    publish_book: {
      annotations: { idempotentHint: true },    // merged over the generated annotations
    },
    book: {
      selection: 'id title author { name }',    // explicit selection set
    },
  },
});
```

`selection` accepts `'id title'` or `'{ id title }'` and replaces the auto-generated selection set. When it is set, the `outputSchema` is **omitted** for that tool — it can no longer be guaranteed to match the returned data, and publishing a wrong schema would make validating clients reject valid results.

### Limits

`limits` protects agents (and your database) from oversized requests and responses. Violations come back as regular `isError` tool results, not exceptions:

```javascript
const { callTool } = simfinity.generateMCPTools(schema, {
  limits: {
    maxPageSize: 100,                          // MCP_PAGE_SIZE_EXCEEDED above this
    defaultPagination: { page: 1, size: 20 },  // injected when the caller sends none
    maxResultBytes: 262144,                    // MCP_RESULT_TOO_LARGE above this
  },
});
```

- `maxPageSize`: rejects calls whose `pagination.size` exceeds the cap.
- `defaultPagination`: injected only for tools that have a `pagination` argument, and only when the caller did not send one. `page` and `size` are both required (QLPagination declares them non-null), and `size` must not exceed `maxPageSize` — that misconfiguration throws `MCP_INVALID_LIMITS` at setup.
- `maxResultBytes`: rejects results whose serialized `data` is larger than the cap (the error message suggests narrowing the query, lowering `selectionDepth` or paginating).

### Tool middleware

`toolMiddleware` wraps every tool execution with koa-style `(call, next)` functions — for logging, metrics, argument rewriting or policy checks. `call` is `{ name, args, extra, kind, operation }`:

```javascript
const { callTool } = simfinity.generateMCPTools(schema, {
  toolMiddleware: [
    async (call, next) => {
      const started = Date.now();
      const result = await next();
      console.log(`[mcp] ${call.name} (${call.kind}) took ${Date.now() - started}ms`);
      return result;
    },
    async (call, next) => {
      if (call.kind === 'mutation' && process.env.MCP_READ_ONLY === 'true') {
        // Short-circuit: return a result without calling next()
        return {
          content: [{ type: 'text', text: 'Mutations are disabled on this server.' }],
          isError: true,
        };
      }
      return next();
    },
  ],
});
```

Middleware can mutate `call.args` before calling `next()`, short-circuit by returning a result, or throw. Calling `next()` twice rejects with `MCP_MIDDLEWARE_ERROR`.

### Remote execution

`execution.mode: 'remote'` turns the MCP server into a thin proxy that POSTs each operation to an existing GraphQL endpoint. Harden it with `timeoutMs` and `retry`:

```javascript
const { callTool } = simfinity.generateMCPTools(schema, {
  execution: {
    mode: 'remote',
    endpoint: 'https://api.example.com/graphql',
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10000,                        // abort requests slower than 10s
    retry: { attempts: 2, backoffMs: 250 },  // up to 2 extra attempts, linear backoff
  },
});
```

- `timeoutMs` aborts slow requests (`AbortSignal.timeout`); the timeout signal is combined with the MCP client's cancellation signal.
- `retry` re-issues failed **queries only — never mutations** — after network errors/timeouts, HTTP 5xx and 429 responses. Backoff is linear: the first retry waits `backoffMs`, the second `2 × backoffMs`, and so on (default `backoffMs`: 250).
- Transport failures do not throw: they surface as `isError` tool results carrying GraphQL-shaped errors with the codes `MCP_REMOTE_HTTP_ERROR` (non-2xx response, includes `extensions.status`), `MCP_REMOTE_REQUEST_FAILED` (network error/timeout) and `MCP_REMOTE_INVALID_RESPONSE` (non-JSON body, or JSON with neither `data` nor `errors`).
- If the remote response carries a numeric `extensions.count` (e.g. exposed via `simfinity.plugins.envelopCountPlugin()`), it is surfaced as `_meta.count` on the tool result.

`schemaPlugins` is not applied in remote mode — the remote GraphQL server enforces its own plugins.

### Tool results and errors

Successful calls return `{ content: [textJSON], structuredContent: data, isError: false }`. Failures and edge cases behave as follows:

- **Total count**: with `pagination: { count: true }` on a **list** tool, the count lands in `_meta.count` on the tool result — in-process it is read back from a per-call context layer (Simfinity's find resolver writes it there; counts never leak across calls), in remote mode from the response `extensions.count`. Aggregate tools never deliver a count.
- **Execution errors**: `isError: true` with a `text` payload of `{ errors, data? }` — partial data is preserved alongside the errors when GraphQL returned any. `structuredContent` is omitted on errors.
- **Remote transport failures** and **limit violations** are also `isError` results (see [Remote execution](#remote-execution) and [Limits](#limits) for the codes).
- **Unknown tool names** are the exception: `callTool` and `getOperation` throw `MCP_TOOL_NOT_FOUND`. A call whose `extra.signal` is already aborted throws `MCP_CALL_CANCELLED` before executing.

### Authentication

The MCP tools execute the same resolvers as GraphQL, so the GraphQL `context` flows through unchanged: pass credentials via `options.context` (a value or a factory). [Query scope](#-query-scope) functions read the context on every execution and need no extra wiring.

Field-level rules from [`createAuthPlugin`](#-authorization) are different. The auth plugin is an Envelop plugin that wraps resolvers from its `onSchemaChange` hook — a hook that only fires when an Envelop/Yoga server boots. A standalone MCP server executes operations with bare `graphql()`, so without help the hook never fires and the field-level rules are silently skipped. Pass the plugin via `schemaPlugins` to get auth parity: every plugin's `onSchemaChange` is invoked once before serving (in-process execution only):

```javascript
import * as simfinity from '@simtlix/simfinity-js';

const { createAuthPlugin, requireAuth, requireRole } = simfinity.auth;

// Permissions are keyed by the schema's type names. Simfinity names its
// roots `RootQueryType` and `Mutation`.
const permissions = {
  RootQueryType: { books: requireAuth() },
  Mutation: { deletebook: requireRole('admin') },
};

const schema = simfinity.createSchema();
await simfinity.startStdioMCPServer(schema, {
  // requireRole reads `user.role` by default (see rolePath to customize).
  context: { user: { id: 'agent', role: 'admin' } },
  schemaPlugins: [createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' })],
});
```

Mounting the MCP handler next to a running Envelop/Yoga server that shares the same `schema` object also works: Yoga fires `onSchemaChange` at startup and `createAuthPlugin` wraps the resolvers in place, so the MCP tools execute the already-wrapped schema.

For per-request HTTP auth, use a function `context`: the HTTP handler invokes it as `(req, extra) => context`, so you can read the `Authorization` header from the Express `req` and map it to `context.user` exactly like your GraphQL server does.

## 📊 Aggregation Queries

Simfinity.js now supports powerful GraphQL aggregation queries with GROUP BY functionality, allowing you to perform aggregate operations (SUM, COUNT, AVG, MIN, MAX) on your data.

### Overview

For each entity type registered with `connect()`, an additional aggregation endpoint is automatically generated with the format `{entityname}_aggregate`.

### Features

- **Group By**: Group results by any field (direct or related entity field path)
- **Aggregation Operations**: SUM, COUNT, AVG, MIN, MAX
- **Filtering**: Use the same filter parameters as regular queries
- **Sorting**: Sort by groupId or any calculated fact (metrics), with support for multiple sort fields
- **Pagination**: Use the same pagination parameters as regular queries
- **Related Entity Fields**: Group by or aggregate on fields from related entities using dot notation

### GraphQL Types

#### QLAggregationOperation (Enum)
- `SUM`: Sum of numeric values
- `COUNT`: Count of records
- `AVG`: Average of numeric values
- `MIN`: Minimum value
- `MAX`: Maximum value

#### QLTypeAggregationFact (Input)
```graphql
input QLTypeAggregationFact {
  operation: QLAggregationOperation!
  factName: String!
  path: String!
}
```

#### QLTypeAggregationExpression (Input)
```graphql
input QLTypeAggregationExpression {
  groupId: String!
  facts: [QLTypeAggregationFact!]!
}
```

#### QLTypeAggregationResult (Output)
```graphql
type QLTypeAggregationResult {
  groupId: JSON
  facts: JSON
}
```

### Quick Examples

#### Simple Group By
```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "total", path: "id" }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

#### Group By Related Entity
```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "country.name"
      facts: [
        { operation: COUNT, factName: "count", path: "id" }
        { operation: AVG, factName: "avgRating", path: "rating" }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

#### Multiple Aggregation Facts
```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "total", path: "id" }
        { operation: SUM, factName: "totalEpisodes", path: "episodeCount" }
        { operation: AVG, factName: "avgRating", path: "rating" }
        { operation: MIN, factName: "minRating", path: "rating" }
        { operation: MAX, factName: "maxRating", path: "rating" }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

#### With Filtering
```graphql
query {
  series_aggregate(
    rating: { operator: GTE, value: 8.0 }
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "highRated", path: "id" }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

#### Sorting by Multiple Fields
```graphql
query {
  series_aggregate(
    sort: {
      terms: [
        { field: "total", order: "DESC" },       # Sort by count first
        { field: "groupId", order: "ASC" }       # Then by name
      ]
    }
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "total", path: "id" }
        { operation: AVG, factName: "avgRating", path: "rating" }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

#### With Pagination (Top 5)
```graphql
query {
  series_aggregate(
    sort: {
      terms: [{ field: "total", order: "DESC" }]
    }
    pagination: {
      page: 1
      size: 5
    }
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "total", path: "id" }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

### Field Path Resolution

The `groupId` and `path` parameters support:

1. **Direct Fields**: Simple field names from the entity
   - Example: `"category"`, `"rating"`, `"id"`

2. **Related Entity Fields**: Dot notation for fields in related entities
   - Example: `"country.name"`, `"studio.foundedYear"`
   
3. **Nested Related Entities**: Multiple levels of relationships
   - Example: `"country.region.name"`

### Sorting Options

- Sort by **groupId** or **any fact name**
- **Multiple sort fields supported** - results are sorted by the first field, then by the second field for ties, etc.
- Set the `field` parameter to:
  - `"groupId"` to sort by the grouping field
  - Any fact name (e.g., `"avgRating"`, `"total"`) to sort by that calculated metric
- The `order` parameter (ASC/DESC) determines the sort direction for each field
- If a field doesn't match groupId or any fact name, it defaults to groupId
- If no sort is specified, defaults to sorting by groupId ascending

### Pagination Notes

- The `page` and `size` parameters work as expected
- The `count` parameter is **ignored** for aggregation queries
- Pagination is applied **after** grouping and sorting

### MongoDB Translation

Aggregation queries are translated to efficient MongoDB aggregation pipelines:

1. **$lookup**: Joins with related entity collections
2. **$unwind**: Flattens joined arrays
3. **$match**: Applies filters (before grouping)
4. **$group**: Groups by the specified field with aggregation operations
5. **$project**: Formats final output with groupId and facts fields
6. **$sort**: Sorts results by groupId or facts (with multiple fields support)
7. **$limit** / **$skip**: Applied for pagination (after sorting)

### Result Structure

Results are returned in a consistent format:
```json
{
  "groupId": <value>,
  "facts": {
    "factName1": <calculated_value>,
    "factName2": <calculated_value>
  }
}
```

For complete documentation with more examples, see [AGGREGATION_EXAMPLE.md](./AGGREGATION_EXAMPLE.md) and [AGGREGATION_CHANGES_SUMMARY.md](./AGGREGATION_CHANGES_SUMMARY.md).

## 📚 Complete Example

Here's a complete bookstore example with relationships, validations, and state machines:

```javascript
const express = require('express');
const { graphqlHTTP } = require('express-graphql');
const mongoose = require('mongoose');
const { 
  GraphQLObjectType, 
  GraphQLString, 
  GraphQLNonNull, 
  GraphQLID, 
  GraphQLList,
  GraphQLInt,
  GraphQLEnumType
} = require('graphql');
const simfinity = require('@simtlix/simfinity-js');

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/bookstore', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Define Types
const AuthorType = new GraphQLObjectType({
  name: 'Author',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: GraphQLString },
    books: {
      type: new GraphQLList(BookType),
      extensions: {
        relation: {
          connectionField: 'author',
          displayField: 'title'
        },
      },
      resolve(parent) {
        return simfinity.getModel(BookType).find({ author: parent.id });
      }
    },
  }),
});

const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { 
      type: new GraphQLNonNull(GraphQLString),
      extensions: {
        validations: {
          save: [{
            validate: async (typeName, fieldName, value, session) => {
              if (!value || value.length < 2) {
                throw new simfinity.SimfinityError('Title must be at least 2 characters', 'VALIDATION_ERROR', 400);
              }
            }
          }]
        }
      }
    },
    pages: { type: GraphQLInt },
    author: {
      type: AuthorType,
      extensions: {
        relation: {
          displayField: 'name'
        },
      },
      resolve(parent) {
        return simfinity.getModel(AuthorType).findById(parent.author);
      }
    },
  }),
});

// Define Controllers
const bookController = {
  onSaving: async (doc, args, session) => {
    console.log(`Creating book: ${doc.title}`);
  },
  
  onSaved: async (doc, args, session) => {
    console.log(`Book saved: ${doc.title}`);
  }
};

// Connect Types
simfinity.connect(null, AuthorType, 'author', 'authors');
simfinity.connect(null, BookType, 'book', 'books', bookController);

// Create Schema
const schema = simfinity.createSchema();

// Setup Express Server
const app = express();

app.use('/graphql', graphqlHTTP({
  schema,
  graphiql: true,
  formatError: simfinity.buildErrorFormatter((err) => {
    console.log(err);
  })
}));

app.listen(4000, () => {
  console.log('Bookstore API running on http://localhost:4000/graphql');
});
```

## 🔗 Resources

- **[Series Sample Project](https://github.com/simtlix/series-sample)** - A complete TV series microservice built with Simfinity.js demonstrating types, relationships, state machines, controllers, and authorization
- **[Samples Repository](https://github.com/simtlix/simfinity.js-samples)** - Complete examples and use cases
- **[MongoDB Query Language](https://docs.mongodb.com/manual/tutorial/query-documents/)** - Learn about MongoDB querying
- **[GraphQL Documentation](https://graphql.org/learn/)** - Learn about GraphQL

## 📄 License

Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

*Built with ❤️ by [Simtlix](https://github.com/simtlix)*


## 📚 Query Examples from Series-Sample

Here are some practical GraphQL query examples from the series-sample project, showcasing how to use simfinity.js effectively:

### 1. Series with Directors from a Specific Country

Find all series that have directors from the United States:

```graphql
query {
  series(director: {
    terms: [
      {
        path: "country",
        operator: EQ,
        value: "United States"
      }
    ]
  }) {
    id
    name
    categories
    director {
      name
      country
    }
  }
}
```

### 2. Series with a Specific Episode Name

Find series that contain an episode with the name "Pilot":

```graphql
query {
  series(
    seasons: {
      terms: [
        {
          path: "episodes.name",
          operator: EQ,
          value: "Pilot"
        }
      ]
    }
  ) {
    id
    name
    seasons {
      number
      episodes {
        number
        name
        date
      }
    }
  }
}
```

### 3. Series with a Particular Star

Find series that feature "Bryan Cranston":

```graphql
query {
  assignedStarsAndSeries(star: {
    terms: [
      {
        path: "name",
        operator: EQ,
        value: "Bryan Cranston"
      }
    ]
  }) {
    id
    star {
      name
    }
    serie {
      id
      name
      categories
      director {
        name
        country
      }
    }
  }
}
```

### 4. Seasons from Series with Directors from a Given Country

Find all seasons that belong to series directed by someone from the United States:

```graphql
query {
  seasons(serie: {
    terms: [
      {
        path: "director.country",
        operator: EQ,
        value: "United States"
      }
    ]
  }) {
    id
    number
    year
    state
    serie {
      name
      categories
      director {
        name
        country
      }
    }
    episodes {
      number
      name
      date
    }
  }
}
```

### 5. Combining Scalar and ObjectType Filters

Find series named "Breaking Bad" that have at least one season with number 1:

```graphql
query {
  series(
    name: {
      operator: EQ,
      value: "Breaking Bad"
    }
    seasons: {
      terms: [
        {
          path: "number",
          operator: EQ,
          value: 1
        }
      ]
    }
  ) {
    id
    name
    director {
      name
      country
    }
    seasons {
      number
      episodes {
        name
      }
    }
  }
}
```

### 6. Complex Nested Queries

Get complete information for a specific series:

```graphql
query {
  series(name: {
    operator: EQ,
    value: "Breaking Bad"
  }) {
    id
    name
    categories
    director {
      name
      country
    }
    seasons {
      number
      year
      state
      episodes {
        number
        name
        date
      }
    }
  }
}
```

### 7. Episodes from a Specific Season and Series

Find all episodes from Season 1 of Breaking Bad:

```graphql
query {
  episodes(season: {
    terms: [
      {
        path: "number",
        operator: EQ,
        value: 1
      },
      {
        path: "serie.name",
        operator: EQ,
        value: "Breaking Bad"
      }
    ]
  }) {
    id
    number
    name
    date
    season {
      number
      serie {
        name
      }
    }
  }
}
```

### 8. Series by Category

Find all crime series:

```graphql
query {
  series(categories: {
    operator: EQ,
    value: "Crime"
  }) {
    id
    name
    categories
    director {
      name
      country
    }
  }
}
```

### 9. Search by Partial Episode Name

Find episodes containing "Fire" in the name:

```graphql
query {
  episodes(name: {
    operator: LIKE,
    value: "Fire"
  }) {
    id
    number
    name
    date
    season {
      number
      serie {
        name
      }
    }
  }
}
```

### 10. Pagination

Simfinity.js supports built-in pagination with optional total count:

```graphql
query {
  series(
    categories: {
      operator: EQ,
      value: "Crime"
    }
    pagination: {
      page: 1,
      size: 2,
      count: true
    }
  ) {
    id
    name
    categories
    director {
      name
      country
    }
  }
}
```

#### Pagination Parameters:
- **page**: Page number (starts at 1, not 0)
- **size**: Number of items per page
- **count**: Optional boolean - if `true`, returns total count of matching records

#### Getting Total Count:
When `count: true` is specified, the total count is available in the response extensions. You need to configure a plugin to expose it. Simfinity.js provides utility plugins for both Apollo Server and Envelop:

```javascript
const simfinity = require('@simtlix/simfinity-js');

// For Envelop
const getEnveloped = envelop({
  plugins: [
    useSchema(schema),
    simfinity.plugins.envelopCountPlugin(),
  ],
});

// For Apollo Server
const server = new ApolloServer({
  schema,
  plugins: [
    simfinity.plugins.apolloCountPlugin(),
  ],
});
```

See the [Plugins for Count in Extensions](#-plugins-for-count-in-extensions) section for complete examples.

#### Example Response:
```json
{
  "data": {
    "series": [
      {
        "id": "1",
        "name": "Breaking Bad",
        "categories": ["Crime", "Drama"],
        "director": {
          "name": "Vince Gilligan",
          "country": "United States"
        }
      },
      {
        "id": "2", 
        "name": "Better Call Saul",
        "categories": ["Crime", "Drama"],
        "director": {
          "name": "Vince Gilligan",
          "country": "United States"
        }
      }
    ]
  },
  "extensions": {
    "count": 15
  }
}
```

### 11. Sorting

Simfinity.js supports sorting with multiple fields and sort orders:

```graphql
query {
  series(
    categories: { operator: EQ, value: "Crime" }
    pagination: { page: 1, size: 5, count: true }
    sort: {
      terms: [
        {
          field: "name",
          order: DESC
        }
      ]
    }
  ) {
    id
    name
    categories
    director {
      name
      country
    }
  }
}
```

#### Sorting Parameters:
- **sort**: Contains sorting configuration
- **terms**: Array of sort criteria (allows multiple sort fields)
- **field**: The field name to sort by
- **order**: Sort order - `ASC` (ascending) or `DESC` (descending)

#### Sorting by Nested Fields:
You can sort by fields from related/nested objects using dot notation:

```graphql
query {
  series(
    categories: { operator: EQ, value: "Drama" }
    pagination: { page: 1, size: 5, count: true }
    sort: {
      terms: [
        {
          field: "director.name",
          order: DESC
        }
      ]
    }
  ) {
    id
    name
    categories
    director {
      name
      country
    }
  }
}
```

#### Multiple Sort Fields:
You can sort by multiple fields with different orders:

```graphql
query {
  series(
    sort: {
      terms: [
        { field: "director.country", order: ASC },
        { field: "name", order: DESC }
      ]
    }
  ) {
    id
    name
    director {
      name
      country
    }
  }
}
```

#### Combining Features:
The example above demonstrates combining **filtering**, **pagination**, and **sorting** in a single query - a common pattern for data tables and lists with full functionality.

### 12. Series Released in a Specific Year Range

Find series with seasons released between 2010-2015:

```graphql
query {
  seasons(year: {
    operator: BETWEEN,
    value: [2010, 2015]
  }) {
    id
    number
    year
    serie {
      name
      director {
        name
        country
      }
    }
  }
}
```


## 🔄 State Machine Example from Series-Sample

Simfinity.js provides built-in state machine support for managing entity lifecycles. Here's an example of how a state machine is implemented in the Season entity from the series-sample project.

### State Machine Configuration

State machines require **GraphQL Enum Types** to define states and proper state references:

**Step 1: Define the GraphQL Enum Type**

```javascript
const { GraphQLEnumType } = require('graphql');

const seasonState = new GraphQLEnumType({
  name: 'seasonState',
  values: {
    SCHEDULED: { value: 'SCHEDULED' },
    ACTIVE: { value: 'ACTIVE' },
    FINISHED: { value: 'FINISHED' }
  }
});
```

**Step 2: Use Enum in GraphQL Object Type**

```javascript
const seasonType = new GraphQLObjectType({
  name: 'season',
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: GraphQLInt },
    year: { type: GraphQLInt },
    state: { type: seasonState }, // ← Use the enum type
    // ... other fields
  })
});
```

**Step 3: Define State Machine with Enum Values**

```javascript
const stateMachine = {
  initialState: seasonState.getValue('SCHEDULED'),
  actions: {
    activate: {
      from: seasonState.getValue('SCHEDULED'),
      to: seasonState.getValue('ACTIVE'),
      action: async (params) => {
        console.log('Season activated:', JSON.stringify(params));
      }
    },
    finalize: {
      from: seasonState.getValue('ACTIVE'),
      to: seasonState.getValue('FINISHED'),
      action: async (params) => {
        console.log('Season finalized:', JSON.stringify(params));
      }
    }
  }
};

// Connect type with state machine
simfinity.connect(null, seasonType, 'season', 'seasons', null, null, stateMachine);
```

### Season States

The Season entity has three states:

1. **SCHEDULED** - Initial state when season is created
2. **ACTIVE** - Season is currently airing
3. **FINISHED** - Season has completed airing

### State Transitions

**Available transitions:**
- `activate`: SCHEDULED → ACTIVE
- `finalize`: ACTIVE → FINISHED

### State Machine Mutations

Simfinity.js automatically generates state transition mutations:

```graphql
# Activate a scheduled season
mutation {
  activateseason(id: "season_id_here") {
    id
    number
    year
    state
    serie {
      name
    }
  }
}
```

```graphql
# Finalize an active season
mutation {
  finalizeseason(id: "season_id_here") {
    id
    number
    year
    state
    serie {
      name
    }
  }
}
```

### State Machine Features

**Validation:**
- Only valid transitions are allowed
- Attempting invalid transitions returns an error
- State field is read-only (managed by state machine)

**Custom Actions:**
- Each transition can execute custom business logic
- Actions receive parameters including entity data
- Actions can perform side effects (logging, notifications, etc.)

**Query by State:**
```graphql
query {
  seasons(state: {
    operator: EQ,
    value: ACTIVE
  }) {
    id
    number
    year
    state
    serie {
      name
    }
  }
}
```

### State Machine Best Practices

1. **GraphQL Enum Types**: Always define states as GraphQL enums for type safety
2. **getValue() Method**: Use `enumType.getValue('VALUE')` for state machine configuration
3. **Initial State**: Define clear initial state using enum values
4. **Linear Flows**: Design logical progression (SCHEDULED → ACTIVE → FINISHED)
5. **Type Safety**: GraphQL enums provide validation and autocomplete
6. **Actions**: Implement side effects in transition actions
7. **Error Handling**: Handle transition failures gracefully

### Key Implementation Points

- **Enum Definition**: States must be defined as `GraphQLEnumType`
- **Type Reference**: Use the enum type in your GraphQL object: `state: { type: seasonState }`
- **State Machine Values**: Reference enum values with `seasonState.getValue('STATE_NAME')`
- **Automatic Validation**: GraphQL validates state values against the enum
- **IDE Support**: Enum values provide autocomplete and type checking

### Example Workflow

```graphql
# 1. Create season (automatically SCHEDULED)
mutation {
  addseason(input: {
    number: 6
    year: 2024
    serie: "series_id_here"
  }) {
    id
    state  # Will be "SCHEDULED"
  }
}

# 2. Activate season when airing begins
mutation {
  activateseason(id: "season_id_here") {
    id
    state  # Will be "ACTIVE"
  }
}

# 3. Finalize season when completed
mutation {
  finalizeseason(id: "season_id_here") {
    id
    state  # Will be "FINISHED"
  }
}
```


## 📦 Plugins for Count in Extensions

To include the total count in the extensions of your GraphQL response, Simfinity.js provides utility plugins for both Apollo Server and Envelop. This is particularly useful for pagination and analytics.

### Envelop Plugin

Use `simfinity.plugins.envelopCountPlugin()` to add count to extensions when using Envelop:

```javascript
const { envelop, useSchema } = require('@envelop/core');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const simfinity = require('@simtlix/simfinity-js');

const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

const getEnveloped = envelop({
  plugins: [
    useSchema(schema),
    simfinity.plugins.envelopCountPlugin(), // Add the count plugin here
  ],
});

// Use getEnveloped in your server setup
```

### Apollo Server Plugin

Use `simfinity.plugins.apolloCountPlugin()` to add count to extensions when using Apollo Server:

```javascript
const { ApolloServer } = require('apollo-server-express');
const simfinity = require('@simtlix/simfinity-js');

const server = new ApolloServer({
  schema,
  plugins: [
    simfinity.plugins.apolloCountPlugin(), // Add the count plugin here
  ],
  context: ({ req }) => {
    // Your context setup
    return {
      user: req.user,
      // count will be automatically added to extensions if present in context
    };
  },
});
```

### How to Use

1. **Import the Plugin**: Use `simfinity.plugins.envelopCountPlugin()` or `simfinity.plugins.apolloCountPlugin()` depending on your GraphQL server.
2. **Configure Context**: Ensure that your context includes the count value when executing queries (Simfinity.js automatically sets `context.count` when `count: true` is specified in pagination).
3. **Access Count**: The count will be available in the `extensions` field of the GraphQL response.

### Example Response

When the plugin is correctly set up, your GraphQL response will include the count in the extensions:

```json
{
  "data": {
    "series": [
      {
        "id": "1",
        "name": "Breaking Bad",
        "categories": ["Crime", "Drama"],
        "director": {
          "name": "Vince Gilligan",
          "country": "United States"
        }
      }
    ]
  },
  "extensions": {
    "count": 15
  }
}
```

This setup allows you to efficiently manage and display pagination information in your GraphQL applications.

## 📖 API Reference

Simfinity.js provides several utility methods for programmatic access to your GraphQL types and data:

### `getType(typeName)`

Retrieves a GraphQL type definition from the internal types registry.

**Parameters:**
- `typeName` (string | GraphQLObjectType): The name of the type or a GraphQL type object

**Returns:**
- `GraphQLObjectType | null`: The GraphQL type definition, or null if not found

**Examples:**

```javascript
import { getType } from '@simtlix/simfinity-js';

// Get type by string name
const UserType = getType('User');
if (UserType) {
  console.log(UserType.name); // 'User'
  
  // Access field definitions
  const fields = UserType.getFields();
  console.log(Object.keys(fields)); // ['id', 'name', 'email', ...]
  
  // Check specific field
  const nameField = fields.name;
  console.log(nameField.type); // GraphQLString
}

// Get type by GraphQL type object
const BookType = getType(SomeBookType);

// Safe access - returns null if not found
const nonExistentType = getType('NonExistent');
console.log(nonExistentType); // null
```

**Use Cases:**
- **Type introspection**: Examine type definitions programmatically
- **Dynamic schema analysis**: Build tools that analyze your GraphQL schema
- **Runtime type checking**: Validate types exist before operations
- **Admin interfaces**: Build dynamic forms based on type definitions
- **Circular reference resolution**: Prevent import cycles when types reference each other

### Preventing Circular References with `getType`

When you have types that reference each other (like User and Group), using `getType` prevents circular import issues:

```javascript
import { GraphQLObjectType, GraphQLID, GraphQLString, GraphQLList } from 'graphql';
import { getType } from '@simtlix/simfinity-js';

// User type that references Group
const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    email: { type: GraphQLString },
    
    // Reference Group type by name to avoid circular imports
    groups: {
      type: new GraphQLList(() => getType('Group')), // Use getType instead of direct import
      extensions: {
        relation: {
          connectionField: 'members',
          displayField: 'name'
        }
      }
    },
    
    // Single group reference
    primaryGroup: {
      type: () => getType('Group'), // Lazy evaluation with getType
      extensions: {
        relation: {
          connectionField: 'primaryGroupId',
          displayField: 'name'
        }
      }
    }
  })
});

// Group type that references User
const GroupType = new GraphQLObjectType({
  name: 'Group',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    
    // Reference User type by name to avoid circular imports
    members: {
      type: new GraphQLList(() => getType('User')), // Use getType instead of direct import
      extensions: {
        relation: {
          connectionField: 'groups',
          displayField: 'name'
        }
      }
    },
    
    // Single user reference (admin)
    admin: {
      type: () => getType('User'), // Lazy evaluation with getType
      extensions: {
        relation: {
          connectionField: 'adminId',
          displayField: 'name'
        }
      }
    }
  })
});

// Register types with simfinity
simfinity.connect(null, UserType, 'user', 'users');
simfinity.connect(null, GroupType, 'group', 'groups');

// Create schema - resolvers will be auto-generated for all relationships
const schema = simfinity.createSchema();
```

**Benefits of this approach:**

1. **🔄 No Circular Imports**: Each file can import `getType` without importing other type definitions
2. **⚡ Lazy Resolution**: Types are resolved at schema creation time when all types are registered
3. **🛡️ Type Safety**: Still maintains GraphQL type checking and validation
4. **🧹 Clean Architecture**: Separates type definitions from type relationships
5. **📦 Better Modularity**: Each type can be in its own file without import dependencies

**File Structure Example:**

```
types/
├── User.js          // Defines UserType using getType('Group')
├── Group.js         // Defines GroupType using getType('User')
└── index.js         // Registers all types and creates schema
```

```javascript
// types/User.js
import { GraphQLObjectType, GraphQLID, GraphQLString, GraphQLList } from 'graphql';
import { getType } from '@simtlix/simfinity-js';

export const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    groups: {
      type: new GraphQLList(() => getType('Group')),
      extensions: { relation: { connectionField: 'members' } }
    }
  })
});

// types/Group.js  
import { GraphQLObjectType, GraphQLID, GraphQLString, GraphQLList } from 'graphql';
import { getType } from '@simtlix/simfinity-js';

export const GroupType = new GraphQLObjectType({
  name: 'Group', 
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    members: {
      type: new GraphQLList(() => getType('User')),
      extensions: { relation: { connectionField: 'groups' } }
    }
  })
});

// types/index.js
import { UserType } from './User.js';
import { GroupType } from './Group.js';
import simfinity from '@simtlix/simfinity-js';

// Register all types
simfinity.connect(null, UserType, 'user', 'users');
simfinity.connect(null, GroupType, 'group', 'groups');

// Create schema with auto-generated resolvers
export const schema = simfinity.createSchema();
```

### `getModel(gqltype)`

Retrieves the Mongoose model associated with a GraphQL type.

**Parameters:**
- `gqltype` (GraphQLObjectType): The GraphQL type object

**Returns:**
- `MongooseModel`: The associated Mongoose model

**Example:**

```javascript
const BookModel = simfinity.getModel(BookType);
const books = await BookModel.find({ author: 'Douglas Adams' });
```

### `getInputType(type)`

Retrieves the input type for mutations associated with a GraphQL type.

**Parameters:**
- `type` (GraphQLObjectType): The GraphQL type object

**Returns:**
- `GraphQLInputObjectType`: The input type for mutations

**Example:**

```javascript
const BookInput = simfinity.getInputType(BookType);
console.log(BookInput.getFields()); // Input fields for mutations
```

### `saveObject(typeName, args, session?, context?)`

Programmatically save an object outside of GraphQL mutations.

**Parameters:**
- `typeName` (string): The name of the GraphQL type
- `args` (object): The data to save
- `session` (MongooseSession, optional): Database session for transactions
- `context` (object, optional): GraphQL context object (includes request info, user data, etc.)

**Returns:**
- `Promise<object>`: The saved object

**Example:**

```javascript
const newBook = await simfinity.saveObject('Book', {
  title: 'New Book',
  author: 'Author Name'
}, session, context);

// Without context (context will be undefined in controller hooks)
const newBook = await simfinity.saveObject('Book', {
  title: 'New Book',
  author: 'Author Name'
}, session);
```

**Note**: When `context` is not provided, it will be `undefined` in controller hooks. This is acceptable for programmatic usage where context may not be available.

### `createSchema(includedQueryTypes?, includedMutationTypes?, includedCustomMutations?)`

Creates the final GraphQL schema with all connected types.

**Parameters:**
- `includedQueryTypes` (array, optional): Limit query types to include
- `includedMutationTypes` (array, optional): Limit mutation types to include  
- `includedCustomMutations` (array, optional): Limit custom mutations to include

**Returns:**
- `GraphQLSchema`: The complete GraphQL schema

**Example:**

```javascript
const schema = simfinity.createSchema();
```

*Built with ❤️ by [Simtlix](https://github.com/simtlix)*


