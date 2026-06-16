// Stripe webhook: when a checkout completes, mark the payment paid in Supabase.
// Env vars in Vercel: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// NOTE: signature verification is intentionally skipped for the test-mode beta.
//       Add STRIPE_WEBHOOK_SECRET verification before going live with real money.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const event = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (event.type === "checkout.session.completed") {
      const s = event.data && event.data.object;
      if (SB_URL && SB_KEY && s && s.id) {
        await fetch(SB_URL + "/rest/v1/payments?stripe_session_id=eq." + encodeURIComponent(s.id), {
          method: "PATCH",
          headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ status: "paid", stripe_payment_intent: s.payment_intent || null, paid_at: new Date().toISOString() })
        });
      }
    }
    res.status(200).json({ received: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
