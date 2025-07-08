# Simfinity.js

A powerful Node.js framework that automatically generates GraphQL schemas from your data models, bringing all the power and flexibility of MongoDB query language to GraphQL interfaces.

## ✨ Features

- **Automatic Schema Generation**: Define your object model, and Simfinity.js generates all queries and mutations
- **MongoDB Integration**: Seamless translation between GraphQL and MongoDB
- **Powerful Querying**: Any query that can be executed in MongoDB can be executed in GraphQL
- **Auto-Generated Resolvers**: Automatically generates resolve methods for relationship fields
- **Business Logic**: Implement business logic and domain validations declaratively
- **State Machines**: Built-in support for declarative state machine workflows
- **Lifecycle Hooks**: Controller methods for granular control over operations
- **Custom Validation**: Field-level and type-level custom validations
- **Relationship Management**: Support for embedded and referenced relationships

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

// Add middleware for all operations
simfinity.use((params, next) => {
  // params contains: type, args, operation, context
  console.log(`Executing ${params.operation} on ${params.type.name}`);
  next();
});
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

## 🎛️ Controllers & Lifecycle Hooks

Controllers provide fine-grained control over operations with lifecycle hooks:

```javascript
const bookController = {
  onSaving: async (doc, args, session) => {
    // Before saving - doc is a Mongoose document
    if (!doc.title || doc.title.trim().length === 0) {
      throw new Error('Book title cannot be empty');
    }
    console.log(`Creating book: ${doc.title}`);
  },

  onSaved: async (doc, args, session) => {
    // After saving - doc is a plain object
    console.log(`Book saved: ${doc._id}`);
  },

  onUpdating: async (id, doc, session) => {
    // Before updating - doc contains only changed fields
    console.log(`Updating book ${id}`);
  },

  onUpdated: async (doc, session) => {
    // After updating - doc is the updated document
    console.log(`Book updated: ${doc.title}`);
  },

  onDelete: async (doc, session) => {
    // Before deleting - doc is the document to be deleted
    console.log(`Deleting book: ${doc.title}`);
  }
};

// Connect with controller
simfinity.connect(null, BookType, 'book', 'books', bookController);
```

### Hook Parameters

**`onSaving(doc, args, session)`**:
- `doc`: Mongoose Document instance (not yet saved)
- `args`: Raw GraphQL mutation input
- `session`: Mongoose session for transaction

**`onSaved(doc, args, session)`**:
- `doc`: Plain object of saved document
- `args`: Raw GraphQL mutation input
- `session`: Mongoose session for transaction

**`onUpdating(id, doc, session)`**:
- `id`: Document ID being updated
- `doc`: Plain object with only changed fields
- `session`: Mongoose session for transaction

**`onUpdated(doc, session)`**:
- `doc`: Full updated Mongoose document
- `session`: Mongoose session for transaction

**`onDelete(doc, session)`**:
- `doc`: Plain object of document to be deleted
- `session`: Mongoose session for transaction

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

## ✅ Validations

### Field-Level Validations

Add validation logic directly to fields:

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

Create custom scalar types with built-in validation:

```javascript
const { GraphQLString, GraphQLInt } = require('graphql');
const { createValidatedScalar } = require('@simtlix/simfinity-js');

// Email scalar with validation
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

// Positive integer scalar
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
    email: { type: EmailScalar },
    age: { type: PositiveIntScalar },
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

Include types in the schema without generating endpoints:

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

// Get the input type for a GraphQL type
const BookInput = simfinity.getInputType(BookType);
```

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

- **[Samples Repository](https://github.com/simtlix/simfinity.js-samples)** - Complete examples and use cases
- **[MongoDB Query Language](https://docs.mongodb.com/manual/tutorial/query-documents/)** - Learn about MongoDB querying
- **[GraphQL Documentation](https://graphql.org/learn/)** - Learn about GraphQL

## 📄 License

Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

*Built with ❤️ by [Simtlix](https://github.com/simtlix)*


