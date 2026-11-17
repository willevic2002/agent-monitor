// Design proposal screenshots (no real claude, no cost): node tests/e2e/design-shots.mjs <proposal-dir>
// Injects <proposal-dir>/override.css if present, serves <proposal-dir>/brain.html|brain.js instead of the app's own if present
// (else: current look), and writes 01-start, 02-session, 03-permission, 04-narrow (.png) + 05-motion.webm (whole run as video).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] || "design/proposals/0-current"); mkdirSync(out, { recursive: true });
const cssFile = join(out, "override.css"), css = existsSync(cssFile) ? readFileSync(cssFile, "utf8") : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = await new Promise(r => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

const tmp = mkdtempSync(join(tmpdir(), "am-design-")), cfg = join(tmp, "cfg"), proj = join(tmp, "proj"), cwd = join(tmp, "work");
mkdirSync(proj); mkdirSync(cwd);
const srv = spawn("python3", [join(ROOT, "server.py")], { cwd: ROOT, stdio: "ignore", detached: true,
  env: { ...process.env, PORT: String(port), AM_CONFIG_DIR: cfg, AM_PROJECTS_DIR: proj, AM_CLAUDE: join(ROOT, "tests/fake_claude.py"),
    AM_FAKE_FIXTURE: join(ROOT, "tests/fixtures/stream-recording.jsonl"), AM_FAKE_DELAY: "0.05" } });
const base = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let i = 0; ; i++) { try { await fetch(base + "/"); break; } catch { if (i > 100) throw new Error("server did not start"); await sleep(100); } }
  const token = readFileSync(join(cfg, "token"), "utf8").trim();
  const once = (await (await fetch(base + "/api/once", { method: "POST", headers: { "X-AM-Token": token, "Content-Type": "application/json" }, body: "{}" })).json()).once;

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const vdir = join(tmp, "video"), ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: vdir, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  for (const [f, type, re] of [["brain.html", "text/html; charset=utf-8", /^\/(brain)?$/], ["brain.js", "text/javascript; charset=utf-8", /^\/brain\.js$/]])
    if (existsSync(join(out, f))) await page.route(u => re.test(new URL(u).pathname), r => r.fulfill({ status: 200, contentType: type, body: readFileSync(join(out, f)) }));
  page.on("pageerror", e => console.error("pageerror:", e.message));
  const style = async () => { if (css) await page.addStyleTag({ content: css }); };
  const shot = async n => { await sleep(1200); await page.screenshot({ path: join(out, n) }); console.log("wrote", join(out, n)); };

  await page.goto(`${base}/login?once=${once}`); await page.evaluate(() => localStorage.clear()); await page.reload();
  await style(); await shot("01-start.png");

  await page.fill("#cwd", cwd); await page.fill("#q", "Create x.txt in the current directory using a subagent.");
  await page.press("#q", "Enter");
  await page.locator("#cards .card").first().waitFor({ timeout: 20000 });
  await shot("03-permission.png");

  await page.locator("#cards .card button.ok").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll("#msgs .who")].some(w => w.textContent === "✓"), null, { timeout: 30000 });
  await shot("02-session.png");

  await sleep(4000);   // a few more seconds of motion for the video
  await page.setViewportSize({ width: 390, height: 844 }); await shot("04-narrow.png");
  const video = page.video(); await ctx.close();
  rmSync(join(out, "05-motion.webm"), { force: true }); copyFileSync(await video.path(), join(out, "05-motion.webm")); console.log("wrote", join(out, "05-motion.webm"));
} finally {
  await browser?.close().catch(() => {});
  try { process.kill(-srv.pid, "SIGTERM"); } catch {}   // whole group: server + fake claude
}
