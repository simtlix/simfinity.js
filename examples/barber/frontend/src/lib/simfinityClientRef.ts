import type SimfinityClient from "@simtlix/simfinity-js-client";

let _client: SimfinityClient | null = null;

export function setSimfinityClient(client: SimfinityClient): void {
  _client = client;
}

export function getSimfinityClient(): SimfinityClient {
  if (!_client) throw new Error("SimfinityClient not initialized");
  return _client;
}
