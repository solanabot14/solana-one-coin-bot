const axios = require("axios");

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) { clearTimeout(timer); return reject(new Error("Request aborted")); }
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Request aborted")); }, { once: true });
  });
}

async function retry(request, { attempts = 5, baseDelayMs = 350, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new Error("Request aborted");
    try { return await request(); }
    catch (error) {
      lastError = error;
      const status = error?.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === attempts - 1) break;
      const retryAfter = Number(error?.response?.headers?.["retry-after"]);
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(8000, baseDelayMs * (2 ** attempt));
      console.warn("[INFO] API retry", { attempt: attempt + 1, status: status || "network", delayMs: delay });
      await wait(delay, signal);
    }
  }
  throw lastError;
}

module.exports = { retry };
