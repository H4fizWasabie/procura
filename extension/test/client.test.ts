import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AmbiguousOutcomeError, loadCredentials, ProcuraClient } from "../client.ts";

const PIN = "482913";
let logins = 0;
let posts = 0;
let validToken = "";
let rejectEverything = false;
const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
    if (req.url === "/api/login") {
      logins++;
      if (body.email === "assistant@probe.test" && body.pin === PIN) {
        validToken = `tok-${logins}`;
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `token=${validToken}; Path=/; HttpOnly` });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid credentials" }));
      }
      return;
    }
    if (req.url === "/api/drop") {
      posts++;
      req.socket.destroy();
      return;
    }
    posts++;
    if (rejectEverything || req.headers.authorization !== `Bearer ${validToken}`) {
      res.writeHead(303, { location: "/login" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, echo: body }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base_url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const client = () => new ProcuraClient({ base_url, email: "assistant@probe.test", pin: PIN });
const reset = () => { logins = 0; posts = 0; validToken = ""; rejectEverything = false; };

test("the client logs in once, reuses the session, and sends the body as JSON", async () => {
  reset();
  const c = client();
  const first = await c.post("/api/pos", { a: 1 });
  const second = await c.post("/api/rfq", { b: 2 });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.echo, { a: 1 });
  assert.equal(second.status, 200);
  assert.equal(logins, 1);
});

test("a rejected session logs in again and retries once", async () => {
  reset();
  const c = client();
  await c.post("/api/pos", {});
  validToken = "something-else"; // the server forgot our token
  const again = await c.post("/api/pos", {});
  assert.equal(again.status, 200);
  assert.equal(logins, 2);
});

test("a session that is always rejected is retried once, not forever", async () => {
  reset();
  const c = client();
  rejectEverything = true;
  const result = await c.post("/api/pos", {});
  assert.equal(result.status, 303);
  assert.equal(logins, 2);
  assert.equal(posts, 2);
});

test("a failed login says so without revealing the PIN", async () => {
  reset();
  const c = new ProcuraClient({ base_url, email: "assistant@probe.test", pin: "000000" });
  await assert.rejects(c.post("/api/pos", {}), (error: Error) => {
    assert.match(error.message, /login failed \(HTTP 401\)/);
    assert.equal(error.message.includes("000000"), false);
    return true;
  });
  assert.equal(posts, 0, "nothing was posted without a session");
});

test("a request that dies mid-flight is reported as ambiguous and is never retried", async () => {
  reset();
  const c = client();
  await assert.rejects(c.post("/api/drop", { x: 1 }), AmbiguousOutcomeError);
  assert.equal(posts, 1);
});

test("an unreachable Procura is a plain error at login, not an ambiguous save", async () => {
  const c = new ProcuraClient({ base_url: "http://127.0.0.1:1", email: "a@b.test", pin: PIN });
  await assert.rejects(c.post("/api/pos", {}), (error: Error) => {
    assert.equal(error instanceof AmbiguousOutcomeError, false);
    assert.match(error.message, /Could not reach Procura/);
    return true;
  });
});

async function credFile(mode: number, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "procura-cred-"));
  const path = join(dir, "service.json");
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

test("credentials load from a private file and default the address", async () => {
  const path = await credFile(0o600, JSON.stringify({ email: " assistant@probe.test ", pin: PIN }));
  assert.deepEqual(await loadCredentials(path), { base_url: "http://127.0.0.1:8082", email: "assistant@probe.test", pin: PIN });
  const custom = await credFile(0o600, JSON.stringify({ email: "a@b.test", pin: "1", base_url: "http://localhost:9000///" }));
  assert.equal((await loadCredentials(custom)).base_url, "http://localhost:9000");
});

test("credentials are refused when the file is group- or world-readable, missing, or malformed", async () => {
  await assert.rejects(loadCredentials(await credFile(0o644, JSON.stringify({ email: "a@b.test", pin: "1" }))), /readable only by its owner/);
  await assert.rejects(loadCredentials(join(tmpdir(), "procura-no-such-file.json")), /not configured/);
  await assert.rejects(loadCredentials(await credFile(0o600, "{nope")), /not valid JSON/);
  await assert.rejects(loadCredentials(await credFile(0o600, JSON.stringify({ email: "a@b.test" }))), /needs "email" and "pin"/);
});
