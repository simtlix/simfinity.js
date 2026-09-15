import SimfinityClient from "@simtlix/simfinity-js-client";

export type SimfinityClientInstance = InstanceType<typeof SimfinityClient>;

export type SimfinityClientProviderOptions = {
  prepareHeaders?: (headers: Record<string, string>) => void;
};
