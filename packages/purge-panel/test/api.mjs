import assert from "node:assert/strict";
import { skillsApi, apiUrl } from "../src/api/client.js";
globalThis.window = { location: { origin: "http://fixture" } };
let calls = [],
  responses = [];
globalThis.fetch = async (url) => {
  calls.push(new URL(url).pathname);
  return responses.shift();
};
const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: "Error",
  text: async () => body,
});
for (const first of [
  reply(500, "<h1>server error</h1>"),
  reply(200, "broken response"),
  reply(500, JSON.stringify({ error: "404 while reading file" })),
]) {
  calls = [];
  responses = [first];
  await assert.rejects(() =>
    skillsApi("save", { id: "fixture", content: "test" }),
  );
  assert.equal(calls.length, 1, "Ambiguous write failure must not be replayed");
}
for (const status of [404, 405]) {
  calls = [];
  responses = [
    reply(status, JSON.stringify({ error: "route missing" })),
    reply(200, JSON.stringify({ ok: true })),
  ];
  assert.deepEqual(await skillsApi("status"), { ok: true });
  assert.deepEqual(calls, ["/dsh-purge/skills", "/dsh-purge/skill"]);
}
console.log(
  "PASS: only missing routes fall back; ambiguous writes are never retried",
);

for (const prefix of ["/", "/app/fn-deepseek-harness/"]) {
  const href = "https://host.test:58983" + prefix + "?session=private#chat";
  const moduleUrl =
    "https://host.test:58983" +
    prefix +
    "plugins/dsh-purge-community/client.js?rev=1";
  assert.equal(
    apiUrl("/dsh-purge/status", { href, moduleUrl }),
    "https://host.test:58983" + prefix + "dsh-purge/status",
  );
  assert.equal(
    apiUrl("/redteam/api", { href, moduleUrl }),
    "https://host.test:58983" + prefix + "redteam/api",
  );
  assert.equal(
    apiUrl("/", { href, moduleUrl }),
    "https://host.test:58983" + prefix,
  );
}
assert.equal(
  apiUrl("/dsh-purge/status", {
    href: "https://host.test/app/dsh",
    baseURI: "https://evil.test/",
  }),
  "https://host.test/app/dsh/dsh-purge/status",
);
assert.equal(
  apiUrl("https://other.test/file", { href: "https://host.test/app/" }),
  "https://other.test/file",
);

// Real local HTTP deployment under a prefix. The isolated child retains native fetch.
const { createServer } = await import("node:http");
const { spawn } = await import("node:child_process");
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/app/dsh/dsh-purge/skills")
    res.end(JSON.stringify({ ok: true }));
  else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "wrong mount" }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const href = `http://127.0.0.1:${server.address().port}/app/dsh/`;
  const code = `globalThis.window={location:{href:${JSON.stringify(href)}}};const {skillsApi}=await import(${JSON.stringify(new URL("../src/api/client.js", import.meta.url).href)});const result=await skillsApi('status');if(!result.ok)throw Error('not ok');`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    let error = "";
    child.stderr.on("data", (x) => (error += x));
    child.on("error", reject);
    child.on("exit", (status) =>
      status === 0 ? resolve() : reject(Error(error)),
    );
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("PASS: actual HTTP request succeeds behind a subpath mount");
