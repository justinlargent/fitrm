// Starts Stripe Connect onboarding for a trainer (Standard account, hosted by Stripe).
// Env var required in Vercel: STRIPE_SECRET_KEY  (use the sk_test_... key while testing)
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { email, accountId, returnUrl } = body;

    // Reuse the trainer's connected account if they already started one, else create it.
    let acct = accountId;
    if (!acct) {
      const account = await stripe.accounts.create({
        type: "standard",
        email: email || undefined
      });
      acct = account.id;
    }

    const base = (returnUrl || "https://fitrm.io").replace(/\/$/, "");
    const link = await stripe.accountLinks.create({
      account: acct,
      refresh_url: base + "/?stripe=refresh",
      return_url: base + "/?stripe=return",
      type: "account_onboarding"
    });

    res.status(200).json({ url: link.url, accountId: acct });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
