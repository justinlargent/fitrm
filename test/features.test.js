const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const path = require("path");
const Checkin = require("../lib/checkin.js");
const Pay = require("../lib/pay-link.js");
const Booking = require("../lib/booking.js");
const Sync = require("../lib/sync-safety.js");
const bookApi = require("../api/book.js");

function at(stamp) { const [d, t] = stamp.split("T"); const [y, m, day] = d.split("-").map(Number); const [hh, mm] = t.split(":").map(Number); return new Date(y, m - 1, day, hh, mm); }

test("check-ins stay hidden until the last session of the day has ended", function () {
  const state = {
    clients: [{ id: "c1", name: "Maya Chen", phone: "(415) 555-0142" }],
    sessions: [
      { id: "a", clientId: "c1", datetime: "2026-10-23T07:00", duration: 60, status: "scheduled" },
      { id: "b", clientId: "c1", datetime: "2026-10-23T18:00", duration: 60, status: "scheduled" }
    ]
  };
  const early = Checkin.plan(state, at("2026-10-23T18:30"));
  assert.equal(early.show, false);
  assert.equal(early.reason, "waiting");
  const ready = Checkin.plan(state, at("2026-10-23T19:00"));
  assert.equal(ready.show, true);
  assert.equal(ready.clients.length, 1);
  assert.equal(ready.clients[0].name, "Maya Chen");
});

test("one draft per client, editable text is kept, and texts are only links", function () {
  const state = {
    clients: [
      { id: "c1", name: "Maya Chen", phone: "4155550142" },
      { id: "c2", name: "Devon Brooks", phone: "" }
    ],
    sessions: [
      { id: "a", clientId: "c1", datetime: "2026-10-23T07:00", duration: 60, status: "completed" },
      { id: "b", clientId: "c1", datetime: "2026-10-23T09:00", duration: 60, status: "completed" },
      { id: "c", clientId: "c2", datetime: "2026-10-23T11:00", duration: 60, status: "completed" },
      { id: "d", clientId: "c1", datetime: "2026-10-27T07:00", duration: 60, status: "scheduled" }
    ],
    checkins: { "2026-10-23": { c2: { message: "Custom note for Devon", done: true } } }
  };
  const plan = Checkin.plan(state, at("2026-10-23T20:00"));
  assert.equal(plan.clients.length, 2);
  assert.match(plan.clients[0].message, /Hey Maya/);
  assert.match(plan.clients[0].message, /Tuesday at 7am/);
  assert.equal(plan.clients[1].message, "Custom note for Devon");
  assert.equal(plan.clients[1].done, true);
  const href = Checkin.smsHref(plan.clients[0].phone, plan.clients[0].message);
  assert.match(href, /^sms:\+14155550142\?&body=/);
  assert.equal(Checkin.smsHref("", "hi"), "");
  assert.equal(typeof Checkin.send, "undefined");
});

test("venmo and stripe links are built for the trainer to copy", function () {
  const url = Pay.venmoPayUrl({ handle: "@Justin-T", amount: 750, note: Pay.payNote("10-Session Strength", "Maya Chen") });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "venmo.com");
  assert.equal(parsed.searchParams.get("txn"), "pay");
  assert.equal(parsed.searchParams.get("recipients"), "Justin-T");
  assert.equal(parsed.searchParams.get("amount"), "750.00");
  assert.match(parsed.searchParams.get("note"), /Maya/);
  assert.equal(Pay.venmoPayUrl({ handle: "https://evil.example", amount: 10 }), "");
  assert.equal(Pay.stripePayUrl("https://buy.stripe.com/test_abc"), "https://buy.stripe.com/test_abc");
  assert.equal(Pay.stripePayUrl("https://pay.stripe.com/abc"), "https://pay.stripe.com/abc");
  assert.equal(Pay.stripePayUrl("javascript:alert(1)"), "");
  assert.equal(Pay.stripePayUrl("https://example.com/pay"), "");
  assert.match(Pay.textBody("Maya Chen", "10-Session Strength", url), /^Hi Maya/);
});

