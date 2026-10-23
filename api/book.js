// Public booking. Looks up the trainer by slug on the server.
// Never trusts a trainer id from the browser. Never returns client names.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const crypto = require("crypto");
const booking = require("../lib/booking");

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : (fwd || (req.socket && req.socket.remoteAddress) || "");
  return String(raw).split(",")[0].trim() || "unknown";
}

function ipHash(ip) {
  return crypto.createHash("sha256").update("fitrm-book-v1:" + ip).digest("hex").slice(0, 32);
}

function missingTable(status, body) {
  const msg = typeof body === "string" ? body : JSON.stringify(body || "");
  return status === 404 || /PGRST205|42P01|does not exist|booking_requests|booking_rate|schema cache/i.test(msg);
}

function makeSb(fetchImpl, env) {
  const url = env && env.url;
  const key = env && env.key;
  return async function sbFetch(path, opts) {
    if (!url || !key) return { status: 0, body: null, missing: true };
    const res = await fetchImpl(url + path, Object.assign({
      headers: Object.assign({
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      }, (opts && opts.headers) || {})
    }, opts || {}));
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
    return { status: res.status, body: body, missing: missingTable(res.status, text) };
  };
}

async function trainerBySlug(sbFetch, slug) {
  const filter = encodeURIComponent("data->profile->booking->>slug") + "=eq." + encodeURIComponent(slug);
  const got = await sbFetch("/rest/v1/app_state?select=trainer_id,data&" + filter);
  if (got.missing || got.status === 0) return { unavailable: true };
  if (got.status >= 400) return { unavailable: true };
  const rows = Array.isArray(got.body) ? got.body : [];
  if (rows.length > 1) return { conflict: true };
  if (!rows.length) return { none: true };
  const row = rows[0];
  const data = row.data && typeof row.data === "string" ? JSON.parse(row.data) : (row.data || {});
  return { trainerId: row.trainer_id, state: data };
}

async function pendingFor(sbFetch, trainerId) {
  const got = await sbFetch("/rest/v1/booking_requests?select=slot_start,duration_min,status&trainer_id=eq."
    + encodeURIComponent(trainerId) + "&status=eq.pending&limit=200");
  if (got.missing || got.status === 0) return { unavailable: true, rows: [] };
  if (got.status >= 400) return { unavailable: true, rows: [] };
  return { rows: Array.isArray(got.body) ? got.body : [] };
}

async function rateCounts(sbFetch, slug, hash, now) {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const base = "/rest/v1/booking_rate?select=created_at&slug=eq." + encodeURIComponent(slug)
    + "&ip_hash=eq." + encodeURIComponent(hash) + "&created_at=gte." + encodeURIComponent(hourAgo) + "&limit=8";
  const got = await sbFetch(base);
  if (got.missing || got.status === 0) return { unavailable: true };
  if (got.status >= 400) return { unavailable: true };
  const rows = Array.isArray(got.body) ? got.body : [];
  const burstCutoff = now.getTime() - 10 * 60 * 1000;
  const burst = rows.filter(function (r) { return r.created_at && new Date(r.created_at).getTime() >= burstCutoff; }).length;
  return { recent: rows.length, burst: burst };
}

function viewBody(found, pendingRows, now) {
  const view = booking.publicView(found.state, pendingRows || [], now);
  return {
    ok: true,
    trainerName: view.trainerName,
    sessionMinutes: view.sessionMinutes,
    timezone: view.timezone,
    closed: !view.enabled,
    slots: view.enabled ? view.slots : []
  };
}

async function handleBook(req, deps) {
  deps = deps || {};
  const now = deps.now || new Date();
  const sbFetch = deps.sbFetch || makeSb(deps.fetch || fetch, deps.env || {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY
  });
  const method = req.method || "GET";
  if (method !== "GET" && method !== "POST") return { status: 405, body: { error: "Method not allowed" } };
  const url = new URL(req.url || "/", "http://localhost");
  const body = method === "POST"
    ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}))
    : {};
  const slug = booking.normalizeSlug((body && body.slug) || url.searchParams.get("slug") || "");
  if (!slug) return { status: 400, body: { error: "That booking link is not valid." } };

  const found = await trainerBySlug(sbFetch, slug);
  if (found.unavailable) return { status: 503, body: { error: "booking_unavailable" } };
  if (found.conflict) return { status: 409, body: { error: "This booking link is not available." } };
  if (found.none) return { status: 404, body: { error: "This booking link was not found." } };

  const pending = await pendingFor(sbFetch, found.trainerId);
  if (pending.unavailable) return { status: 503, body: { error: "booking_unavailable" } };

  if (method === "GET") return { status: 200, body: viewBody(found, pending.rows, now) };

  const check = booking.validateRequest(body);
  if (!check.ok) return { status: 400, body: { error: check.error } };
  const view = booking.publicView(found.state, pending.rows, now);
  if (!view.enabled) return { status: 400, body: { error: "This trainer is not taking requests right now." } };
  if (view.slots.indexOf(check.start) === -1) return { status: 400, body: { error: "That time is no longer open. Pick another." } };

  const hash = ipHash((deps.ip) || clientIp(req));
  const counts = await rateCounts(sbFetch, slug, hash, now);
  if (counts.unavailable) return { status: 503, body: { error: "booking_unavailable" } };
  const decision = booking.rateDecision(counts.recent, counts.burst);
  if (!decision.ok) return { status: 429, body: { error: decision.error } };

  const saved = await sbFetch("/rest/v1/booking_requests", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      trainer_id: found.trainerId,
      slug: slug,
      client_name: check.name,
      client_phone: check.phone || null,
      client_email: check.email || null,
      slot_start: check.start,
      duration_min: view.sessionMinutes || 60,
      note: check.note || null,
      status: "pending"
    })
  });
  if (saved.missing || saved.status === 0 || saved.status >= 400) return { status: 503, body: { error: "booking_unavailable" } };
  await sbFetch("/rest/v1/booking_rate", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ slug: slug, ip_hash: hash })
  });
  return { status: 200, body: { ok: true } };
}

module.exports = async function (req, res) {
  try {
    const result = await handleBook(req);
    res.status(result.status).json(result.body);
  } catch (e) {
    res.status(500).json({ error: "Booking is not available right now." });
  }
};
module.exports.handleBook = handleBook;
module.exports.ipHash = ipHash;
