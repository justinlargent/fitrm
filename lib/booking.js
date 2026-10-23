/* Open booking slots and request checks.
   Public output is free times only. Client names never leave this module's public view. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FitrmBooking = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function pad(n) { return String(n).padStart(2, "0"); }

  function addMinutes(stamp, mins) {
    var m = String(stamp || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return String(stamp || "");
    var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + (mins || 0)));
    return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate())
      + "T" + pad(dt.getUTCHours()) + ":" + pad(dt.getUTCMinutes());
  }

  function addCalendarDays(ymd, n) {
    var p = String(ymd || "").split("-").map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate());
  }

  function weekdayIndex(ymd) {
    var p = String(ymd || "").split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }

  function zonedParts(date, timeZone) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
    });
    var parts = {};
    fmt.formatToParts(date).forEach(function (p) { if (p.type !== "literal") parts[p.type] = p.value; });
    if (parts.hour === "24") parts.hour = "00";
    return parts;
  }

  function nowStamp(date, timeZone) {
    var p = zonedParts(date, timeZone);
    return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute;
  }

  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  function busyRanges(state, pending) {
    var out = [];
    (state.sessions || []).forEach(function (s) {
      if (!s || !s.datetime || s.status === "cancelled") return;
      var start = s.datetime.slice(0, 16);
      out.push({ start: start, end: addMinutes(start, s.duration || 60) });
    });
    (state.events || []).forEach(function (e) {
      if (!e || !e.date) return;
      var start = e.date + "T" + String(e.time || "00:00").slice(0, 5);
      out.push({ start: start, end: addMinutes(start, e.duration || 60) });
    });
    (pending || []).forEach(function (r) {
      if (!r || !r.slot_start || r.status === "declined") return;
      var start = String(r.slot_start).slice(0, 16);
      out.push({ start: start, end: addMinutes(start, r.duration_min || 60) });
    });
    return out;
  }

  function bookableHours(state) {
    var profile = (state && state.profile) || {};
    var booking = profile.booking || {};
    if (booking.useWorkingHours === false && booking.hours) return booking.hours;
    return profile.workingHours || booking.hours || null;
  }

  function openSlots(opts) {
    opts = opts || {};
    var hours = opts.hours || {};
    var len = opts.sessionMinutes || 60;
    if (len < 15) len = 15;
    if (len > 180) len = 180;
    var timeZone = opts.timeZone || "UTC";
    var now = opts.now || new Date();
    var days = opts.days || 14;
    var busy = opts.busy || [];
    var today = nowStamp(now, timeZone).slice(0, 10);
    var nowS = nowStamp(now, timeZone);
    var out = [];
    for (var i = 0; i < days; i++) {
      var date = addCalendarDays(today, i);
      var dow = weekdayIndex(date);
      var day = hours[dow] != null ? hours[dow] : hours[String(dow)];
      if (!day || !day.on) continue;
      (day.blocks || []).forEach(function (block) {
        if (!block || !block.start || !block.end) return;
        var cursor = date + "T" + String(block.start).slice(0, 5);
        var end = date + "T" + String(block.end).slice(0, 5);
        var guard = 0;
        while (cursor < end && guard++ < 64) {
          var slotEnd = addMinutes(cursor, len);
          if (slotEnd > end) break;
          var taken = busy.some(function (b) { return overlaps(cursor, slotEnd, b.start, b.end); });
          if (cursor > nowS && !taken) out.push(cursor);
          cursor = slotEnd;
        }
      });
    }
    return out;
  }

  function publicName(state) {
    var booking = state && state.profile && state.profile.booking;
    var name = booking && booking.publicName ? String(booking.publicName).trim() : "";
    return (name || "Your trainer").slice(0, 80);
  }

  function publicView(state, pending, now) {
    var profile = (state && state.profile) || {};
    var booking = profile.booking || {};
    var timeZone = booking.timezone || "UTC";
    var minutes = profile.sessionLength || 60;
    var enabled = !!booking.enabled && !!normalizeSlug(booking.slug);
    var slots = enabled ? openSlots({
      hours: bookableHours(state) || {},
      sessionMinutes: minutes,
      busy: busyRanges(state, pending),
      now: now || new Date(),
      timeZone: timeZone,
      days: 14
    }) : [];
    return {
      trainerName: publicName(state),
      sessionMinutes: minutes,
      timezone: timeZone,
      enabled: enabled,
      slots: slots
    };
  }

  function normalizeSlug(raw) {
    var s = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    if (s.length < 3 || s.length > 40) return "";
    return s;
  }

  function validateRequest(body) {
    body = body || {};
    if (String(body.company || body.website || "").trim()) return { ok: false, error: "Could not send that request." };
    var name = String(body.name || "").trim();
    if (name.length < 1 || name.length > 80) return { ok: false, error: "Enter your name." };
    var phone = String(body.phone || "").trim();
    if (phone.length > 40) return { ok: false, error: "That phone number is too long." };
    var email = String(body.email || "").trim();
    if (email.length > 120) return { ok: false, error: "That email is too long." };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email does not look right." };
    var start = String(body.start || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start)) return { ok: false, error: "Pick an open time." };
    var note = String(body.note || "").trim().slice(0, 280);
    return { ok: true, name: name, phone: phone, email: email, start: start, note: note };
  }

  function rateDecision(recentCount, burstCount) {
    if (burstCount >= 3) return { ok: false, error: "Too many requests. Try again in a few minutes." };
    if (recentCount >= 8) return { ok: false, error: "Too many requests. Try again later." };
    return { ok: true };
  }

  return {
    addMinutes: addMinutes,
    addCalendarDays: addCalendarDays,
    weekdayIndex: weekdayIndex,
    nowStamp: nowStamp,
    busyRanges: busyRanges,
    bookableHours: bookableHours,
    openSlots: openSlots,
    publicView: publicView,
    normalizeSlug: normalizeSlug,
    validateRequest: validateRequest,
    rateDecision: rateDecision
  };
});
