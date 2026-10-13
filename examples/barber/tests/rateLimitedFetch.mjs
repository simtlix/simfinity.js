// The backends rate limit each IP per minute (routes/rateLimits.js). A contract run, its cleanup
// and a seed or another run in the same minute can share one window, so wait for the window to
// reset on HTTP 429 instead of failing midway and leaving test records behind.
const MAX_RETRIES = 3;
const MAX_WAIT_SECONDS = 65;

const secondsToWait = (response) => {
  const header = response.headers.get('retry-after') ?? response.headers.get('ratelimit-reset');
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_WAIT_SECONDS) : MAX_WAIT_SECONDS;
};

/** fetch(url, init()) that retries a 429 after the advertised reset; init builds a fresh request each time. */
export async function fetchWithRateLimitRetry(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init());
    if (response.status !== 429 || attempt === MAX_RETRIES) return response;
    const seconds = secondsToWait(response);
    await response.body?.cancel();
    console.error(`Rate limited by ${new URL(url).pathname}; retrying in ${seconds}s (attempt ${attempt + 1} of ${MAX_RETRIES})`);
    await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
  }
}
