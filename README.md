

[![npm version](https://badge.fury.io/js/%40simtlix%2Fsimfinity-js.svg)](https://badge.fury.io/js/%40simtlix%2Fsimfinity-js)

# About SimfinityJS
SimfinityJS is a Node.js framework that allows bringing all the power and flexibility of MongoDB query language to GrapQL interfaces. 

In pure GraphQL, you have to define every query and mutation. With SimfinityJS you define the object model, and the framework itself interprets all queries and mutations. SimfinityJS acts as a glue. It translates GraphQL to MongoDB and viceversa. 

As a result, developers can focus on model structure and object relationships. 

## Features
- Translation between GrapQL and MongoDB and viceversa
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


