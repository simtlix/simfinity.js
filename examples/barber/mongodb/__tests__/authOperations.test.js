import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate, specifiedRules } from 'graphql';
import { SingleAuthOperationRule, AUTH_OPERATIONS, useSingleAuthOperation } from '../auth/authOperations.js';

const schema = buildSchema(`
  type Payload { accessToken: String }
  input In { email: String password: String refreshToken: String name: String }
  type Query { ping: String }
  type Mutation {
    login(input: In): Payload
    register(input: In): Payload
    registerOwner(input: In): Payload
    refreshSession(input: In): Payload
    addfavorite(input: In): Payload
  }
`);
const errorsOf = (source) => validate(schema, parse(source), [...specifiedRules, SingleAuthOperationRule])
  .map((error) => error.extensions?.code ?? error.message);

describe('SingleAuthOperationRule', () => {
  it('lists the password and token mutations', () => {
    expect(AUTH_OPERATIONS).toEqual(['login', 'register', 'registerOwner', 'refreshSession']);
  });

  it('allows one auth field per mutation, as the frontend, seeds and contracts send', () => {
    expect(errorsOf('mutation { login(input:{email:"a",password:"b"}) { accessToken } }')).toEqual([]);
    expect(errorsOf('mutation { register(input:{}) { accessToken } addfavorite(input:{}) { accessToken } }')).toEqual([]);
    expect(errorsOf('{ ping }')).toEqual([]);
    // Only one operation of a document runs, so each may hold one auth field.
    expect(errorsOf('mutation A { login(input:{}) { accessToken } } mutation B { login(input:{}) { accessToken } }')).toEqual([]);
  });

  it('rejects aliased, mixed and fragment auth fields', () => {
    expect(errorsOf('mutation { a: login(input:{password:"1"}) { accessToken } b: login(input:{password:"2"}) { accessToken } }')).toEqual(['AUTH_OPERATION_LIMIT']);
    expect(errorsOf('mutation { login(input:{}) { accessToken } register(input:{}) { accessToken } }')).toEqual(['AUTH_OPERATION_LIMIT']);
    expect(errorsOf('mutation { ...F a: refreshSession(input:{}) { accessToken } } fragment F on Mutation { refreshSession(input:{}) { accessToken } }')).toEqual(['AUTH_OPERATION_LIMIT']);
    expect(errorsOf('mutation { ... on Mutation { a: login(input:{}) { accessToken } } b: login(input:{}) { accessToken } }')).toEqual(['AUTH_OPERATION_LIMIT']);
  });

  it('is added to request validation by the Yoga plugin', () => {
    const added = [];
    useSingleAuthOperation().onValidate({ addValidationRule: (rule) => added.push(rule) });
    expect(added).toEqual([SingleAuthOperationRule]);
  });
});
