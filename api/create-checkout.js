// Creates a Stripe Checkout for a package sale, charged on the trainer's connected account.
// Env vars in Vercel: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { accountId, amount, saleId, trainerUid, clientName, description, returnUrl } = body;
    if (!accountId) return res.status(400).json({ error: "Connect Stripe first." });
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount." });

    const base = (returnUrl || "https://fitrm.io").replace(/\/$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: description || "Training package" },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }],
      metadata: { saleId: saleId || "", trainerUid: trainerUid || "" },
      success_url: base + "/?paid=success",
      cancel_url: base + "/?paid=cancel"
    }, { stripeAccount: accountId });

    // Record a pending payment row (the webhook flips it to paid).
    if (SB_URL && SB_KEY) {
      await fetch(SB_URL + "/rest/v1/payments", {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          trainer_id: trainerUid, sale_id: saleId, client_name: clientName,
          description: description, amount: amount, status: "pending", stripe_session_id: session.id
        })
      }).catch(() => {});
    }

    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
