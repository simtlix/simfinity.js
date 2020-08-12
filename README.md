[![npm version](https://badge.fury.io/js/%40simtlix%2Fsimfinity-js.svg)](https://badge.fury.io/js/%40simtlix%2Fsimfinity-js)

# How to
## Install
```bash
npm install @simtlix/simfinity-js --save
```

To use this lib:
* Define your mongoose models
* Define your GraphQL types
* Register models and types using `connect` function for **non embedded** types and `addNoEndpointType` function for **embedded** ones
* Create the GraphQL schema using `createSchema` function

## Test
On this project root directory
`npm link`

On the test project root directory
`npm link @simtlix/simfinity-js`

Run test project with *preserve-symlinks* flag. E.g.:
`node --preserve-symlinks app.js`

# Example
There is a sample of an app using this lib at [simfinity-sample](https://github.com/simtlix/simfinity-sample)
