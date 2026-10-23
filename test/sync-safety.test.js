const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const Sync = require("../lib/sync-safety.js");

function client(id, name) { return { id: id, name: name, phone: "", email: "", status: "active" }; }
function biz(opts) {
  return {
    syncVersion: opts.version || 0,
    profile: opts.profile || { state: "CA" },
    packageTypes: opts.packageTypes || [],
    clients: opts.clients || [],
    sales: opts.sales || [],
    sessions: opts.sessions || [],
    expenses: [],
    taxPayments: [],
    recurringExpenses: [],
    recurringSessions: [],
    events: []
  };
}

test("empty local never replaces a cloud business on load", function () {
  const remote = biz({ version: 4, clients: [client("c1", "Maya")] });
  const plan = Sync.planLoad({ local: biz({ clients: [] }), remote: remote, base: null, pending: false });
  assert.equal(plan.action, "use-remote");
  assert.equal(plan.push, false);
  assert.equal(plan.reason, "empty-local");
  assert.equal(plan.state.clients[0].name, "Maya");
});

test("a failed cloud read does not upload", function () {
  const local = biz({ clients: [client("c1", "Maya")] });
  const plan = Sync.planLoad({ local: local, remote: null, loadError: true, pending: true });
  assert.equal(plan.action, "hold");
  assert.equal(plan.push, false);
  assert.equal(plan.state.clients[0].name, "Maya");
});

test("pending local edits upload when the cloud version is unchanged", function () {
  const base = biz({ version: 2, clients: [client("c1", "Maya")] });
  const local = biz({ version: 2, clients: [client("c1", "Maya"), client("c2", "Devon")] });
  const remote = biz({ version: 2, clients: [client("c1", "Maya")] });
  const plan = Sync.planLoad({ local: local, remote: remote, base: base, pending: true });
  assert.equal(plan.action, "push-local");
  assert.equal(plan.push, true);
  assert.equal(plan.state.clients.length, 2);
});

test("a stale device merges instead of replacing the cloud copy", function () {
  const base = biz({ version: 2, clients: [client("c1", "Maya")] });
  const local = biz({ version: 2, clients: [client("c1", "Maya"), client("c2", "Devon")] });
  const remote = biz({ version: 5, clients: [client("c1", "Maya Chen"), client("c3", "Priya")] });
  const plan = Sync.planLoad({ local: local, remote: remote, base: base, pending: true });
  assert.equal(plan.action, "merge");
  assert.equal(plan.push, true);
  const names = plan.state.clients.map(function (c) { return c.name; }).sort();
  assert.deepEqual(names, ["Devon", "Maya Chen", "Priya"]);
});

test("without a base snapshot, pending local data is not uploaded", function () {
  const local = biz({ clients: [client("c9", "Old phone")] });
  const remote = biz({ version: 3, clients: [client("c1", "Maya")] });
  const plan = Sync.planLoad({ local: local, remote: remote, base: null, pending: true });
  assert.equal(plan.push, false);
  assert.equal(plan.stashLocal, true);
  assert.equal(plan.state.clients[0].name, "Maya");
});

test("push refuses empty over a real business unless a wipe was confirmed", function () {
  const remote = biz({ version: 3, clients: [client("c1", "Maya")] });
  const blocked = Sync.planPush({
    local: biz({ version: 3, clients: [] }),
    remote: remote,
    baseVersion: 3,
    allowEmptyPush: false
  });
  assert.equal(blocked.action, "refuse");
  assert.equal(blocked.reason, "empty-over-data");
  const allowed = Sync.planPush({
    local: biz({ version: 3, clients: [] }),
    remote: remote,
    baseVersion: 3,
    allowEmptyPush: true,
    fullReplace: true
  });
  assert.equal(allowed.action, "update");
});

test("a confirmed wipe still refuses when another device saved first", function () {
  const remote = biz({ version: 8, clients: [client("c1", "Maya")] });
  const plan = Sync.planPush({
    local: biz({ clients: [] }),
    remote: remote,
    baseVersion: 4,
    allowEmptyPush: true,
    fullReplace: true
  });
  assert.equal(plan.action, "refuse");
  assert.equal(plan.reason, "stale-replace");
  assert.equal(plan.state.clients[0].name, "Maya");
});

