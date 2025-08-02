# Automatic ObjectId Index Creation

This feature automatically creates MongoDB indexes for all ObjectId fields when models are generated, including nested embedded objects.

## How it works

When you define GraphQL types with ObjectId fields (GraphQLID), the system will automatically:

1. Analyze the schema definition to find all ObjectId fields
2. Create indexes for each ObjectId field found
3. Handle nested embedded objects recursively
4. Create indexes for arrays of embedded objects
5. Create indexes for relationship fields (foreign keys between types)

## Examples

### Simple ObjectId fields

```javascript
import { GraphQLObjectType, GraphQLString, GraphQLID } from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    email: { type: GraphQLString },
    managerId: { type: GraphQLID }, // This will get an index
  }),
});

simfinity.connect(null, UserType, 'user', 'users');
simfinity.createSchema();
```

This will create indexes for:
- `id` field
- `managerId` field

### Relationship fields (non-embedded)

```javascript
const DepartmentType = new GraphQLObjectType({
  name: 'Department',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
  }),
});

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    email: { type: GraphQLString },
    department: { 
      type: DepartmentType,
      extensions: {
        relation: { embedded: false } // or omit this line (default is false)
      }
    },
  }),
});

// Register both types
simfinity.connect(null, DepartmentType, 'department', 'departments');
simfinity.connect(null, UserType, 'user', 'users');
simfinity.createSchema();
```

This will create indexes for:
- `id` field (in both User and Department)
- `department` field (the foreign key field that references Department)

### One-to-Many relationships

```javascript
const OrderType = new GraphQLObjectType({
  name: 'Order',
  fields: () => ({
    id: { type: GraphQLID },
    orderNumber: { type: GraphQLString },
    customerId: { type: GraphQLID }, // This will get an index
    items: { 
      type: new GraphQLList(OrderItemType),
      extensions: {
        relation: { embedded: false }
      }
    },
  }),
});

const OrderItemType = new GraphQLObjectType({
  name: 'OrderItem',
  fields: () => ({
    id: { type: GraphQLID },
    productId: { type: GraphQLID }, // This will get an index
    quantity: { type: GraphQLString },
    orderId: { type: GraphQLID }, // This will get an index (foreign key)
  }),
});

// Register both types
simfinity.connect(null, OrderItemType, 'orderItem', 'orderItems');
simfinity.connect(null, OrderType, 'order', 'orders');
simfinity.createSchema();
```

This will create indexes for:
- `id` field (in both Order and OrderItem)
- `customerId` field (in Order)
- `productId` field (in OrderItem)
- `orderId` field (in OrderItem - the foreign key that references Order)

### Embedded objects with ObjectId

```javascript
const AddressType = new GraphQLObjectType({
  name: 'Address',
  fields: () => ({
    street: { type: GraphQLString },
    city: { type: GraphQLString },
    countryId: { type: GraphQLID }, // This will get an index
  }),
});

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    address: { 
      type: AddressType,
      extensions: {
        relation: { embedded: true }
      }
    },
  }),
});

// Register the embedded type
simfinity.addNoEndpointType(AddressType);
simfinity.connect(null, UserType, 'user', 'users');
simfinity.createSchema();
```

This will create indexes for:
- `id` field
- `countryId` field (from AddressType)
- `address.countryId` field (embedded path)

### Nested embedded objects

```javascript
const CityType = new GraphQLObjectType({
  name: 'City',
  fields: () => ({
    name: { type: GraphQLString },
    stateId: { type: GraphQLID }, // This will get an index
  }),
});

const AddressType = new GraphQLObjectType({
  name: 'Address',
  fields: () => ({
    street: { type: GraphQLString },
    city: { 
      type: CityType,
      extensions: {
        relation: { embedded: true }
      }
    },
  }),
});

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    address: { 
      type: AddressType,
      extensions: {
        relation: { embedded: true }
      }
    },
  }),
});

// Register the embedded types
simfinity.addNoEndpointType(CityType);
simfinity.addNoEndpointType(AddressType);
simfinity.connect(null, UserType, 'user', 'users');
simfinity.createSchema();
```

This will create indexes for:
- `id` field
- `stateId` field (from CityType)
- `city.stateId` field (from AddressType)
- `address.city.stateId` field (nested embedded path)

### Arrays of embedded objects

```javascript
const OrderItemType = new GraphQLObjectType({
  name: 'OrderItem',
  fields: () => ({
    productId: { type: GraphQLID }, // This will get an index
    quantity: { type: GraphQLString },
  }),
});

const OrderType = new GraphQLObjectType({
  name: 'Order',
  fields: () => ({
    id: { type: GraphQLID },
    customerId: { type: GraphQLID },
    items: { 
      type: new GraphQLList(OrderItemType),
      extensions: {
        relation: { embedded: true }
      }
    },
  }),
});

// Register the embedded type
simfinity.addNoEndpointType(OrderItemType);
simfinity.connect(null, OrderType, 'order', 'orders');
simfinity.createSchema();
```

This will create indexes for:
- `id` field
- `customerId` field
- `productId` field (from OrderItemType)
- `items.productId` field (array embedded path)

## Benefits

1. **Automatic Performance Optimization**: ObjectId fields are automatically indexed for better query performance
2. **Relationship Optimization**: Foreign key fields are automatically indexed for efficient joins and lookups
3. **No Manual Configuration**: No need to manually specify which fields should be indexed
4. **Handles Complex Schemas**: Works with nested embedded objects and arrays
5. **Consistent**: All ObjectId fields get the same treatment regardless of their location in the schema

## Technical Details

The system uses the `mongoose.Schema` constructor to create schemas and then calls `schema.index()` for each ObjectId field found. The index creation happens during model generation, so it's transparent to the application code. 