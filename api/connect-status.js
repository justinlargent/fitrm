// Checks whether a trainer's connected account can take charges yet.
// Env var required in Vercel: STRIPE_SECRET_KEY
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { accountId } = body;
    if (!accountId) return res.status(400).json({ error: "Missing accountId" });
    const acct = await stripe.accounts.retrieve(accountId);
    res.status(200).json({
      charges_enabled: acct.charges_enabled,
      details_submitted: acct.details_submitted
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
