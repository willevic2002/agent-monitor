// Agent Monitor e2e runner: `node tests/e2e/run.mjs` (see README.md)
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../..");
const ART = join(HERE, "artifacts"); mkdirSync(ART, { recursive: true });
const FIX = n => join(ROOT, "tests/fixtures", n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });

async function startServer(fixture) {
  const port = await freePort(), tmp = mkdtempSync(join(tmpdir(), "am-e2e-"));
  const cfg = join(tmp, "cfg"), proj = join(tmp, "proj"), log = join(tmp, "stdin.log");
  mkdirSync(proj);
  const proc = spawn("python3", [join(ROOT, "server.py")], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), AM_CONFIG_DIR: cfg, AM_PROJECTS_DIR: proj, AM_CLAUDE: join(ROOT, "tests/fake_claude.py"),
      AM_FAKE_FIXTURE: FIX(fixture), AM_FAKE_DELAY: "0.01", AM_FAKE_STDIN_LOG: log },
  });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + "/"); break; } catch { if (i > 100) throw new Error("server did not start: " + out); await sleep(100); }
  }
  const token = readFileSync(join(cfg, "token"), "utf8").trim();
  return { proc, base, tmp, log, token, out: () => out };
}
async function stopServer(s) {
  if (!s) return;
  const pids = x => { try { return execFileSync("pgrep", x, { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return []; } };
  const kids = pids(["-P", String(s.proc.pid)]); // children of the server we started, not other fake_claude runs
  s.proc.kill("SIGTERM");
  await new Promise(r => { s.proc.on("exit", r); setTimeout(r, 3000); });
  if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
  await sleep(500);
  const alive = kids.filter(p => { try { process.kill(+p, 0); return true; } catch { return false; } });
  alive.forEach(p => { try { process.kill(+p, "SIGKILL"); } catch {} }); // clean up our own leak before failing
  assert.deepEqual(alive, [], "fake_claude.py child outlived the server");
}
async function nonce(s) {
  const r = await fetch(s.base + "/api/once", { method: "POST", headers: { "X-AM-Token": s.token, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 200, "/api/once");
  return (await r.json()).once;
}

// Watches a page; `expected(url,status)` whitelists deliberately provoked failures.
function watch(page, name, expected = () => false) {
  const bad = [];
  page.on("console", m => { if (m.type() === "error" && !/status of (401|403)/.test(m.text())) bad.push("console: " + m.text()); });
  page.on("pageerror", e => bad.push("pageerror: " + e.message));
  page.on("requestfailed", r => { if (!expected(r.url(), 0)) bad.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on("response", r => { if (r.status() >= 400 && !expected(r.url(), r.status())) bad.push(`http ${r.status()}: ${r.url()}`); });
  return () => assert.deepEqual(bad, [], `${name}: unexpected console/network errors`);
}

async function scenario(name, fixture, fn) {
  const t0 = Date.now(); let s, browser;
  try {
    s = await startServer(fixture);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
    await fn(s, browser);
    console.log(`  pass  ${name} (${Date.now() - t0}ms)`);
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(s);
  }
}
async function login(s, browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await ctx.newPage();
  const check = watch(page, "logged-in page");
  await page.goto(`${s.base}/login?once=${await nonce(s)}`);
  await page.getByTestId("new-session").waitFor();
  return { ctx, page, check };
}

async function scenarioM2(s, browser) {
  const { page, check } = await login(s, browser);
  const cwd = mkdtempSync(join(tmpdir(), "am-cwd-"));
  mkdirSync(join(cwd, ".claude/runtime"), { recursive: true });
  writeFileSync(join(cwd, ".claude/runtime/phase.json"), JSON.stringify({ phases: [{ name: "Build", status: "running", agents: ["general-purpose"] }] }));
  const text = "/cdt:orchestration liten uppgift";

  await page.getByTestId("new-session").click();
  await page.getByTestId("cwd").fill(cwd);
  await page.waitForFunction(() => !document.querySelector("[data-testid=prompt]").disabled);
  await page.getByRole("button", { name: "List" }).click();
  await page.getByTestId("prompt").fill(text);
  await page.getByTestId("prompt").press("Enter");

  await page.getByRole("button", { name: "List" }).click();
  await page.locator('[data-testid=chat-msg][data-role=user]').filter({ hasText: text }).first().waitFor();
  assert.equal((await page.locator('[data-testid=chat-msg][data-role=user]').first().innerText()).trim().replace(/^>\s*/, ""), text);
  assert.ok(await page.locator('[data-testid=session][data-kind=driven]').count() >= 1, "driven session in sidebar");

  const node = page.locator("[data-node]").first();
  await node.waitFor({ timeout: 15000 }).catch(async e => { console.error(await page.locator("#graph").innerHTML(), await page.locator("#chat").innerText()); throw e; });
  await page.waitForFunction(() => [...document.querySelectorAll("[data-node]")].some(b => /done/.test(b.textContent)), null, { timeout: 20000 });
  await page.locator('[data-testid=chat-msg][data-role=assistant]').first().waitFor();
  await page.locator('[data-testid=chat-msg][data-role=result]').first().waitFor();

  await page.getByTestId("prompt").focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.getByTestId("prompt").inputValue(), text, "ArrowUp restores sent prompt");

  assert.ok(existsSync(s.log) && readFileSync(s.log, "utf8").includes(text), "fake received prompt verbatim");
  await page.getByRole("button", { name: "Graph" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(ART, "m2.png") });
  check();
}

async function scenarioUnauth(s, browser) {
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const check = watch(page, "unauth", (u, st) => (st === 401 || st === 403) && /\/api\//.test(u));
  await page.goto(s.base + "/");
  await page.getByText("Invalid token").waitFor();
  assert.ok(await page.getByTestId("prompt").isDisabled(), "prompt disabled");
  const st = await page.evaluate(async () => (await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "x", cwd: "/tmp" }) })).status);
  assert.equal(st, 401);
  await page.screenshot({ path: join(ART, "unauth.png") });
  check();
}

async function scenarioForeignOrigin(s, browser) {
  const { ctx, page, check } = await login(s, browser);
  const cookie = (await ctx.cookies()).find(c => c.name === "am"); assert.ok(cookie, "am cookie");
  const body = JSON.stringify({ prompt: "pwned-prompt", cwd: tmpdir() });
  const r = await fetch(s.base + "/api/sessions", { method: "POST", headers: { Cookie: `am=${cookie.value}`, Origin: "http://evil.example", "Content-Type": "application/json" }, body });
  assert.equal(r.status, 403);
  assert.ok(!existsSync(s.log), "no fake stdin log => no session spawned");

  const evilPort = await freePort(), dir = mkdtempSync(join(tmpdir(), "am-evil-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>evil</title><script>
fetch("${s.base}/api/sessions",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:${JSON.stringify(body)}})
.then(r=>document.title="status:"+r.status,()=>document.title="failed");</script>`);
  const evil = spawn("python3", ["-m", "http.server", String(evilPort), "--bind", "127.0.0.1", "-d", dir], { stdio: "ignore" });
  try {
    for (let i = 0; ; i++) { try { await fetch(`http://127.0.0.1:${evilPort}/`); break; } catch { if (i > 50) throw new Error("evil server"); await sleep(100); } }
    const p2 = await ctx.newPage();
    const pe = []; p2.on("pageerror", e => pe.push(e.message)); // console CORS/favicon noise on the attacker page is expected
    await p2.goto(`http://127.0.0.1:${evilPort}/`);
    await p2.waitForFunction(() => /^(status:|failed)/.test(document.title));
    const t = await p2.title(); assert.ok(t === "failed" || t === "status:403" || t === "status:401", "cross-origin result: " + t);
    assert.deepEqual(pe, []);
  } finally { evil.kill("SIGTERM"); }
  const list = await (await fetch(s.base + "/api/sessions", { headers: { Cookie: `am=${cookie.value}` } })).json();
  assert.deepEqual(list, [], "no session created");
  assert.ok(!existsSync(s.log), "still no fake stdin log");
  check();
}

// ---- M3: permission flow ----
const stdin = s => existsSync(s.log) ? readFileSync(s.log, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : [];
const perms = s => stdin(s).filter(m => m.type === "control_response" && m.response?.response?.behavior);
const reqs = (s, sub) => stdin(s).filter(m => m.type === "control_request" && m.request?.subtype === sub);
const PROMPT = "/cdt:orchestration liten uppgift";

async function startDriven(s, browser) {
  const { ctx, page, check } = await login(s, browser);
  const cwd = mkdtempSync(join(tmpdir(), "am-cwd-"));
  await page.getByTestId("new-session").click();
  await page.getByTestId("cwd").fill(cwd);
  await page.waitForFunction(() => !document.querySelector("[data-testid=prompt]").disabled);
  await page.getByRole("button", { name: "List" }).click();
  await page.getByTestId("prompt").fill(PROMPT);
  await page.getByTestId("prompt").press("Enter");
  return { ctx, page, check };
}
const waitCard = async page => { const c = page.getByTestId("perm-card"); await c.first().waitFor({ timeout: 15000 }); return c; };
const cardGone = page => page.waitForFunction(() => !document.querySelector("[data-testid=perm-card]"), null, { timeout: 10000 });
const afterAnswer = async (page, t) => {
  await page.locator("[data-testid=chat-msg]").filter({ hasText: "✓ " + t }).first().waitFor({ timeout: 10000 });
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY", "focus must not fall to <body>");
};
const bodyText = page => page.locator("body").innerText();

async function scenarioAllow(s, browser) {
  const { ctx, page, check } = await startDriven(s, browser);
  const card = await waitCard(page);
  assert.equal(await card.count(), 1, "exactly one perm-card");
  assert.match(await card.innerText(), /touch x\.txt/);
  assert.ok(await card.first().getAttribute("data-request-id"), "data-request-id");
  await page.waitForFunction(() => /waiting for permission/.test(document.body.innerText), null, { timeout: 5000 });
  await page.getByTestId("prompt").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  assert.equal(perms(s).length, 0, "Enter must not answer the card");
  assert.equal(await page.getByTestId("perm-card").count(), 1, "card survives Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-testid=perm-card]") ? "card" : "other"), "other", "focus not stolen by card");
  assert.equal(await card.first().getByTestId("perm-expand").count(), 0, "short command has no perm-expand");
  assert.ok(await page.getByTestId("perm-allow").isEnabled(), "short command: allow enabled");
  await page.screenshot({ path: join(ART, "m3-card.png") });

  await page.setViewportSize({ width: 1000, height: 800 });
  assert.ok(await page.evaluate(() => { const b = document.querySelector("[data-testid=perm-allow]"), r = b.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; }), "perm-allow not covered at 1000x800");
  await page.getByTestId("perm-allow").click();
  await cardGone(page);
  await afterAnswer(page, "Allowed: Bash");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-node]")].some(b => /done/.test(b.textContent)), null, { timeout: 20000 });
  await page.locator("[data-testid=chat-msg][data-role=assistant]").filter({ hasText: "The subagent ran `touch x.txt` in the current directory and reported DONE." }).first().waitFor({ timeout: 10000 });
  await page.locator("[data-testid=chat-msg][data-role=result]").first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(ART, "m3-after.png") });
  const p = perms(s); assert.equal(p.length, 1, "one control_response");
  const r = p[0].response.response;
  assert.equal(r.behavior, "allow"); assert.equal(r.updatedInput?.command, "touch x.txt");
  assert.ok(!("updatedPermissions" in r), "no updatedPermissions");
  check(); await ctx.close();
}

