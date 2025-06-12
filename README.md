# Simfinity.js

Simfinity.js is a powerful library that automatically generates a GraphQL schema from your Mongoose models. It simplifies the process of creating a GraphQL API for your Node.js application by providing a set of conventions and helpers to handle common CRUD operations, filtering, pagination, and sorting.

## Installation

To use Simfinity.js in your project, you'll need to have `mongoose` and `graphql` installed as peer dependencies.

```bash
npm install mongoose graphql @simtlix/simfinity-js
```

## Core Concepts

The core of Simfinity.js revolves around two main concepts: connecting your Mongoose models to GraphQL types and creating a schema.

### Connecting Models

The `simfinity.connect()` method is used to link a Mongoose model to a GraphQLObjectType. This tells Simfinity how to handle the data for that type.

```javascript
const mongoose = require('mongoose');
const { GraphQLObjectType, GraphQLString, GraphQLNonNull } = require('graphql');
const simfinity = require('@simtlix/simfinity-js');

// 1. Define your GraphQL Type
const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

// 2. Connect the type to Simfinity
simfinity.connect(null, BookType, 'book', 'books');
```

### Creating a Schema

Once you've connected your types, you can generate a GraphQL schema using `simfinity.createSchema()`. This will automatically create the queries and mutations for your connected types.

```javascript
const schema = simfinity.createSchema();
```

---

# About SimfinityJS
SimfinityJS is a Node.js framework that allows bringing all the power and flexibility of MongoDB query language to GraphQL interfaces. 

In pure GraphQL, you have to define every query and mutation. With SimfinityJS you define the object model, and the framework itself interprets all queries and mutations. SimfinityJS acts as a glue. It translates GraphQL to MongoDB and viceversa. 

As a result, developers can focus on model structure and object relationships. 

## Features
- Translation between GraphQL and MongoDB and viceversa
- Implement business logic in a declarative way
- Implement domain validations in a declarative way. 
- Supports declarative state machine. Business logic can be included in each state transition. 
- Powerful semantic API. Basically, any query that can be executed in mongocli can be executed in GraphQL, thanks to SimfinityJS.



# Quick Start
## Install
```bash
npm install @simtlix/simfinity-js --save
```

## Adding Simfinity to your application

```javascript
const express = require('express')
const graphqlHTTP = require('express-graphql')
const simfinity = require('@simtlix/simfinity-js')
const app = express()
const mongoose = require('mongoose')

//Replace with your Mongo DB connection string
mongoose.connect('mongodb://localhost:27017,localhost:27018,localhost:27019/example2', { replicaSet: 'rs', useNewUrlParser: true, useUnifiedTopology: true })

mongoose.connection.once('open', () => {
  console.log('connected to database')
})

mongoose.set('debug', true);

const type = require('./types')
const includedTypes = [type.Book]

const schema = simfinity.createSchema(includedTypes)

app.use('/graphql', graphqlHTTP({
  // Directing express-graphql to use this schema to map out the graph
  schema,
  /* Directing express-graphql to use graphiql when goto '/graphql' address in the browser
  which provides an interface to make GraphQl queries */
  graphiql: true,
  formatError: simfinity.buildErrorFormatter((err) => {
    console.log(err)
  })

}))

app.listen(3000, () => {
  console.log('Listening on port 3000')
})
```


### Defining the model

```javascript
const graphql = require('graphql')
const simfinity = require('@simtlix/simfinity-js')

const {
  GraphQLObjectType,GraphQLString,
  GraphQLID, GraphQLInt
} = graphql


const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: () => ({
    id: {
      type: GraphQLID
    },
    name: { type: GraphQLString },
    pages: { type: GraphQLInt }
  })
})

module.exports = BookType

simfinity.connect(null, BookType, 'book', 'books', null, null, null)
```


# Run 
Start replica set

`run-rs`

Run the application

`node app.js`



# Try it

Open http://localhost:3000/graphql endpoint defined on app.js


Create a book
```graphql
mutation {
  addbook (	
    input:{
      name: "Hello World Book",
      pages: 333
    }
  ) 
}
```


List all books
```graphql
query {
  books {
    id, name, pages
  }
}
```


