

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
const {graphqlHTTP} = require('express-graphql')
const simfinity = require('@simtlix/simfinity-js')
const app = express()
const mongoose = require('mongoose')

mongoose.connect('mongodb://localhost:27017/example') // replace with your mongodb connection string

mongoose.connection.once('open', () => {
  console.log('connected to database')
})

/* This route will be used as an endpoint to interact with Graphql,
All queries will go through this route. */
const example = require('./types/example')
const schema = simfinity.createSchema([example])

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


### Define your model

|  Example table |          |   
| ------------- |:-------------:|
| name          | String! 	    |
| description   | String        |
| amount        | Number        |
| flag          | Boolean       |


### Define your Graphql types 

```javascript
const graphql = require('graphql')
const simfinity = require('@simtlix/simfinity-js')

const {GraphQLObjectType, GraphQLString, GraphQLID, GraphQLInt, GraphQLBoolean, GraphQLNonNull} = graphql

const ExampleType = new GraphQLObjectType({
  name: 'Example',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    amount : { type : GraphQLInt },
    flag : { type : GraphQLBoolean },
  })
})

simfinity.connect(null, ExampleType, 'example', 'examples')
module.exports = ExampleType
```

## Register models and types using [connect()](#connect-function) function for **non embedded** types and `addNoEndpointType` function for **embedded** ones
## Create the GraphQL schema using `createSchema` function


# Test
On this project root directory
`npm link`

On the test project root directory
`npm link @simtlix/simfinity-js`

Run test project with *preserve-symlinks* flag. E.g.:
`node --preserve-symlinks app.js`






# Example queries

Open http://localhost:3000/graphql endpoint defined on app.js


Create a document
```graphql
mutation{
  addexample(
    input:{
      name: "Bar"
      description: "lorem ipsum"
      amount: 1
      flag : true
  }) {
    # fields you want to recover
    id
    name
    amount
    description
    flag
  }
}
```

Update a document
```graphql
mutation{
  updateexample(
    input:{
      id: "5f5d0c713464882aec659ab2" # put your mongo id
      description: "updated lorem ipsum" 
  }) {
    # fields you want recover
    id
    description
  }
}
```

Find a document
```graphql
query{
  example(id:"5f5d0c713464882aec659ab2") # put your mongo id
  {
    # fields you want to recover
    id
    name
  }
}
```

Find all 'example' documents
```graphql
query{
  examples{
    # fields you want to recover
    id
    name
    description
    amount
    flag
  }
}
````

Delete a document
```graphql
mutation{
  deleteexample(id:"5f5d0c713464882aec659ab2")
  {
    id
    name
    description
  }
}
```