test("open slots hide client names and skip busy times, including across the fall clock change", function () {
  const hours = {};
  for (let d = 0; d < 7; d++) hours[d] = { on: d === 0 || d === 1, blocks: [{ start: "01:00", end: "03:00" }] };
  hours[1] = { on: true, blocks: [{ start: "09:00", end: "11:00" }] };
  const state = {
    profile: {
      sessionLength: 60,
      workingHours: hours,
      booking: { enabled: true, slug: "justin", publicName: "Justin", timezone: "UTC", useWorkingHours: true }
    },
    clients: [{ id: "c1", name: "Secret Client", phone: "4155550199", email: "secret@example.com" }],
    sessions: [{ id: "s1", clientId: "c1", datetime: "2026-10-26T09:00", duration: 60, status: "scheduled", notes: "knee pain" }],
    events: []
  };
  const now = new Date(Date.UTC(2026, 9, 21, 15, 0));
  const view = Booking.publicView(state, [], now);
  assert.equal(view.slots.includes("2026-10-26T09:00"), false);
  assert.equal(view.slots.includes("2026-10-26T10:00"), true);
  const dumped = JSON.stringify(view);
  assert.equal(dumped.includes("Secret"), false);
  assert.equal(dumped.includes("knee"), false);
  assert.equal(dumped.includes("4155550199"), false);
  const fall = Booking.openSlots({
    hours: { 0: { on: true, blocks: [{ start: "01:00", end: "03:00" }] } },
    sessionMinutes: 60,
    busy: [],
    now: new Date(Date.UTC(2026, 10, 1, 7, 20)),
    timeZone: "America/Los_Angeles",
    days: 1
  });
  assert.deepEqual(fall, ["2026-11-01T01:00", "2026-11-01T02:00"]);
});

test("booking requests are validated and rate limited", function () {
  assert.equal(Booking.normalizeSlug("Justin Largent!"), "justin-largent");
  assert.equal(Booking.normalizeSlug("ab"), "");
  const bad = Booking.validateRequest({ name: "", start: "2026-10-26T10:00" });
  assert.equal(bad.ok, false);
  const honeypot = Booking.validateRequest({ name: "A", start: "2026-10-26T10:00", company: "spam" });
  assert.equal(honeypot.ok, false);
  assert.equal(Booking.rateDecision(8, 0).ok, false);
  assert.equal(Booking.rateDecision(1, 3).ok, false);
  assert.equal(Booking.rateDecision(1, 1).ok, true);
});