# Want to know more! 
Visit the [samples site](https://github.com/simtlix/simfinity.js-samples) and learn about SimfinityJS through different use cases



## Bookstore Example

Let's explore how to use Simfinity.js with a simple bookstore example. We'll have two main types: `Author` and `Book`.

### 1. Define Your GraphQL Types

First, we'll define the `GraphQLObjectType` for our `Author` and `Book` models. Notice the `extensions` field on the `author` field of the `BookType`. This is how you define relationships in Simfinity.

```javascript
const {
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLID,
  GraphQLList,
} = require('graphql');

const AuthorType = new GraphQLObjectType({
  name: 'Author',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    books: {
      type: new GraphQLList(BookType),
      extensions: {
        relation: {
          connectionField: 'authorId',
        },
      },
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
          connectionField: 'authorId',
        },
      },
    },
  }),
});
```

### Advanced Relationship Definition

For more control over your relationships, you can provide additional options in the `extensions.relation` object and add a custom `resolve` function.

*   `connectionField`: (Required) The name of the field on the current model that stores the ID of the related object (e.g., `authorId` on the `Book` model).
*   `displayField`: (Optional) The name of the field on the related object that should be used as its display value. This can be useful for auto-generated UI components.
*   `resolve`: (Optional) A custom resolver function to fetch the related data. This gives you full control over how the relationship is resolved. If not provided, Simfinity.js will handle it automatically based on the `connectionField`.

Here's an example of an `Episode` type with a relationship to a `Season` type, using these advanced options. This demonstrates how to define which field to display from the related object and how to write a custom resolver.

```javascript
const { GraphQLID, GraphQLObjectType, GraphQLString, GraphQLInt } = require('graphql');
const GraphQLDateTime = require('graphql-iso-date').GraphQLDateTime;
const simfinity = require('@simtlix/simfinity-js');
const seasonType = require('./season'); // Assuming seasonType is defined elsewhere

const episodeType = new GraphQLObjectType({
  name: 'episode',
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: GraphQLInt },
    name: { type: GraphQLString },
    date: { type: GraphQLDateTime },
    season: {
      type: seasonType,
      extensions: {
        relation: {
          connectionField: 'seasonID',
          displayField: 'number'
        }
      },
      resolve(parent) {
        // Use simfinity.getModel() to get the Mongoose model for a GraphQL type
        return simfinity.getModel(seasonType).findById(parent.seasonID);
      }
    },
  })
});
```

In this example:
- The `season` field on `episodeType` is linked to `seasonType`.
- `connectionField: 'seasonID'` tells Simfinity that the `seasonID` field in the episode document holds the ID of the related season.
- `displayField: 'number'` suggests that the `number` field of a season (e.g., season 1, season 2) should be used to represent it.
- The `resolve` function manually fetches the season document using its ID from the parent episode. This is useful for custom logic, but often not necessary, as Simfinity can resolve it automatically.

### 2. Connect Your Types

Next, we'll connect these types to Simfinity. This will automatically generate the Mongoose models and the necessary queries and mutations.

```javascript
const simfinity = require('@simtlix/simfinity-js');

simfinity.connect(null, AuthorType, 'author', 'authors');
simfinity.connect(null, BookType, 'book', 'books');
```

### 3. Create the Server

Finally, we'll create a simple Express server with `express-graphql` to serve our schema.

```javascript
const express = require('express');
const { graphqlHTTP } = require('express-graphql');
const mongoose = require('mongoose');
const simfinity = require('@simtlix/simfinity-js');

// ... (AuthorType and BookType definitions)

// Connect to MongoDB
mongoose.connect('mongodb://localhost/bookstore', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const app = express();

app.use('/graphql', graphqlHTTP({
  schema: simfinity.createSchema(),
  graphiql: true,
}));

app.listen(4000, () => {
  console.log('Server is running on port 4000');
});
```

## Creating Complex Objects

Simfinity.js makes it easy to create and connect objects in a single mutation. When you define a relationship, the input type for the parent object will automatically include a field for the child's ID.

For our bookstore example, the `addBook` mutation will accept an `author` field, which is an object containing the `id` of the author.

### Creating a Book for an Existing Author

To create a new book and link it to an author that already exists, you can use the `addBook` mutation and provide the author's ID.

```graphql
mutation {
  addBook(input: {
    title: "The Hitchhiker's Guide to the Galaxy",
    author: {
      id: "author_id_here"
    }
  }) {
    id
    title
    author {
      id
      name
    }
  }
}
```

This will create a new book and set its `authorId` field to the provided author ID.

---

## Querying Data

Simfinity.js provides a rich set of querying capabilities that are automatically added to your schema. You can filter, paginate, and sort your data with ease.

### Basic Queries

To get a list of all books, you can use the `books` query:

```graphql
query {
  books {
    id
    title
  }
}
```

To get a single book by its ID, you can use the `book` query:

```graphql
query {
  book(id: "book_id_here") {
    id
    title
    author {
      id
      name
    }
  }
}
```

### Filtering

You can filter your queries using the `filter` argument. The filter object takes an `operator` and a `value`.

#### Simple Equality Filter

To find all books with a specific title:

```graphql
query {
  books(title: {
    operator: EQ,
    value: "The Hitchhiker's Guide to the Galaxy"
  }) {
    id
    title
  }
}
```

#### Using Other Operators

Simfinity.js supports a variety of operators: `EQ`, `NE`, `GT`, `GTE`, `LT`, `LTE`, `LIKE`, `IN`, `NIN`, and `BTW`.

To find all books with "Guide" in the title:

```graphql
query {
  books(title: {
    operator: LIKE,
    value: "Guide"
  }) {
    id
    title
  }
}
```

### Filtering on Nested Objects

You can also filter based on the fields of a related object. To do this, you provide a `terms` array to the filter argument, where each term specifies a `path` to the nested field.

To find all books by a specific author:

```graphql
query {
  books(author: {
    terms: [
      {
        path: "name",
        operator: EQ,
        value: "Douglas Adams"
      }
    ]
  }) {
    id
    title
    author {
      name
    }
  }
}
```

You can also use a deeper path to filter on nested relations. For example, if our `Author` type had a `country` relation, we could find all books by authors from a specific country:

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

### Pagination

To paginate your results, you can use the `pagination` argument. You can also get a `count` of the total number of documents that match the query.

```graphql
query {
  books(pagination: {
    page: 1,
    size: 10,
    count: true
  }) {
    id
    title
  }
}
```

### Sorting

To sort your results, you can use the `sort` argument.

```graphql
query {
  books(sort: {
    terms: [
      {
        field: "title",
        order: ASC
      }
    ]
  }) {
    id
    title
  }
}
```

## Mutations

Simfinity.js automatically generates `add`, `update`, and `delete` mutations for each type you connect.

### Add Mutation

To create a new author:

```graphql
mutation {
  addAuthor(input: {
    name: "J.R.R. Tolkien"
  }) {
    id
    name
  }
}
```

### Update Mutation

To update an existing author's name:

```graphql
mutation {
  updateAuthor(input: {
    id: "author_id_here",
    name: "John Ronald Reuel Tolkien"
  }) {
    id
    name
  }
}
```

### Delete Mutation

To delete an author:

```graphql
mutation {
  deleteAuthor(id: "author_id_here") {
    id
  }
}
```

## Lifecycle Hooks with Controllers

For more granular control over the automatically generated mutations (`add`, `update`, `delete`), you can provide a controller object to Simfinity.js. This controller can contain methods that are executed as lifecycle hooks during these operations, allowing you to run validation, perform modifications, or trigger side effects.

The controller is passed as the fifth argument to the `simfinity.connect()` method.

### Controller Methods

*   `onCreating({ doc })`: Executed just before a new document is created. You can modify the `doc` or throw an error to prevent creation.
*   `onUpdating({ doc, originalDoc })`: Executed before a document is updated. It receives the new `doc` with the pending changes and the `originalDoc` as it exists in the database.
*   `onDeleting({ doc })`: Executed before a document is deleted. It receives the document that is about to be removed.

### Example

Here's how you can define a controller for our `Book` type to add custom validation and logging:

```javascript
const bookController = {
  onCreating: async ({ doc }) => {
    // Validate that a book has a title before saving.
    if (!doc.title || doc.title.trim().length === 0) {
      throw new Error('Book title cannot be empty.');
    }
    console.log(`A new book titled "${doc.title}" is being created.`);
    // You can also modify the document before it's saved, e.g., to add a timestamp.
  },

  onUpdating: async ({ doc, originalDoc }) => {
    // Log the update operation.
    console.log(`The book "${originalDoc.title}" is being updated.`);
    // 'doc' contains the new values, while 'originalDoc' has the old ones.
  },

  onDeleting: async ({ doc }) => {
    // Perform a final check or logging before deletion.
    console.log(`The book "${doc.title}" is being deleted.`);
    // This is a good place to perform related cleanup operations.
  }
};

// Connect the BookType with its controller
simfinity.connect(
  null,          // mongooseModel
  BookType,      // graphQLType
  'book',        // singularName
  'books',       // pluralName
  bookController // controller
);
```

When you now use the `addBook`, `updateBook`, or `deleteBook` mutations, the corresponding controller methods will be executed. For example, trying to create a book with an empty title would now fail with the custom error message.

## State Machines

Simfinity.js has built-in support for state machines, allowing you to manage the lifecycle of your objects in a declarative way. You can define states and actions that transition an object from one state to another. For each action, you can also specify business logic that gets executed during the transition.

### Defining a State Machine

Let's look at an example of a `Season` type that has a lifecycle managed by a state machine. The process involves four main steps:

1.  **Define States**: Create a `GraphQLEnumType` to represent the possible states.
2.  **Define Type**: Create the `GraphQLObjectType` that will have a state field.
3.  **Configure State Machine**: Define an object with the `initialState` and the `actions` that govern transitions.
4.  **Connect**: Use `simfinity.connect()` to link the type with its state machine.

Here is the complete example:

```javascript
const graphql = require('graphql');
const simfinity = require('@simtlix/simfinity-js');

const { GraphQLObjectType, GraphQLID, GraphQLInt, GraphQLEnumType } = graphql;

// 1. Define the states using a GraphQLEnumType
const seasonState = new GraphQLEnumType({
  name: 'seasonState',
  values: {
    SCHEDULED: { value: 'SCHEDULED' },
    ACTIVE: { value: 'ACTIVE' },
    FINISHED: { value: 'FINISHED' }
  }
});

// 2. Define the GraphQLObjectType
const seasonType = new GraphQLObjectType({
  name: 'season',
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: GraphQLInt },
    year: { type: GraphQLInt },
    state: { type: seasonState }
  })
});

// 3. Define the state machine configuration
const stateMachine = {
  initialState: 'SCHEDULED', // The value of the initial state
  actions: {
    activate: {
      from: 'SCHEDULED',
      to: 'ACTIVE',
      action: async ({ doc }) => {
        // Business logic to run on activation
        // The 'doc' parameter contains the document being transitioned
        console.log(`Activating season ${doc._id} of year ${doc.year}`);
      }
    },
    finalize: {
      from: 'ACTIVE',
      to: 'FINISHED',
      action: async ({ doc }) => {
        // Business logic to run on finalization
        console.log(`Finalizing season ${doc._id} of year ${doc.year}`);
      }
    }
  }
};

// 4. Connect the type and its state machine to Simfinity
simfinity.connect(
  null,
  seasonType,
  'season',
  'seasons',
  null,
  null,
  stateMachine
);
```

When a new `season` is created, its `state` field will automatically be set to `SCHEDULED`.

### Triggering State Transitions

When you connect a type with a state machine, Simfinity.js automatically creates a GraphQL mutation for each action. The mutation name is a combination of the action name and the type name (e.g., `actionName` + `TypeName`).

For our `season` example, Simfinity.js will generate `activateSeason` and `finalizeSeason` mutations.

To activate a season, you would call the `activateSeason` mutation with the ID of the season:

```graphql
mutation {
  activateSeason(id: "season_id_here") {
    id
    state
  }
}
```

This will change the season's state from `SCHEDULED` to `ACTIVE` and execute the `action` function defined for the `activate` transition.


