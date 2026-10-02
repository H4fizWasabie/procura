import assert from "node:assert/strict";
import { test } from "node:test";
import { humanTurnSince, PreviewStore } from "../guard.ts";

const user = (at: number) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "user" } });
const assistant = (at: number) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant" } });
const toolResult = (at: number) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "toolResult" } });

test("only a user message after the cut-off counts as a human turn", () => {
  assert.equal(humanTurnSince([user(1000), assistant(2000), toolResult(3000)], 1500), false);
  assert.equal(humanTurnSince([assistant(2000), user(3000)], 2500), true);
  assert.equal(humanTurnSince([user(2500)], 2500), false, "a message at the same instant is not after");
  assert.equal(humanTurnSince([{ type: "custom_message", timestamp: new Date(9000).toISOString() }], 0), false);
  assert.equal(humanTurnSince([{ type: "message", timestamp: "garbage", message: { role: "user" } }], 0), false);
  assert.equal(humanTurnSince([], 0), false);
});

function fixture() {
  let now = 1_000_000;
  const store = new PreviewStore<{ x: number }>(() => now, 60_000);
  return { store, tick: (ms: number) => (now += ms), now: () => now };
}

test("a preview can be saved once a user message has arrived after it", () => {
  const f = fixture();
  const p = f.store.create("po", "s1", { x: 1 });
  f.tick(5000);
  const taken = f.store.take(p.id, "po", "s1", [user(f.now())]);
  assert.equal(taken.ok, true);
  if (taken.ok) assert.deepEqual(taken.preview.data, { x: 1 });
});

test("preview and save in the same run is refused: no user message in between", () => {
  const f = fixture();
  const p = f.store.create("po", "s1", { x: 1 });
  f.tick(5000);
  const taken = f.store.take(p.id, "po", "s1", [user(p.createdAt - 10_000), assistant(f.now()), toolResult(f.now())]);
  assert.equal(taken.ok, false);
  if (!taken.ok) assert.match(taken.reason, /wait for their reply/);
});

test("an expired, used, foreign or unknown preview is refused", () => {
  const f = fixture();
  const p = f.store.create("po", "s1", { x: 1 });
  f.tick(5000);
  const reply = [user(f.now())];
  assert.match((f.store.take("pv-nope", "po", "s1", reply) as { reason: string }).reason, /No such preview/);
  assert.match((f.store.take(p.id, "rfq", "s1", reply) as { reason: string }).reason, /for po, not rfq/);
  assert.match((f.store.take(p.id, "po", "other-session", reply) as { reason: string }).reason, /different session/);
  f.store.markUsed(p.id);
  assert.match((f.store.take(p.id, "po", "s1", reply) as { reason: string }).reason, /already used/);
  const q = f.store.create("po", "s1", { x: 2 });
  f.tick(61_000);
  assert.match((f.store.take(q.id, "po", "s1", [user(f.now())]) as { reason: string }).reason, /expired/);
});
