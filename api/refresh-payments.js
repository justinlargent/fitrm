// Reliable payment reconciliation without depending on webhooks.
// For a trainer, find any "pending" payments and ask Stripe directly whether
// the checkout was paid; if so, mark the row paid. Returns the paid sale ids.
// Env vars in Vercel: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { trainerUid, accountId } = body;
    if (!trainerUid || !accountId) return res.status(400).json({ error: "Missing trainerUid or accountId" });
    if (!SB_URL || !SB_KEY) return res.status(500).json({ error: "Server not configured" });

    // Get this trainer's still-pending payment rows.
    const listUrl = SB_URL + "/rest/v1/payments?trainer_id=eq." + encodeURIComponent(trainerUid) +
      "&status=eq.pending&select=id,stripe_session_id,sale_id";
    const r = await fetch(listUrl, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
    const rows = await r.json();

    const paid = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row.stripe_session_id) continue;
      try {
        const session = await stripe.checkout.sessions.retrieve(row.stripe_session_id, { stripeAccount: accountId });
        if (session && session.payment_status === "paid") {
          await fetch(SB_URL + "/rest/v1/payments?id=eq." + encodeURIComponent(row.id), {
            method: "PATCH",
            headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ status: "paid", stripe_payment_intent: session.payment_intent || null, paid_at: new Date().toISOString() })
          });
          paid.push(row.sale_id);
        }
      } catch (e) { /* skip this row, keep going */ }
    }

    res.status(200).json({ paid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
