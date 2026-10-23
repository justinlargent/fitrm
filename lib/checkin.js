/* Draft check-in messages. Nothing here sends a text. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FitrmCheckin = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function pad(n) { return String(n).padStart(2, "0"); }

  function localStamp(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
      + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function addMinutes(stamp, mins) {
    var m = String(stamp || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return String(stamp || "");
    var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + (mins || 0)));
    return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate())
      + "T" + pad(dt.getUTCHours()) + ":" + pad(dt.getUTCMinutes());
  }

  function dayLabel(stamp) {
    var m = String(stamp || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return "";
    var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var hh = +m[4], mm = +m[5];
    var ap = hh >= 12 ? "pm" : "am";
    var h12 = hh % 12 || 12;
    var time = mm ? h12 + ":" + pad(mm) + ap : h12 + ap;
    return DAYS[dt.getUTCDay()] + " at " + time;
  }

  function phoneDigits(phone) {
    var raw = String(phone || "").trim();
    var hasPlus = raw.charAt(0) === "+";
    var digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    if (hasPlus) return "+" + digits;
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.charAt(0) === "1") return "+" + digits;
    return "+" + digits;
  }

  function smsHref(phone, body) {
    var n = phoneDigits(phone);
    if (!n) return "";
    return "sms:" + n + "?&body=" + encodeURIComponent(body || "");
  }

  function draftMessage(client, nextStamp) {
    var first = String((client && client.name) || "there").trim().split(/\s+/)[0] || "there";
    var msg = "Hey " + first + ", great work today.";
    if (nextStamp) msg += " See you " + dayLabel(nextStamp) + ".";
    else msg += " Tell me when you want the next one.";
    return msg;
  }

  function nextSessionStamp(state, clientId, today) {
    var best = "";
    (state.sessions || []).forEach(function (s) {
      if (s.clientId !== clientId || s.status !== "scheduled" || !s.datetime) return;
      var stamp = s.datetime.slice(0, 16);
      if (stamp.slice(0, 10) <= today) return;
      if (!best || stamp < best) best = stamp;
    });
    return best;
  }

  function plan(state, now) {
    now = now || new Date();
    var today = localStamp(now).slice(0, 10);
    var sessions = (state.sessions || []).filter(function (s) {
      return s.datetime && s.datetime.slice(0, 10) === today && s.status !== "cancelled";
    });
    if (!sessions.length) return { show: false, reason: "none", today: today, clients: [] };
    var lastEnd = "";
    sessions.forEach(function (s) {
      var end = addMinutes(s.datetime.slice(0, 16), s.duration || 60);
      if (end > lastEnd) lastEnd = end;
    });
    if (localStamp(now) < lastEnd) {
      return { show: false, reason: "waiting", today: today, opensAt: lastEnd, clients: [] };
    }
    var seen = {};
    var clients = [];
    sessions.slice().sort(function (a, b) { return a.datetime < b.datetime ? -1 : 1; }).forEach(function (s) {
      if (seen[s.clientId]) return;
      seen[s.clientId] = true;
      var client = (state.clients || []).find(function (c) { return c.id === s.clientId; });
      if (!client) return;
      var saved = state.checkins && state.checkins[today] && state.checkins[today][client.id];
      var next = nextSessionStamp(state, client.id, today);
      var message = saved && typeof saved.message === "string" ? saved.message : draftMessage(client, next);
      clients.push({
        clientId: client.id,
        name: client.name || "Client",
        phone: client.phone || "",
        message: message,
        done: !!(saved && saved.done)
      });
    });
    return { show: true, reason: "ready", today: today, clients: clients };
  }

  return {
    localStamp: localStamp,
    addMinutes: addMinutes,
    dayLabel: dayLabel,
    phoneDigits: phoneDigits,
    smsHref: smsHref,
    draftMessage: draftMessage,
    plan: plan
  };
});
