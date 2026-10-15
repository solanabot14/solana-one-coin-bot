const test = require("node:test");
const assert = require("node:assert/strict");
const { createGeckoTerminalClient } = require("../geckoTerminal");

test("discovery feed requests keep pages and trending windows independent", async () => {
  const requests = [];
  const client = createGeckoTerminalClient({
    clock: () => 1_800_000_000_000,
    sleep: async () => {},
    requestSpacingMs: 0,
    httpGet: async (url, options) => {
      requests.push({ url, params: options.params });
      return { data: { data: [{ id: `${options.params.duration || "new"}-${options.params.page}` }] } };
    }
  });
  const [newPage1, newPage2, trending5m, trending6h] = await Promise.all([
    client.getNewSolanaPools({ page: 1 }),
    client.getNewSolanaPools({ page: 2 }),
    client.getTrendingSolanaPools({ duration: "5m" }),
    client.getTrendingSolanaPools({ duration: "6h" })
  ]);
  assert.equal(requests.length, 4);
  assert.equal(newPage1[0].id, "new-1");
  assert.equal(newPage2[0].id, "new-2");
  assert.equal(trending5m[0].id, "5m-1");
  assert.equal(trending6h[0].id, "6h-1");
});
