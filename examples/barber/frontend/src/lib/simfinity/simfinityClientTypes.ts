import SimfinityClient from "@simtlix/simfinity-js-client";

export type SimfinityClientInstance = InstanceType<typeof SimfinityClient>;

export type SimfinityClientProviderOptions = {
  prepareHeaders?: (headers: Record<string, string>) => void;
  /** URL of the server's client descriptor. When set, `init()` reads it instead of introspecting. */
  descriptorEndpoint?: string;
};
