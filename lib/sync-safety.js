/* Sync guards for the single app_state document.
   A device may save only if it still has the version it loaded.
   Empty local data never replaces a non-empty cloud row unless the
   trainer confirmed a wipe. Conflicts merge by id instead of clobbering. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FitrmSync = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var ARRAY_KEYS = ["packageTypes", "clients", "sales", "sessions", "expenses", "taxPayments", "recurringExpenses", "recurringSessions", "events"];

  function businessIsEmpty(s) {
    if (!s || typeof s !== "object") return true;
    for (var i = 0; i < ARRAY_KEYS.length; i++) {
      var arr = s[ARRAY_KEYS[i]];
      if (Array.isArray(arr) && arr.length) return false;
    }
    return true;
  }

  function clone(o) {
    return o == null ? o : JSON.parse(JSON.stringify(o));
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function byId(arr) {
    var m = new Map();
    (arr || []).forEach(function (item) {
      if (item && item.id != null) m.set(String(item.id), item);
    });
    return m;
  }

  function mergeFields(base, local, remote) {
    var out = Object.assign({}, remote || {});
    var keys = new Set(Object.keys(base || {}).concat(Object.keys(local || {}), Object.keys(remote || {})));
    keys.forEach(function (k) {
      var B = base ? base[k] : undefined;
      var L = local ? local[k] : undefined;
      var R = remote ? remote[k] : undefined;
      var localChanged = !same(L, B);
      var remoteChanged = !same(R, B);
      if (localChanged && !remoteChanged) out[k] = L;
      else out[k] = R;
    });
    return out;
  }

  function mergeArray(baseArr, localArr, remoteArr) {
    var b = byId(baseArr), l = byId(localArr), r = byId(remoteArr);
    var ids = new Set([].concat(Array.from(b.keys()), Array.from(l.keys()), Array.from(r.keys())));
    var out = [];
    ids.forEach(function (id) {
      var B = b.get(id), L = l.get(id), R = r.get(id);
      if (L === undefined && R === undefined) return;
      if (L === undefined && B !== undefined && R !== undefined && same(R, B)) return;
      if (R === undefined && B !== undefined && L !== undefined && same(L, B)) return;
      if (L === undefined && B === undefined) { out.push(clone(R)); return; }
      if (R === undefined && B === undefined) { out.push(clone(L)); return; }
      if (L === undefined) { out.push(clone(R)); return; }
      if (R === undefined) { out.push(clone(L)); return; }
      var localChanged = !same(L, B);
      var remoteChanged = !same(R, B);
      if (localChanged && !remoteChanged) out.push(clone(L));
      else if (remoteChanged && !localChanged) out.push(clone(R));
      else if (!localChanged && !remoteChanged) out.push(clone(R));
      else out.push(mergeFields(B || {}, L, R));
    });
    return out;
  }

  function mergeAppState(base, local, remote) {
    var b = base || {};
    var out = clone(remote || {}) || {};
    ARRAY_KEYS.forEach(function (k) {
      out[k] = mergeArray(b[k], (local || {})[k], (remote || {})[k]);
    });
    out.profile = mergeFields(b.profile || {}, (local || {}).profile || {}, (remote || {}).profile || {});
    if (remote && remote.syncVersion != null) out.syncVersion = remote.syncVersion;
    else delete out.syncVersion;
    return out;
  }

  /* Add records that exist only on this device. Never deletes or overwrites. */
  function unionAdd(current, extra) {
    var out = clone(current || {}) || {};
    ARRAY_KEYS.forEach(function (k) {
      var have = byId(out[k]);
      var add = [];
      (extra && extra[k] || []).forEach(function (item) {
        if (!item || item.id == null) return;
        if (!have.has(String(item.id))) add.push(clone(item));
      });
      out[k] = (out[k] || []).concat(add);
    });
    return out;
  }

  function planLoad(opts) {
    var local = opts.local || null;
    var remote = opts.remote || null;
    var base = opts.base || null;
    if (opts.loadError) {
      return { action: "hold", state: local, push: false, reason: "load-failed" };
    }
    if (!remote) {
      if (local && !businessIsEmpty(local)) return { action: "push-local", state: local, push: true, reason: "no-cloud-row" };
      return { action: "use-local", state: local, push: false, reason: "no-cloud-row" };
    }
    if ((!local || businessIsEmpty(local)) && !businessIsEmpty(remote)) {
      return { action: "use-remote", state: remote, push: false, reason: "empty-local" };
    }
    if (!opts.pending || !local) {
      return { action: "use-remote", state: remote, push: false, reason: "cloud-wins" };
    }
    if (!base) {
      return { action: "use-remote", state: remote, push: false, reason: "no-base", stashLocal: true };
    }
    var remoteVersion = Number(remote.syncVersion) || 0;
    var baseVersion = Number(base.syncVersion) || 0;
    if (remoteVersion === baseVersion) {
      return { action: "push-local", state: local, push: true, reason: "pending-no-conflict" };
    }
    if (businessIsEmpty(local)) {
      return { action: "use-remote", state: remote, push: false, reason: "empty-local" };
    }
    return { action: "merge", state: mergeAppState(base, local, remote), push: true, reason: "merged" };
  }

  function planPush(opts) {
    var local = opts.local;
    var remote = opts.remote || null;
    if (!local) return { action: "skip", reason: "no-local" };
    var remoteVersion = remote && remote.syncVersion ? Number(remote.syncVersion) : 0;
    var base = Number(opts.baseVersion) || 0;
    var versionStale = !!(remote && base !== remoteVersion);
    var legacyStampMoved = !!(remote && base === 0 && remoteVersion === 0
      && opts.baseUpdatedAt && opts.remoteUpdatedAt
      && String(opts.baseUpdatedAt) !== String(opts.remoteUpdatedAt));
    var stale = versionStale || legacyStampMoved;
    var localEmpty = businessIsEmpty(local);
    var remoteHasData = !!(remote && !businessIsEmpty(remote));
    if (localEmpty && remoteHasData && !opts.allowEmptyPush) {
      return { action: "refuse", state: remote, reason: "empty-over-data" };
    }
    if (stale && (opts.fullReplace || (localEmpty && remoteHasData))) {
      return { action: "refuse", state: remote, reason: "stale-replace" };
    }
    if (stale) return { action: "conflict", reason: "stale" };
    if (!remote) return { action: "insert", reason: "new-row" };
    return { action: "update", reason: "ok" };
  }

  return {
    ARRAY_KEYS: ARRAY_KEYS,
    businessIsEmpty: businessIsEmpty,
    mergeAppState: mergeAppState,
    unionAdd: unionAdd,
    planLoad: planLoad,
    planPush: planPush
  };
});