test("a normal edit is a conflict when the cloud version moved", function () {
  const remote = biz({ version: 6, clients: [client("c1", "Maya")] });
  const plan = Sync.planPush({
    local: biz({ version: 4, clients: [client("c1", "Maya"), client("c2", "Devon")] }),
    remote: remote,
    baseVersion: 4
  });
  assert.equal(plan.action, "conflict");
});

test("legacy rows notice a newer updated_at even with no syncVersion", function () {
  const remote = biz({ clients: [client("c1", "Maya")] });
  delete remote.syncVersion;
  const plan = Sync.planPush({
    local: biz({ clients: [client("c1", "Maya"), client("c2", "Devon")] }),
    remote: remote,
    baseVersion: 0,
    baseUpdatedAt: "2026-10-01T00:00:00+00:00",
    remoteUpdatedAt: "2026-10-23T00:00:00+00:00"
  });
  assert.equal(plan.action, "conflict");
});

test("merge keeps a local delete only when the cloud row did not change", function () {
  const base = biz({ version: 1, clients: [client("c1", "Maya"), client("c2", "Devon")] });
  const local = biz({ version: 1, clients: [client("c2", "Devon")] });
  const remoteSame = biz({ version: 2, clients: [client("c1", "Maya"), client("c2", "Devon")] });
  const dropped = Sync.mergeAppState(base, local, remoteSame);
  assert.deepEqual(dropped.clients.map(function (c) { return c.id; }), ["c2"]);

  const remoteEdited = biz({ version: 2, clients: [client("c1", "Maya Chen"), client("c2", "Devon")] });
  const kept = Sync.mergeAppState(base, local, remoteEdited);
  assert.deepEqual(kept.clients.map(function (c) { return c.id; }).sort(), ["c1", "c2"]);
  assert.equal(kept.clients.find(function (c) { return c.id === "c1"; }).name, "Maya Chen");
});

test("merge joins profile fields edited on each side", function () {
  const base = { profile: { state: "CA", annualIncome: 0 }, clients: [] };
  const local = { profile: { state: "CA", annualIncome: 80000 }, clients: [] };
  const remote = { profile: { state: "TX", annualIncome: 0 }, clients: [] };
  const merged = Sync.mergeAppState(base, local, remote);
  assert.equal(merged.profile.state, "TX");
  assert.equal(merged.profile.annualIncome, 80000);
});

test("unionAdd only inserts missing ids", function () {
  const current = biz({ clients: [client("c1", "Maya")] });
  const extra = biz({ clients: [client("c1", "Maya OLD"), client("c9", "Phone only")] });
  const out = Sync.unionAdd(current, extra);
  assert.equal(out.clients.length, 2);
  assert.equal(out.clients[0].name, "Maya");
  assert.equal(out.clients[1].name, "Phone only");
});

test("inline scripts and the sync library parse", function () {
  const lib = spawnSync(process.execPath, ["--check", path.join(__dirname, "../lib/sync-safety.js")], { encoding: "utf8" });
  assert.equal(lib.status, 0, lib.stderr);

  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const re = /<script>([\s\S]*?)<\/script>/g;
  let match, n = 0;
  while ((match = re.exec(html))) {
    n++;
    const file = path.join(__dirname, ".inline-" + n + ".js");
    fs.writeFileSync(file, match[1]);
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    fs.unlinkSync(file);
    assert.equal(check.status, 0, "script " + n + " " + check.stderr);
  }
  assert.ok(n >= 2, "expected inline scripts");
});

test("the old app skin cannot write to an account", function () {
  const html = fs.readFileSync(path.join(__dirname, "../index_appskin.html"), "utf8");
  assert.equal(html.includes("supabase"), false);
  assert.equal(html.includes("app_state"), false);
  assert.equal(html.includes('location.replace("/")'), true);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "../vercel.json"), "utf8"));
  const redirect = (vercel.redirects || []).find(function (r) { return r.source === "/index_appskin.html"; });
  assert.ok(redirect);
  assert.equal(redirect.destination, "/");
});
