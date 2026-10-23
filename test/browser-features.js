/* Headless checks for check-ins, pay links, and the public booking page.
   Run: node test/browser-features.js
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
    if (rel.indexOf("/book/") === 0 && rel !== "/book.html") rel = "/book.html";
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
window.supabase = { createClient: function(){
  function resultFor(b){
    window.__sbCalls.push({ table: b.table, op: b.op, payload: b.payload });
    if(b.table==="payments") return { data: [], error: null };
    if(b.table==="booking_requests"){
      if(window.__bookingError) return { data: null, error: window.__bookingError };
      if(b.op==="select") return { data: window.__bookingRows || [], error: null };
    }
    if(b.op==="update" || b.op==="insert") return { data: [{ updated_at: "2026-10-23T20:00:00+00:00" }], error: null };
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
      order: function(){ return api; },
      limit: function(){ return api; },
      maybeSingle: function(){ return Promise.resolve(resultFor(b)); },
      then: function(ok, bad){ return Promise.resolve(resultFor(b)).then(ok, bad); }
    };
    return api;
  }
  return {
    auth: {
      getSession: async function(){ return { data: { session: window.__session || null } }; },
      signOut: async function(){ return {}; },
      onAuthStateChange: function(){ return { data: { subscription: { unsubscribe: function(){} } } }; }
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
    profile: { state: "CA", filingStatus: "single", businessType: "sole_prop", annualIncome: 78000, noShowBurns: false, sessionLength: 60 },
    packageTypes: [{ id: "pt1", name: "10-Session Strength", sessions: 10, price: 750 }],
    clients: [
      { id: "c1", name: "Maya Chen", phone: "(415) 555-0142", email: "maya@example.com", status: "active" },
      { id: "c2", name: "Devon Brooks", phone: "", email: "devon@example.com", status: "active" }
    ],
    sales: [{ id: "s1", clientId: "c1", packageTypeId: "pt1", sessionsPurchased: 10, pricePaid: 750, paid: false, paymentMethod: "", soldAt: "2026-10-01", taxSetAside: 0 }],
    sessions: [
      { id: "a", clientId: "c1", saleId: "s1", datetime: "2026-10-23T07:00", duration: 60, status: "completed", sessionNumber: 1, type: "In-person" },
      { id: "b", clientId: "c2", saleId: null, datetime: "2026-10-23T09:00", duration: 60, status: "completed", sessionNumber: 1, type: "In-person" },
      { id: "c", clientId: "c1", saleId: "s1", datetime: "2026-10-27T07:00", duration: 60, status: "scheduled", sessionNumber: 2, type: "In-person" }
    ],
    expenses: [], taxPayments: [], recurringExpenses: [], recurringSessions: [], events: []
  }
};

const REQUESTS = [
  { id: "req-1", client_name: "Sam Lee", client_phone: "(415) 555-0199", client_email: "sam@example.com", slot_start: "2026-10-24T11:00", duration_min: 60, note: "Mornings are best", status: "pending", created_at: "2026-10-23T18:00:00Z" },
  { id: "req-2", client_name: "Riley Quinn", client_phone: "", client_email: "", slot_start: "2026-10-24T12:00", duration_min: 60, note: "", status: "pending", created_at: "2026-10-23T18:05:00Z" }
];

async function clickLabel(page, text) {
  const clicked = await page.evaluate(function (label) {
    const sheet = document.getElementById("sheet");
    const root = sheet && sheet.classList.contains("show") ? document.getElementById("sheet-body") : document.getElementById("screen-home");
    const nodes = Array.from(root.querySelectorAll("button, a"));
    const el = nodes.find(function (n) { return n.textContent.trim() === label; });
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, text);
  if (!clicked) throw new Error("could not click " + text);
}

async function bootApp(browser, url, extra) {
  const page = await browser.newPage();
  const errors = [];
  const urls = [];
  page.on("pageerror", function (err) { errors.push(String(err)); });
  page.on("request", function (req) { urls.push(req.url()); });
  await page.emulateTimezone("UTC");
  await page.setRequestInterception(true);
  page.on("request", function (req) {
    const reqUrl = req.url();
    if (reqUrl.indexOf("supabase") !== -1 || reqUrl.indexOf("jsdelivr") !== -1 || reqUrl.indexOf("fonts.googleapis") !== -1 || reqUrl.indexOf("fonts.gstatic") !== -1) {
      if (reqUrl.indexOf("supabase-js") !== -1) req.respond({ status: 200, contentType: "text/javascript", body: MOCK });
      else req.respond({ status: 204, body: "" });
      return;
    }
    if (reqUrl.indexOf("/api/") !== -1) { req.respond({ status: 200, contentType: "application/json", body: "{}" }); return; }
    req.continue();
  });
  await page.evaluateOnNewDocument(function (row, sess, requests, bookingError) {
    const fixed =  Date.parse("2026-10-23T20:00:00Z");
    const Real = Date;
    function Fake() {
      if (!(this instanceof Fake)) return arguments.length ? Real.apply(null, arguments) : new Real(fixed);
      if (arguments.length === 0) return new Real(fixed);
      return new (Function.prototype.bind.apply(Real, [null].concat([].slice.call(arguments))))();
    }
    Fake.UTC = Real.UTC;
    Fake.parse = Real.parse;
    Fake.now = function () { return fixed; };
    Fake.prototype = Real.prototype;
    window.Date = Fake;
    window.__cloudRow = row;
    window.__session = sess;
    window.__bookingRows = requests;
    window.__bookingError = bookingError;
  }, extra.cloud, extra.session, extra.requests, extra.bookingError || null);
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
  return { page: page, errors: errors, urls: urls };
}

async function bootBook(browser, url, apiBody, status) {
  const page = await browser.newPage();
  const errors = [];
  const posts = [];
  page.on("pageerror", function (err) { errors.push(String(err)); });
  await page.setRequestInterception(true);
  page.on("request", function (req) {
    const reqUrl = req.url();
    if (reqUrl.indexOf("fonts.googleapis") !== -1 || reqUrl.indexOf("fonts.gstatic") !== -1) {
      req.respond({ status: 204, body: "" }); return;
    }
    if (reqUrl.indexOf("/api/book") !== -1) {
      if (req.method() === "POST") posts.push(req.postData());
      req.respond({ status: status || 200, contentType: "application/json", body: JSON.stringify(apiBody) });
      return;
    }
    req.continue();
  });
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
  return { page: page, errors: errors, posts: posts };
}

async function main() {
  const server = await startServer();
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const problems = [];
  function check(cond, msg) { if (!cond) problems.push(msg); else console.log("ok", msg); }

  try {
    const app = await bootApp(browser, base + "/", {
      cloud: CLOUD,
      session: { user: { id: "trainer-1", email: "justin@example.com" } },
      requests: REQUESTS
    });
    check(app.errors.length === 0, "app has no script errors: " + app.errors.join(" | "));
    await app.page.waitForSelector("#checkins");
    await app.page.waitForSelector("#session-requests");
    const checkins = await app.page.evaluate(function () {
      const box = document.getElementById("screen-home");
      return {
        text: box.innerText,
        maya: (document.getElementById("ci-c1") || {}).value,
        devon: (document.getElementById("ci-c2") || {}).value,
        href: (document.getElementById("ci-sms-c1") || {}).getAttribute && document.getElementById("ci-sms-c1").getAttribute("href"),
        devonLink: !!document.getElementById("ci-sms-c2")
      };
    });
    check(checkins.text.indexOf("Check-ins open after") === -1, "check-ins are open after the last session");
    check(checkins.text.indexOf("Nothing is sent until you tap Copy") !== -1, "check-ins say nothing is sent");
    check(checkins.maya.indexOf("Hey Maya") === 0, "Maya gets a draft");
    check(checkins.maya.indexOf("Tuesday at 7am") !== -1, "draft names the next session");
    check(checkins.devon.indexOf("Devon") !== -1, "Devon gets a draft");
    check(checkins.devonLink === false, "a client with no phone has no messages link");
    check(checkins.href.indexOf("sms:+14155550142") === 0, "messages link is an sms url");

    await app.page.focus("#ci-c1");
    await app.page.type("#ci-c1", " Extra note");
    const edited = await app.page.evaluate(function () {
      return {
        value: document.getElementById("ci-c1").value,
        href: document.getElementById("ci-sms-c1").getAttribute("href"),
        saved: state.checkins["2026-10-23"].c1.message
      };
    });
    check(edited.value.indexOf("Extra note") !== -1, "the draft stays editable");
    check(decodeURIComponent(edited.href).indexOf("Extra note") !== -1, "the messages link follows the edited draft");
    check(edited.saved.indexOf("Extra note") !== -1, "the edited draft is saved");
    await clickLabel(app.page, "Copy");
    await app.page.waitForFunction(function () {
      const box = document.getElementById("checkins").parentElement;
      return box.innerText.indexOf("Copied") !== -1;
    });
    check(true, "copy confirms without leaving the page");
    const sent = app.urls.filter(function (u) { return /twilio|messages\.google|api\.twilio/i.test(u); });
    check(sent.length === 0, "check-ins do not send a text");

    await app.page.click("button[onclick='openSettings()']");
    await clickLabel(app.page, "Pay links");
    await app.page.waitForSelector("#pay-venmo");
    await app.page.type("#pay-venmo", "Justin-T");
    await clickLabel(app.page, "Save");
    await app.page.waitForFunction(function () { return document.getElementById("sheet-body").innerText.indexOf("Pay links") !== -1 && document.getElementById("pay-venmo") === null; });
    const handle = await app.page.evaluate(function () { return state.profile.venmoHandle; });
    check(handle === "Justin-T", "venmo handle is saved in settings");
    await app.page.evaluate(function () { openUnpaid(); });
    await clickLabel(app.page, "Send pay link");
    const pay = await app.page.evaluate(function () {
      const text = document.getElementById("sheet-body").innerText;
      const link = document.querySelector("#sheet-body a");
      return { text: text, href: link ? link.getAttribute("href") : "", paid: state.sales[0].paid };
    });
    check(pay.text.indexOf("venmo.com") !== -1, "pay sheet shows a venmo link");
    check(pay.text.indexOf("750.00") !== -1, "venmo link includes the pack amount");
    check(pay.text.indexOf("Marking the pack paid stays manual") !== -1, "pay sheet does not mark the pack paid");
    check(pay.paid === false, "opening a pay link leaves the pack unpaid");
    check(pay.href.indexOf("sms:") === 0, "pay link can be opened in messages by the trainer");
    await clickLabel(app.page, "Back");
    const stillUnpaid = await app.page.evaluate(function () { return document.getElementById("sheet-body").innerText.indexOf("Mark paid") !== -1; });
    check(stillUnpaid, "mark paid stays a separate action");

    await app.page.evaluate(function () { closeSheet(); switchTab("home"); });
    await clickLabel(app.page, "Approve");
    await app.page.waitForFunction(function () {
      return state.clients.some(function (c) { return c.name === "Sam Lee"; }) && document.getElementById("screen-home").innerText.indexOf("Sam Lee") === -1;
    });
    const approved = await app.page.evaluate(function () {
      const sam = state.clients.find(function (c) { return c.name === "Sam Lee"; });
      const session = state.sessions.find(function (s) { return sam && s.clientId === sam.id; });
      const update = window.__sbCalls.filter(function (c) { return c.table === "booking_requests" && c.op === "update"; }).pop();
      return { session: session && session.datetime, status: update && update.payload.status, note: session && session.notes };
    });
    check(approved.session === "2026-10-24T11:00", "approving a request adds the session");
    check(approved.status === "approved", "approve updates the request status");
    check(approved.note.indexOf("Booked online") !== -1, "the request note stays on the session");
    const homeAfter = await app.page.evaluate(function () { return document.getElementById("screen-home").innerText; });
    check(homeAfter.indexOf("Riley Quinn") !== -1, "the other request stays pending");
    await clickLabel(app.page, "Decline");
    await app.page.waitForFunction(function () { return document.getElementById("session-requests") === null; });
    const declined = await app.page.evaluate(function () {
      const updates = window.__sbCalls.filter(function (c) { return c.table === "booking_requests" && c.op === "update"; });
      return updates[updates.length - 1].payload.status;
    });
    check(declined === "declined", "decline does not create a session and records declined");
    const rileySessions = await app.page.evaluate(function () {
      return state.clients.some(function (c) { return c.name === "Riley Quinn"; });
    });
    check(rileySessions === false, "declining does not add a client");
    await app.page.close();

    const closed = await bootApp(browser, base + "/", {
      cloud: CLOUD,
      session: { user: { id: "trainer-1", email: "justin@example.com" } },
      requests: [],
      bookingError: { message: "booking_requests does not exist" }
    });
    check(closed.errors.length === 0, "missing booking table does not crash the app: " + closed.errors.join(" | "));
    await closed.page.waitForSelector("#screen-home .lg-title");
    await closed.page.evaluate(function () { openBookingSettings(); });
    const note = await closed.page.evaluate(function () { return document.getElementById("sheet-body").innerText; });
    check(note.indexOf("one-time database update") !== -1, "booking settings explain the missing database update");
    check(note.indexOf("still save") !== -1, "booking settings can still be saved");
    await closed.page.type("#bk-slug", "justin");
    await closed.page.evaluate(function () { document.getElementById("bk-name").value = "Justin"; });
    await clickLabel(closed.page, "Save booking link");
    const savedBooking = await closed.page.evaluate(function () { return state.profile.booking; });
    check(savedBooking.slug === "justin" && savedBooking.enabled === false, "a booking link saves while requests are unavailable");
    await closed.page.close();

    const book = await bootBook(browser, base + "/book/justin", {
      ok: true, trainerName: "Justin", sessionMinutes: 60, timezone: "America/Los_Angeles", closed: false,
      slots: ["2026-10-24T09:00", "2026-10-24T10:00"]
    }, 200);
    check(book.errors.length === 0, "booking page has no script errors: " + book.errors.join(" | "));
    await book.page.waitForSelector(".slot");
    const names = await book.page.evaluate(function () { return document.body.innerText; });
    check(names.indexOf("Secret") === -1 && names.indexOf("Maya") === -1, "public booking page does not show client names");
    await book.page.click(".slot");
    await book.page.type("input[name=name]", "Alex Rivera");
    await book.page.type("input[name=phone]", "4155550100");
    await book.page.click("button.send");
    await book.page.waitForFunction(function () { return document.getElementById("ok").style.display === "block"; });
    const sentText = await book.page.$eval("#ok", function (el) { return el.textContent; });
    check(sentText.indexOf("Nothing else was sent") !== -1, "a booking request tells the client nothing else was sent");
    const posted = JSON.parse(book.posts[0] || "{}");
    check(posted.slug === "justin" && posted.name === "Alex Rivera" && posted.start === "2026-10-24T09:00", "the request posts the chosen slot");
    check(posted.trainerUid === undefined, "the public page does not send a trainer id");
    await book.page.close();

    const unavailable = await bootBook(browser, base + "/book.html?slug=justin", { error: "booking_unavailable" }, 503);
    await unavailable.page.waitForFunction(function () { return document.body.innerText.indexOf("Online booking is not open yet") !== -1; });
    check(true, "public booking stays quiet until the database update exists");
    await unavailable.page.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (problems.length) {
    console.error("FAILED");
    problems.forEach(function (p) { console.error(" - " + p); });
    process.exit(1);
  }
  console.log("browser feature checks passed");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
