// Offline tests for the Worker's pure logic. No network, no Cloudflare: fetch and KV are faked.
// Run with:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortCode, onTopic, getCanvas, postState, getState, placesFromEnv } from "../src/worker.js";

// A tiny in-memory stand-in for Workers KV.
function fakeKV() {
  const mem = new Map();
  return {
    get: async (k, type) => { const v = mem.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    put: async (k, v) => { mem.set(k, v); },
    delete: async (k) => { mem.delete(k); },
  };
}

test("shortCode turns Canvas course codes into short labels", () => {
  assert.equal(shortCode("FA26-PHYS111A021"), "PHYS 111A");
  assert.equal(shortCode("FA26-MATH112011"), "MATH 112");
  assert.equal(shortCode("FA26-CS100-MC"), "CS 100");
  assert.equal(shortCode("FA26-FYSSEMY23"), "FYS");
  assert.equal(shortCode("", "PHYS 111 Commons Fall"), "PHYS 111 Commons");
});

test("onTopic keeps spiritual and philosophical titles and drops the rest", () => {
  assert.ok(onTopic("On prayer and the Psalms"));
  assert.ok(onTopic("Augustine on the restless heart"));
  assert.ok(!onTopic("Ten productivity apps I use every day"));
  assert.ok(!onTopic("Why the faster horse lost"), "a word prefix like 'fast' must not match 'faster'");
});

test("getCanvas follows pagination, keeps graded items only, and sorts by due date", async () => {
  const pages = {
    "/courses": [{ body: [{ id: 1, course_code: "FA26-CS100-MC", name: "Roadmap to Computing" }] }],
    "/planner/items": [
      { body: [
        { plannable_type: "assignment", course_id: 1, plannable_id: 11, plannable: { id: 11, title: "Lab 3", due_at: "2026-10-20T03:59:00Z", points_possible: 10 }, html_url: "/a/11" },
        { plannable_type: "announcement", course_id: 1, plannable_id: 99, plannable: { id: 99, title: "Welcome" } },
      ], next: "page2" },
      { body: [
        { plannable_type: "quiz", course_id: 1, plannable_id: 12, plannable: { id: 12, title: "Quiz 2", due_at: "2026-10-18T03:59:00Z" }, submissions: { submitted: true } },
      ] },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace("/api/v1", "");
    const page = u.searchParams.get("page") === "2" ? 1 : 0;
    const entry = pages[path][page];
    const headers = new Headers({ "content-type": "application/json" });
    if (entry.next) headers.set("link", `<https://canvas.test/api/v1${path}?page=2>; rel="next"`);
    return new Response(JSON.stringify(entry.body), { status: 200, headers });
  };
  try {
    const env = { CANVAS_BASE: "https://canvas.test", CANVAS_TOKEN: "test-token", STATE: fakeKV() };
    const snap = await getCanvas(env, true);
    assert.equal(snap.ok, true);
    assert.deepEqual(snap.items.map((i) => i.title), ["Quiz 2", "Lab 3"], "announcement dropped, page 2 included, sorted by due");
    assert.equal(snap.items[1].course, "CS 100");
    assert.deepEqual(snap.counts, { open: 1, submitted: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("getCanvas reports a missing token instead of throwing", async () => {
  const snap = await getCanvas({ STATE: fakeKV() }, true);
  assert.equal(snap.ok, false);
  assert.equal(snap.error, "canvas_token_missing");
});

test("dismissing, undismissing, and notes round-trip through state", async () => {
  const env = { STATE: fakeKV() };
  const call = (body) => postState(new Request("https://x/api/state", { method: "POST", body: JSON.stringify(body) }), env).then((r) => r.json());
  let s = await call({ dismiss: "assignment-11" });
  assert.deepEqual(s.ignored, ["assignment-11"]);
  s = await call({ note: "  buy a lab notebook  " });
  assert.equal(s.notes[0].text, "buy a lab notebook");
  s = await call({ undismiss: "assignment-11", deleteNote: s.notes[0].id });
  assert.deepEqual(s.ignored, []);
  assert.deepEqual(s.notes, []);
  const state = await getState(env);
  assert.equal(state.google, false);
});

test("home coordinates come from the HOME_LATLON secret, and nothing is returned without it", () => {
  assert.deepEqual(placesFromEnv({ HOME_LATLON: "40.5,-74.3" }), { home: { lat: 40.5, lon: -74.3 } });
  assert.deepEqual(placesFromEnv({}), { home: null });
  assert.deepEqual(placesFromEnv({ HOME_LATLON: "not,numbers" }), { home: null });
});