async function scenarioLong(s, browser) {
  const { ctx, page, check } = await startDriven(s, browser);
  const card = await waitCard(page), allow = page.getByTestId("perm-allow");
  const full = "echo " + "a".repeat(700) + "; echo \u202eRTL; echo HIDDEN-TAIL-MARKER";
  await card.first().getByTestId("perm-expand").waitFor();
  assert.match(await card.first().getByTestId("perm-expand").innerText(), /Visa allt \(\+\d+ tecken\)/);
  assert.ok(await allow.isDisabled(), "allow disabled while collapsed");
  assert.ok(!(await card.first().innerText()).includes("HIDDEN-TAIL-MARKER"), "tail hidden while collapsed");
  await card.first().getByTestId("perm-expand").click();
  await card.first().getByText("HIDDEN-TAIL-MARKER").first().waitFor({ state: "visible" });
  assert.ok(await allow.isEnabled(), "allow enabled after expand");
  const shownText = await card.first().innerText();
  assert.ok(shownText.includes("dangerouslyDisableSandbox"), "every approved field is shown");
  assert.ok(shownText.includes("\\u{202e}") && !shownText.includes("\u202e"), "bidi override shown escaped");
  await allow.click();
  await cardGone(page);
  await afterAnswer(page, "Allowed: Bash");
  for (let i = 0; i < 50 && !perms(s).length; i++) await sleep(100);
  assert.equal(perms(s).length, 1);
  assert.equal(perms(s)[0].response.response.updatedInput?.command, full);
  check(); await ctx.close();
}