test("the booking API refuses a closed slot and never echoes client data", async function () {
  const calls = [];
  const state = {
    profile: {
      sessionLength: 60,
      workingHours: { 1: { on: true, blocks: [{ start: "09:00", end: "11:00" }] } },
      booking: { enabled: true, slug: "justin", publicName: "Justin", timezone: "UTC", useWorkingHours: true }
    },
    clients: [{ id: "c1", name: "Secret Client", phone: "4155550199", email: "secret@example.com" }],
    sessions: [{ id: "s1", clientId: "c1", datetime: "2026-10-26T09:00", duration: 60, status: "scheduled" }]
  };
  const sbFetch = async function (path, opts) {
    calls.push({ path: path, opts: opts || null });
    if (path.indexOf("/rest/v1/app_state") === 0) return { status: 200, body: [{ trainer_id: "trainer-real", data: state }] };
    if (path.indexOf("/rest/v1/booking_requests") === 0 && (!opts || !opts.method)) return { status: 200, body: [] };
    if (path.indexOf("/rest/v1/booking_rate") === 0 && (!opts || !opts.method)) return { status: 200, body: [] };
    if (opts && opts.method === "POST") return { status: 201, body: {} };
    return { status: 200, body: [] };
  };
  const now = new Date(Date.UTC(2026, 9, 21, 15, 0));
  const got = await bookApi.handleBook({ method: "GET", url: "/api/book?slug=justin" }, { sbFetch: sbFetch, now: now });
  assert.equal(got.status, 200);
  assert.equal(JSON.stringify(got.body).includes("Secret"), false);
  assert.equal(got.body.slots.includes("2026-10-26T09:00"), false);
  const rejected = await bookApi.handleBook({
    method: "POST", url: "/api/book",
    body: { slug: "justin", name: "Alex", start: "2026-10-26T09:00", trainerUid: "attacker" }
  }, { sbFetch: sbFetch, now: now, ip: "1.2.3.4" });
  assert.equal(rejected.status, 400);
  const posts = calls.filter(function (c) { return c.opts && c.opts.method === "POST"; });
  assert.equal(posts.length, 0);
  const accepted = await bookApi.handleBook({
    method: "POST", url: "/api/book",
    body: { slug: "justin", name: "Alex", phone: "4155550100", start: "2026-10-26T10:00", trainerUid: "attacker" }
  }, { sbFetch: sbFetch, now: now, ip: "1.2.3.4" });
  assert.equal(accepted.status, 200);
  const insert = calls.filter(function (c) { return c.opts && c.opts.method === "POST" && c.path.indexOf("booking_requests") !== -1; }).pop();
  const saved = JSON.parse(insert.opts.body);
  assert.equal(saved.trainer_id, "trainer-real");
  assert.equal(saved.trainer_id === "attacker", false);
  const missing = await bookApi.handleBook({ method: "GET", url: "/api/book?slug=justin" }, {
    sbFetch: async function () { return { status: 404, body: { message: "booking_requests does not exist" }, missing: true }; },
    now: now
  });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, "booking_unavailable");
});

test("check-in drafts merge instead of wiping the other device", function () {
  const base = { checkins: { "2026-10-23": { c1: { message: "Hey Maya", done: false } } }, clients: [] };
  const local = { checkins: { "2026-10-23": { c1: { message: "Hey Maya, nice lifts", done: true } } }, clients: [] };
  const remote = { checkins: { "2026-10-23": { c2: { message: "Hey Devon", done: false } } }, clients: [] };
  const merged = Sync.mergeAppState(base, local, remote);
  assert.equal(merged.checkins["2026-10-23"].c1.message, "Hey Maya, nice lifts");
  assert.equal(merged.checkins["2026-10-23"].c1.done, true);
  assert.equal(merged.checkins["2026-10-23"].c2.message, "Hey Devon");
});

test("the app wires check-ins, pay links, and booking without auto-sending", function () {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /lib\/checkin\.js/);
  assert.match(html, /lib\/pay-link\.js/);
  assert.match(html, /lib\/booking\.js/);
  assert.match(html, /Open in Messages/);
  assert.match(html, /Send pay link/);
  assert.match(html, /loadBookingRequests/);
  assert.equal(html.includes("twilio"), false);
  assert.equal(html.includes("sms.send"), false);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8"));
  const rewrite = (vercel.rewrites || []).find(function (r) { return r.source === "/book/:slug"; });
  assert.ok(rewrite);
  assert.equal(rewrite.destination, "/book.html?slug=:slug");
  const fresh = ["../lib/checkin.js", "../lib/pay-link.js", "../lib/booking.js", "../api/book.js", "../book.html", "../supabase/booking_requests.sql"];
  fresh.forEach(function (rel) {
    const text = fs.readFileSync(path.join(__dirname, rel), "utf8");
    assert.equal(text.includes("\u2014") || text.includes("\u2013"), false, rel);
  });
});

test("feature scripts parse", function () {
  ["../lib/checkin.js", "../lib/pay-link.js", "../lib/booking.js", "../api/book.js"].forEach(function (rel) {
    const file = path.join(__dirname, rel);
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, rel + " " + check.stderr);
  });
  const html = fs.readFileSync(path.join(__dirname, "../book.html"), "utf8");
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  const file = path.join(__dirname, ".book-inline.js");
  fs.writeFileSync(file, inline[1]);
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  fs.unlinkSync(file);
  assert.equal(check.status, 0, check.stderr);
});
