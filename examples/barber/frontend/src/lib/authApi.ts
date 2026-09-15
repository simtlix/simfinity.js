const GRAPHQL_URL =
  process.env.NEXT_PUBLIC_GRAPHQL_URL || "http://localhost:4400/graphql";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
};

export type AuthPayload = {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
};

type GraphqlError = { message: string };

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: GraphqlError[] };
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  if (!json.data) throw new Error("Empty GraphQL response");
  return json.data;
}

export async function loginRequest(
  email: string,
  password: string
): Promise<AuthPayload> {
  const data = await gql<{ login: AuthPayload }>(
    `mutation Login($input: LoginInput!) {
      login(input: $input) {
        accessToken
        refreshToken
        user { id email name role }
      }
    }`,
    { input: { email, password } }
  );
  return data.login;
}

export async function registerRequest(
  email: string,
  password: string,
  name: string,
  phone?: string
): Promise<AuthPayload> {
  const data = await gql<{ register: AuthPayload }>(
    `mutation Register($input: RegisterInput!) {
      register(input: $input) {
        accessToken
        refreshToken
        user { id email name role }
      }
    }`,
    {
      input: {
        email,
        password,
        name,
        ...(phone?.trim() ? { phone: phone.trim() } : {}),
      },
    }
  );
  return data.register;
}

export async function registerOwnerRequest(
  email: string,
  password: string,
  name: string,
  phone?: string
): Promise<AuthPayload> {
  const data = await gql<{ registerOwner: AuthPayload }>(
    `mutation RegisterOwner($input: RegisterInput!) {
      registerOwner(input: $input) {
        accessToken
        refreshToken
        user { id email name role }
      }
    }`,
    {
      input: {
        email,
        password,
        name,
        ...(phone?.trim() ? { phone: phone.trim() } : {}),
      },
    }
  );
  return data.registerOwner;
}

export async function refreshSessionRequest(refreshToken: string): Promise<AuthPayload> {
  const data = await gql<{ refreshSession: AuthPayload }>(
    `mutation Refresh($input: RefreshInput!) {
      refreshSession(input: $input) {
        accessToken
        refreshToken
        user { id email name role }
      }
    }`,
    { input: { refreshToken } }
  );
  return data.refreshSession;
}
