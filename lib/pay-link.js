/* Pay links the trainer copies or texts. Nothing is marked paid here. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FitrmPay = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function venmoHandle(raw) {
    var h = String(raw || "").trim().replace(/^@+/, "").replace(/\s+/g, "");
    if (!h || /[\/:?#]/.test(h) || h.length > 30) return "";
    if (!/^[A-Za-z0-9_-]+$/.test(h)) return "";
    return h;
  }

  function moneyAmount(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return "";
    return v.toFixed(2);
  }

  function venmoPayUrl(opts) {
    var handle = venmoHandle(opts && opts.handle);
    var amount = moneyAmount(opts && opts.amount);
    if (!handle || !amount) return "";
    var note = String((opts && opts.note) || "").replace(/\s+/g, " ").trim().slice(0, 200);
    var params = new URLSearchParams();
    params.set("txn", "pay");
    params.set("recipients", handle);
    params.set("amount", amount);
    if (note) params.set("note", note);
    return "https://venmo.com/?" + params.toString();
  }

  function stripePayUrl(raw) {
    var text = String(raw || "").trim();
    if (!text) return "";
    var url;
    try { url = new URL(text); } catch (e) { return ""; }
    if (url.protocol !== "https:") return "";
    var host = url.hostname.toLowerCase();
    if (host !== "buy.stripe.com" && host !== "pay.stripe.com") return "";
    if (!url.pathname || url.pathname === "/") return "";
    return url.toString();
  }

  function payNote(packName, clientName) {
    var pack = String(packName || "Training package").replace(/\s+/g, " ").trim();
    var who = String(clientName || "").trim().split(/\s+/)[0] || "";
    var note = who ? pack + " for " + who : pack;
    return note.slice(0, 200);
  }

  function textBody(clientName, packName, url) {
    var first = String(clientName || "").trim().split(/\s+/)[0] || "there";
    return "Hi " + first + ", here is the link to pay for " + (packName || "your package") + ": " + url;
  }

  return {
    venmoHandle: venmoHandle,
    venmoPayUrl: venmoPayUrl,
    stripePayUrl: stripePayUrl,
    payNote: payNote,
    textBody: textBody
  };
});
