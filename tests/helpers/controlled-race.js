// Failure ownership for the optimistic-concurrency integration races. Gates never reject on their
// own: only an awaited wait can throw. A deadline fails the harness, never selects a race winner.
export const createControlledRace = ({ timeoutMs = 5000 } = {}) => {
  const gates = [];
  const writers = [];
  let failure;
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const fail = (error) => {
    failure ??= error;
    stop(failure);
    for (const gate of gates) gate.resolve();
  };
  const check = () => { if (failure) throw failure; };
  const wait = async (promise) => {
    check();
    const result = await Promise.race([promise, stopped.then((error) => { throw error; })]);
    check();
    return result;
  };
  const timer = setTimeout(() => fail(new Error('Controlled race exceeded its safety deadline')), timeoutMs);
  return {
    gate(name) {
      let release;
      const ready = new Promise((resolve) => { release = resolve; });
      const gate = {
        name,
        resolved: false,
        resolve() { gate.resolved = true; release(); },
        wait: () => wait(ready),
      };
      gates.push(gate);
      return gate;
    },
    start(write) {
      const writer = Promise.resolve().then(write);
      writers.push(writer);
      // GraphQL failures fulfill with errors. Keep their original error, just like a rejected
      // handle write, when a terminal writer can no longer satisfy an outstanding handshake.
      const terminal = (error) => {
        const pending = gates.filter((gate) => !gate.resolved);
        if (pending.length) fail(error ?? new Error(`Writer ended before race gates: ${pending.map((gate) => gate.name).join(', ')}`));
      };
      writer.then((result) => terminal(result?.errors?.[0]), (error) => terminal(error));
      return writer;
    },
    wait,
    check,
    async finish() {
      // A failed assertion/setup must also let every already-started transaction unwind before
      // its spies or database fixtures are removed. Preserve the body's original failure.
      if (gates.some((gate) => !gate.resolved)) fail(new Error('Controlled race ended with pending gates'));
      try { await Promise.allSettled(writers); }
      finally { clearTimeout(timer); }
    },
  };
};
