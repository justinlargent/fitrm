/* Headless checks for the safety fixes. Uses the system Chrome via puppeteer-core.
   Run: node test/browser-safety.js
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/usr/local/bin/google-chrome";

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  return "text/plain";
}

function startServer() {
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("missing"); return;
    }
    res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(function (resolve) {
    server.listen(0, "127.0.0.1", function () { resolve(server); });
  });
}

const MOCK = `
window.__sbCalls = [];
window.__reset = null;
window.supabase = { createClient: function(){
  function resultFor(b){
    window.__sbCalls.push({ table: b.table, op: b.op, payload: b.payload });
    if(b.table==="payments") return { data: [], error: null };
    if(b.op==="update" || b.op==="insert") return { data: [{ updated_at: "2026-10-23T12:00:00+00:00" }], error: null };
    if(b.table==="app_state") return { data: window.__cloudRow, error: null };
    return { data: null, error: null };
  }
  function builder(table){
    var b = { table: table, op: "select", payload: null };
    var api = {
      select: function(){ return api; },
      insert: function(p){ b.op="insert"; b.payload=p; return api; },
      update: function(p){ b.op="update"; b.payload=p; return api; },
      eq: function(){ return api; },
      maybeSingle: function(){ return Promise.resolve(resultFor(b)); },
      then: function(ok, bad){ return Promise.resolve(resultFor(b)).then(ok, bad); }
    };
    return api;
  }
  return {
    auth: {
      signUp: async function(){ return { data: { session: null, user: null }, error: null }; },
      signInWithPassword: async function(){ return { data: null, error: { message: "Invalid login credentials" } }; },
      resetPasswordForEmail: async function(email, opts){ window.__reset = { email: email, opts: opts }; return { error: null }; },
      updateUser: async function(){ return { error: null }; },
      resend: async function(){ window.__resent = true; return { error: null }; },
      getSession: async function(){ return { data: { session: window.__session || null } }; },
      signOut: async function(){ return {}; },
      onAuthStateChange: function(cb){ window.__authCb = cb; return { data: { subscription: { unsubscribe: function(){} } } }; }
    },
    from: builder
  };
}};
`;

const CLOUD = {
  syncVersion: 2,
  updated_at: "2026-10-20T00:00:00+00:00",
  data: {
    syncVersion: 2,
    profile: { state: "CA", filingStatus: "single", businessType: "sole_prop", annualIncome: 78000, noShowBurns: false },
    packageTypes: [{ id: "pt1", name: "10-Session Strength", sessions: 10, price: 750 }],
    clients: [{ id: "c1", name: "Maya Chen", phone: "(415) 555-0142", email: "maya@example.com", status: "active" }],
    sales: [], sessions: [], expenses: [], taxPayments: [], recurringExpenses: [], recurringSessions: [], events: []
  }
};

async function boot(browser, pathAndQuery, session) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", function (err) { errors.push(String(err)); });
  await page.setRequestInterception(true);
  page.on("request", function (req) {
    const url = req.url();
    if (url.indexOf("supabase") !== -1 || url.indexOf("jsdelivr") !== -1 || url.indexOf("fonts.googleapis") !== -1 || url.indexOf("fonts.gstatic") !== -1) {
      if (url.indexOf("supabase-js") !== -1) req.respond({ status: 200, contentType: "text/javascript", body: MOCK });
      else req.respond({ status: 204, body: "" });
      return;
    }
    if (url.indexOf("/api/") !== -1) { req.respond({ status: 200, contentType: "application/json", body: "{}" }); return; }
    req.continue();
  });
  await page.evaluateOnNewDocument(function (row, sess) {
    window.__cloudRow = row;
    window.__session = sess;
  }, session ? CLOUD : null, session);
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(pathAndQuery, { waitUntil: "networkidle0", timeout: 20000 });
  await new Promise(function (r) { setTimeout(r, 150); });
  return { page: page, errors: errors };
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const problems = [];
  function check(cond, msg) { if (!cond) problems.push(msg); else console.log("ok", msg); }

  try {
    const signup = await boot(browser, base + "/", null);
    check(signup.errors.length === 0, "signup page has no script errors: " + signup.errors.join(" | "));
    await signup.page.click("a.navcta");
    await signup.page.waitForSelector("#au-name", { visible: true });
    await signup.page.type("#au-name", "Jordan Lee");
    await signup.page.type("#au-email", "jordan@example.com");
    await signup.page.type("#au-pass", "correct-horse");
    await signup.page.click("#au-submit");
    await signup.page.waitForFunction(function () {
      const msg = document.getElementById("auth-msg");
      return msg && msg.style.display === "block" && msg.textContent.indexOf("jordan@example.com") !== -1;
    });
    const afterSignup = await signup.page.evaluate(function () {
      return {
        msg: document.getElementById("auth-msg").textContent,
        shown: document.getElementById("auth-msg").style.display,
        button: document.getElementById("au-submit").textContent,
        forgot: document.getElementById("auth-forgot").style.display
      };
    });
    check(afterSignup.shown === "block", "confirmation stays on screen");
    check(afterSignup.msg.indexOf("jordan@example.com") !== -1, "confirmation names the email");
    check(afterSignup.button === "Log in", "form switches to log in after the message is set");
    check(afterSignup.forgot !== "none", "forgot password is available on the login form");
    await signup.page.click("#auth-msg button");
    await signup.page.waitForFunction(function () { return window.__resent === true; });
    check(true, "resend email calls supabase");

    await signup.page.evaluate(function () { showForgot(); });
    await signup.page.waitForFunction(function () { return document.getElementById("au-submit").textContent === "Send reset link"; });
    const passHidden = await signup.page.$eval("#pass-fld", function (el) { return el.style.display === "none"; });
    check(passHidden, "forgot password hides the password field");
    await signup.page.click("#au-submit");
    await signup.page.waitForFunction(function () { return window.__reset && window.__reset.email === "jordan@example.com"; });
    const reset = await signup.page.evaluate(function () { return window.__reset; });
    check(/\/\?reset=1$/.test(reset.opts.redirectTo), "reset link returns to /?reset=1 (" + reset.opts.redirectTo + ")");
    const resetMsg = await signup.page.$eval("#auth-msg", function (el) { return el.style.display + " " + el.textContent; });
    check(resetMsg.indexOf("block") === 0 && resetMsg.indexOf("jordan@example.com") !== -1, "reset confirmation stays on screen");
    await signup.page.close();

    const recover = await boot(browser, base + "/?reset=1#type=recovery", null);
    check(recover.errors.length === 0, "recovery page has no script errors: " + recover.errors.join(" | "));
    const recoverUi = await recover.page.evaluate(function () {
      return {
        button: document.getElementById("au-submit").textContent,
        pass2: document.getElementById("pass2-fld").style.display,
        label: document.getElementById("pass-label").textContent,
        msg: document.getElementById("auth-msg").textContent,
        screen: document.getElementById("auth-screen").style.display
      };
    });
    check(recoverUi.screen === "flex", "recovery opens the password screen");
    check(recoverUi.button === "Save new password", "recovery button saves the new password");
    check(recoverUi.pass2 === "block", "recovery asks to confirm the password");
    check(recoverUi.label === "New password", "recovery labels the new password");
    check(recoverUi.msg.indexOf("Choose a new password") !== -1, "recovery explains itself");
    await recover.page.type("#au-pass", "newpassword");
    await recover.page.type("#au-pass2", "newpassword");
    await recover.page.click("#au-submit");
    await new Promise(function (r) { setTimeout(r, 100); });
    const expired = await recover.page.$eval("#auth-error", function (el) { return el.textContent; });
    check(expired.indexOf("expired") !== -1, "a reset link without a session does not silently succeed");
    await recover.page.close();

    const app = await boot(browser, base + "/", { user: { id: "user-1", email: "justin@example.com" } });
    check(app.errors.length === 0, "app has no script errors: " + app.errors.join(" | "));
    await app.page.waitForSelector("#screen-home .lg-title");
    const writesOnLoad = await app.page.evaluate(function () {
      return window.__sbCalls.filter(function (c) { return c.op === "update" || c.op === "insert"; });
    });
    check(writesOnLoad.length === 0, "opening an account with cloud data does not upload");
    const loadedName = await app.page.evaluate(function () { return state.clients[0] && state.clients[0].name; });
    check(loadedName === "Maya Chen", "cloud clients load instead of an empty business");
    await app.page.click("button[onclick='openSettings()']");
    await app.page.waitForFunction(function () { return document.getElementById("sheet-body").textContent.indexOf("Demo / reset data") !== -1; });
    await app.page.evaluate(function () { openDataMenu(); });
    await app.page.waitForFunction(function () { return document.getElementById("sheet-body").textContent.indexOf("Start empty") !== -1; });
    await app.page.evaluate(function () { openClearConfirm(); });
    await app.page.waitForSelector("#confirm-go");
    const before = await app.page.$eval("#confirm-go", function (el) { return el.disabled; });
    check(before === true, "erase stays disabled until DELETE is typed");
    await app.page.type("#confirm-text", "delete");
    const lower = await app.page.$eval("#confirm-go", function (el) { return el.disabled; });
    check(lower === true, "lowercase delete does not confirm");
    await app.page.$eval("#confirm-text", function (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await app.page.type("#confirm-text", "DELETE");
    const armed = await app.page.$eval("#confirm-go", function (el) { return el.disabled; });
    check(armed === false, "DELETE enables the erase button");
    const callsBefore = await app.page.evaluate(function () { return window.__sbCalls.length; });
    await app.page.$eval("#confirm-go", function (el) { el.scrollIntoView({ block: "center" }); el.click(); });
    await app.page.waitForFunction(function () {
      return window.__sbCalls.some(function (c) { return c.op === "update" || c.op === "insert"; });
    });
    const wipe = await app.page.evaluate(function () {
      return window.__sbCalls.filter(function (c) { return c.op === "update" || c.op === "insert"; }).pop();
    });
    check(wipe && wipe.payload && Array.isArray(wipe.payload.data.clients) && wipe.payload.data.clients.length === 0, "confirmed erase is the only empty upload");
    check(wipe.payload.data.syncVersion === 3, "erase bumps the sync version instead of a blind upsert");
    await app.page.waitForSelector("#undo-bar");
    const undo = await app.page.$eval("#undo-bar", function (el) { return el.textContent; });
    check(undo.indexOf("Undo") !== -1, "erase offers undo");
    const callsMid = await app.page.evaluate(function () { return window.__sbCalls.length; });
    check(callsMid > callsBefore, "erase wrote once");
    await app.page.close();

    const old = await boot(browser, base + "/index_appskin.html", null);
    await old.page.waitForFunction(function () { return location.pathname === "/"; });
    const oldHtml = await old.page.content();
    check(oldHtml.indexOf("createClient") !== -1, "old address lands on the current app");
    check(oldHtml.indexOf("app_state") !== -1, "old address is not the June app");
    await old.page.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (problems.length) {
    console.error("FAILED");
    problems.forEach(function (p) { console.error(" - " + p); });
    process.exit(1);
  }
  console.log("browser safety checks passed");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