async function scenarioDeny(s, browser) {
  const { ctx, page, check } = await startDriven(s, browser);
  await waitCard(page);
  await page.getByTestId("perm-deny").click();
  await cardGone(page);
  await page.waitForFunction(() => /Denied in Agent Monitor/i.test(document.body.innerText), null, { timeout: 10000 });
  const p = perms(s); assert.equal(p.length, 1); assert.equal(p[0].response.response.behavior, "deny");
  check(); await ctx.close();
}

async function scenarioStop(s, browser) {
  const { ctx, page, check } = await startDriven(s, browser);
  await waitCard(page);
  await page.getByTestId("stop").click();
  await cardGone(page);
  await page.locator("[data-testid=chat-msg][data-role=result]").first().waitFor({ timeout: 10000 });
  // BLOCKER-note: fake_claude emits error_during_execution only if interrupt arrives before the deny; server sends deny first, so the result is the success one.
  for (let i = 0; i < 50 && !reqs(s, "interrupt").length; i++) await sleep(100);
  assert.ok(reqs(s, "interrupt").length >= 1, "interrupt control_request");
  assert.ok(perms(s).some(m => m.response.response.behavior === "deny"), "deny for pending request");
  check(); await ctx.close();
}

async function scenarioMode(s, browser) {
  const { ctx, page, check } = await startDriven(s, browser);
  await waitCard(page);
  const sel = page.getByTestId("mode-runtime");
  assert.deepEqual((await sel.locator("option").evaluateAll(o => o.map(x => x.value))).sort(), ["acceptEdits", "auto", "default", "plan"]);
  assert.equal((await sel.locator("option[value=default]").innerText()).trim(), "Default — ask when needed");
  const all = await page.evaluate(() => [...document.querySelectorAll("option")].map(o => o.value + "|" + o.textContent).join("\n"));
  assert.ok(!/bypassPermissions|dontAsk/i.test(all), "forbidden mode option in DOM: " + all);
  await sel.selectOption("plan");
  for (let i = 0; i < 50 && !reqs(s, "set_permission_mode").length; i++) await sleep(100);
  assert.equal(reqs(s, "set_permission_mode").at(-1)?.request.mode, "plan");

  const cookie = (await ctx.cookies()).find(c => c.name === "am");
  const id = (await (await fetch(s.base + "/api/sessions", { headers: { Cookie: `am=${cookie.value}` } })).json())[0].id;
  const before = readFileSync(s.log, "utf8");
  const r = await fetch(`${s.base}/api/sessions/${id}/mode`, { method: "POST", headers: { Cookie: `am=${cookie.value}`, "Content-Type": "application/json", Origin: s.base }, body: JSON.stringify({ mode: "bypassPermissions" }) });
  assert.equal(r.status, 400);
  await sleep(300);
  assert.equal(readFileSync(s.log, "utf8"), before, "stdin log unchanged");
  check(); await ctx.close();
}

