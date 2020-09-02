Extensión para editar MARK DOWN
https://chrome.google.com/webstore/detail/markdown-viewer/ckkdlimhmcjmikdlpkmbgfkaikojcbjk?hl=es


Referencias :
https://github.com/koush/electron-chrome
https://github.com/graphql/graphql-js



[![npm version](https://badge.fury.io/js/%40simtlix%2Fsimfinity-js.svg)](https://badge.fury.io/js/%40simtlix%2Fsimfinity-js)

# About Simfinity-js
It´s a complete framework that helps the developers to think only on the strucures,
models and relations between them in order to resolve an specific problem.

Following technologies are used in this solution
    * NodeJs
	* GraphQL
    * MongoDb

Simfinityjs provides a powerful semantic for querying and modifying a complex object model

##### *** TODO : un conciso video sería mas representativo para mostrar como funciona graphql ***

# How to
## Install
```bash
npm install @simtlix/simfinity-js --save
```

## Dependencies required ( todo : ask about this )
* express	4.17.1
* express-graphql	0.7.1
* graphql	14.5.8
* mongoose	5.9.28


## To use this lib:
* [Import simfinity-js](#Import-simfinity)
* [Define your mongoose models](#define-your-mongoose-models)
* [Define your GraphQL types](#define-your-graphql-types)
*  Register models and types using [connect()](#connect-function) function for **non embedded** types and `addNoEndpointType` function for **embedded** ones
* Create the GraphQL schema using `createSchema` function

# Table of contents 
  ## TODO: Relations examples


  ## TODO : do a tree example
  ## TODO : explain connect()
  ## TODO : explain saveObject()
  ## TODO : explain addNoEndpointType()
  ## TODO : explain connect()
  ## TODO : explain buildErrorFormatter()
  ## TODO : explain validations
  ## TODO : explain state machine

## Test
On this project root directory
`npm link`

On the test project root directory
`npm link @simtlix/simfinity-js`

Run test project with *preserve-symlinks* flag. E.g.:
`node --preserve-symlinks app.js`

# Example
There is a sample of an app using this lib at [simfinity-sample](https://github.com/simtlix/simfinity-sample)

# Import Simfinity

Here we have a node mongoose application

```const express = require('express')
const {graphqlHTTP} = require('express-graphql')
const app = express()
const mongoose = require('mongoose')

mongoose.connect('mongodb://localhost:27017/example') // put your mongodb connection string

mongoose.connection.once('open', () => {
  console.log('connected to database')
})



app.listen(3000, () => {
  console.log('Listening on port 3000')
})
```



You can add simfinity like this
```javascript
const express = require('express')
const {graphqlHTTP} = require('express-graphql')
const simfinity = require('@simtlix/simfinity-js')
const app = express()
const mongoose = require('mongoose')

mongoose.connect('mongodb://localhost:27017/example') // put your mongodb connection string

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

# TODO : Add more types
# TODO : 
### Define your mongoose model

|  Example table |          |   
| ------------- |:-------------:|
| name          | String! 	    |
| description   | String        |
| amount        | Number        |
| date	        | Date          |
| flag          | Boolean       |
| names         | [String]      |

```javascript
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const exampleSchema = new Schema({
  name: String,
  description: String,
  date : Date,
  flag : Boolean,
  names : [String]
})

const Example = mongoose.model('Example', exampleSchema, 'example')
Example.createCollection()

module.exports = Example
```

### Define your Graphql types 

```javascript
const graphql = require('graphql')
const simfinity = require('@simtlix/simfinity-js')
const Example = require('../models/example')

const {GraphQLObjectType, GraphQLString, GraphQLID, GraphQLDateTime, GraphQLBoolean} = graphql

const ExampleType = new GraphQLObjectType({
  name: 'Example',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    date : { type : GraphQLDateTime },
    flag : { type : GraphQLBoolean },
    names: { type : GraphQLList },
  })
})

simfinity.connect(Example, ExampleType, 'example', 'examples')
module.exports = ExampleType
```

### connect function

Connect function is used to add our definition to simfinity run