async function scenarioForeignPerm(s, browser) {
  const { ctx, page, check } = await startDriven(s, browser);
  const card = await waitCard(page);
  const rid = await card.first().getAttribute("data-request-id");
  const cookie = (await ctx.cookies()).find(c => c.name === "am");
  const id = (await (await fetch(s.base + "/api/sessions", { headers: { Cookie: `am=${cookie.value}` } })).json())[0].id;
  const r = await fetch(`${s.base}/api/sessions/${id}/permission`, { method: "POST", headers: { Cookie: `am=${cookie.value}`, Origin: "http://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ request_id: rid, behavior: "allow" }) });
  assert.equal(r.status, 403);
  await sleep(500);
  assert.equal(perms(s).length, 0, "no control_response written");
  assert.equal(await page.getByTestId("perm-card").count(), 1, "card still pending");
  check(); await ctx.close();
}

try {
  await scenario("M2 prompt->chat->nodes->handback", "stream-noperm.jsonl", scenarioM2);
  await scenario("unauthenticated page", "stream-noperm.jsonl", scenarioUnauth);
  await scenario("foreign origin cannot send a prompt", "stream-noperm.jsonl", scenarioForeignOrigin);
  await scenario("M3 permission card -> allow -> handback", "stream-recording.jsonl", scenarioAllow);
  await scenario("M3 long command must be fully visible before allow", "stream-longcmd.jsonl", scenarioLong);
  await scenario("M3 deny", "stream-deny.jsonl", scenarioDeny);
  await scenario("M3 stop", "stream-recording.jsonl", scenarioStop);
  await scenario("M3 mode", "stream-recording.jsonl", scenarioMode);
  await scenario("M3 foreign origin cannot approve", "stream-recording.jsonl", scenarioForeignPerm);
  console.log("ok");
} catch (e) { console.error("FAIL", e); process.exit(1); }
