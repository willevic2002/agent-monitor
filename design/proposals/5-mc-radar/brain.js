"use strict";
// Agent Brain: the 3D neuron view of a driven `claude -p` session (graph from graph.reduce via SSE).
const $ = s => document.querySelector(s);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = RM ? 0.25 : 1;
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
const short = t => (t || "agent").split(":").pop();
const fmtTok = n => !n ? "0" : n < 1e3 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
const toolLabel = i => trunc(String((i && (i.command || i.file_path || i.pattern || i.path || i.url || i.description || i.query)) || "").split("\n")[0], 80);
const PAL = [["#e8a317", "#f5c451"], ["#f2f2f0", "#b5b7bc"], ["#f5c451", "#e8a317"], ["#b5b7bc", "#8b8d92"], ["#d28a0c", "#e8a317"], ["#d9d9d6", "#8b8d92"], ["#a8aaae", "#f2f2f0"]];
const MAX_BLOBS = 7; // lead + 6 subagents; older finished agents only stay in the list
const SV = { running: "running", waiting: "waiting for you", done: "done", error: "error", idle: "ready" };

// ---------- radar view (2D canvas): lead at the centre, subagents on concentric rings ----------
const canvas = $("#gl"), ctx = canvas.getContext("2d");
const rnd = (a, b) => a + Math.random() * (b - a);
const AMBER = "#e8a317", INK = "#f2f2f0", GREY = "#8b8d92";
let W = 0, H = 0, brainR = 0, brainCy = 0, focus = null;
let sid = null, src = null, graph = null, t0 = null, inflight = false;
const blobs = new Map();      // node id -> radar node
const info = new Map();       // node id -> { code, k, name }
const RINGS = [0.36, 0.64, 0.92], RING_CAP = [4, 6, 8], RING_SPEED = [0.09, -0.06, 0.04];

function makeBlob(id, k) {
  return { id, k, act: 0, ang: rnd(0, 6.28), base: 0, ring: 0, rr: 0, x: 0, y: 0, status: "idle", pill: document.createElement("span"), dispose() {} };
}
function meta(id, name) {
  if (!info.has(id)) { const k = info.size; info.set(id, { k, code: "A-" + String(k + 1).padStart(2, "0"), name }); }
  const m = info.get(id); if (name) m.name = name; return m;
}
function color(id) { return PAL[meta(id).k % PAL.length][0]; }
function pulse(id, amt = 1) { const b = blobs.get(id); if (b) b.act = Math.min(1.4, b.act + amt); }
function setFocus(id) {
  focus = id;
  $("#logf").textContent = id ? meta(id).code : "all";
  [...$("#log").children].forEach(d => { d.hidden = !!id && d.dataset.node !== id; });
  [...$("#msgs").children].forEach(d => { d.hidden = d.dataset.node !== (id || "lead"); });
  $("#chatf").textContent = id ? meta(id).code + " " + (meta(id).name || "") : "lead";
  $("#msgs").scrollTop = $("#msgs").scrollHeight;
  if (graph) renderAgents(graph);
}

/** Assign every subagent a ring slot (inner rings fill first). */
function layoutBlobs() {
  let j = 0;
  for (const b of blobs.values()) {
    if (b.id === "lead") continue;
    let r = 0, idx = j; while (r < 2 && idx >= RING_CAP[r]) { idx -= RING_CAP[r]; r++; }
    b.ring = r; b.idx = idx; b.slot = j++;
  }
  for (const b of blobs.values()) if (b.id !== "lead") {
    const cnt = Math.min(RING_CAP[b.ring], [...blobs.values()].filter(o => o.id !== "lead" && o.ring === b.ring).length);
    b.baseT = b.idx / Math.max(cnt, 1) * 6.2832 + b.ring * 0.9;
  }
}

/** Lead + subagents (finished ones stay, dimmed); radar keeps the newest MAX_BLOBS-1. */
function syncBlobs(g) {
  const lead = g.nodes.find(n => n.kind === "lead");
  const keep = [lead, ...g.nodes.filter(n => n.kind !== "lead").slice(-(MAX_BLOBS - 1))].filter(Boolean);
  const want = new Set(keep.map(n => n.id));
  let changed = false;
  for (const id of [...blobs.keys()]) if (!want.has(id)) { blobs.delete(id); changed = true; }
  for (const n of keep) if (!blobs.has(n.id)) { blobs.set(n.id, makeBlob(n.id, meta(n.id).k)); pulse(n.id, 1.4); changed = true; }
  if (changed) {
    const order = [...blobs.entries()].sort((a, b) => meta(a[0]).k - meta(b[0]).k);
    blobs.clear(); order.forEach(([id, b]) => blobs.set(id, b));
    layoutBlobs();
  }
  for (const n of keep) { const b = blobs.get(n.id), m = meta(n.id, n.kind === "lead" ? "Lead" : short(n.label || n.agent_type)); b.status = n.status; b.name = m.name; }
}

// ---------- layout + frame ----------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);
new ResizeObserver(resize).observe(canvas.parentElement);
function layoutTarget() { return { R: 0, cy: 0 }; }
canvas.addEventListener("click", e => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let hit = null, best = 16;
  for (const b of blobs.values()) { const d = Math.hypot(b.x - x, b.y - y); if (d < best) { best = d; hit = b.id; } }
  setFocus(hit && focus !== hit ? hit : null);
});
canvas.addEventListener("mousemove", e => {
  const r = canvas.getBoundingClientRect(); let over = false;
  for (const b of blobs.values()) if (Math.hypot(b.x - (e.clientX - r.left), b.y - (e.clientY - r.top)) < 16) over = true;
  canvas.style.cursor = over ? "pointer" : "default";
});

const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
let last = performance.now(), T = 0, sweep = 0, sweepAmt = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED; last = now; T += dt;
  const k = 1 - Math.exp(-dt * 3);
  const start = document.body.classList.contains("start");
  const cx = W / 2, cy = H / 2, R = Math.max(40, Math.min(W / 2 - 52, H / 2 - 14)) * (start ? 0.95 : 1);
  const busy = [...blobs.values()].some(b => b.status === "running" || b.status === "waiting");
  sweepAmt += ((busy ? 1 : 0) - sweepAmt) * k;
  if (busy) sweep = (sweep + dt * 0.9) % TAU;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 1; ctx.font = "10px " + getComputedStyle(document.body).fontFamily; ctx.textBaseline = "middle";
  // grid: rings, crosshair, ticks
  ctx.strokeStyle = "#2c2e33";
  for (const f of RINGS) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, TAU); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(cx - R, cy + .5); ctx.lineTo(cx + R, cy + .5); ctx.moveTo(cx + .5, cy - R); ctx.lineTo(cx + .5, cy + R); ctx.stroke();
  ctx.strokeStyle = "#3a3c42"; ctx.beginPath();
  for (let a = 0; a < 360; a += 10) { const r = a % 90 ? 5 : 9, t = a * Math.PI / 180; ctx.moveTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); ctx.lineTo(cx + Math.cos(t) * (R - r), cy + Math.sin(t) * (R - r)); }
  ctx.stroke();
  ctx.fillStyle = GREY; ctx.textAlign = "left";
  RINGS.forEach((f, i) => ctx.fillText("R" + (i + 1), cx + 4, cy - R * f + 8));
  // sweeping arm with a fading wake
  if (sweepAmt > 0.02) {
    for (let i = 0; i < 28; i++) {
      const a0 = sweep - (i + 1) * 0.028, a1 = sweep - i * 0.028;
      ctx.fillStyle = `rgba(232,163,23,${(0.16 * (1 - i / 28) * sweepAmt).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = `rgba(232,163,23,${(0.85 * sweepAmt).toFixed(2)})`;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R); ctx.stroke();
  }
  // nodes
  const lead = blobs.get("lead");
  const drawLabels = [];
  for (const b of blobs.values()) {
    if (b.status === "running" && b.act < 0.25) b.act += dt * 0.6;       // live agents keep a slow heartbeat
    if (b.status === "waiting") b.act = 0.6 + 0.5 * Math.sin(T * 4);      // asking for permission: throb
    b.act = Math.max(0, b.act - dt * 1.4);
    const isLead = b.id === "lead";
    if (isLead) { b.x = cx; b.y = cy; }
    else {
      b.base = b.base === 0 && b.baseT != null ? b.baseT : b.base + angDiff(b.baseT, b.base) * k;
      const rt = RINGS[b.ring] * R; b.rr += (rt - b.rr) * k;
      b.ang = b.base + T * RING_SPEED[b.ring] * 2;
      b.x = cx + Math.cos(b.ang) * b.rr; b.y = cy + Math.sin(b.ang) * b.rr;
    }
    let al = b.status === "done" ? 0.4 : b.status === "error" ? 0.6 : 1;
    if (focus && focus !== b.id) al *= 0.35;
    // brighten as the sweep arm passes
    const ping = sweepAmt > 0.02 && !isLead ? Math.max(0, 1 - Math.abs(angDiff(Math.atan2(b.y - cy, b.x - cx), sweep)) / 0.5) * sweepAmt : 0;
    const col = isLead ? AMBER : color(b.id), a = Math.min(1, al * (0.8 + 0.2 * Math.min(1, b.act) + 0.3 * ping));
    ctx.globalAlpha = a;
    if (!isLead && lead) { ctx.strokeStyle = col; ctx.globalAlpha = a * (0.3 + 0.5 * Math.min(1, b.act)); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = a; }
    const s = isLead ? 6 : 4, act = Math.min(1, b.act);
    if (act > 0.03) { ctx.strokeStyle = col; ctx.globalAlpha = a * act * 0.9; ctx.beginPath(); ctx.arc(b.x, b.y, s + 3 + (1 - act) * 20, 0, TAU); ctx.stroke(); ctx.globalAlpha = a; }
    ctx.fillStyle = col; ctx.fillRect(b.x - s, b.y - s, s * 2, s * 2);
    if (isLead) { ctx.strokeStyle = col; ctx.strokeRect(b.x - s - 4.5, b.y - s - 4.5, (s + 4) * 2 + 1, (s + 4) * 2 + 1); }
    if (b.status === "done" && !isLead) { ctx.fillStyle = "#0d0e10"; ctx.fillRect(b.x - 1, b.y - 1, 2, 2); }
    ctx.globalAlpha = 1;
    drawLabels.push([b, col, a, isLead]);
  }
  for (const [b, col, a, isLead] of drawLabels) {
    const m = meta(b.id), txt = m.code + " " + trunc(b.name || m.name || "", 12) + (b.status === "waiting" ? " ⏸" : b.status === "done" ? " ✓" : "");
    ctx.globalAlpha = Math.min(1, a + 0.2); ctx.fillStyle = INK;
    const right = b.x < cx + 1 && !isLead ? -1 : 1;
    ctx.textAlign = isLead ? "center" : right < 0 ? "right" : "left";
    ctx.fillText(txt, isLead ? b.x : b.x + right * 10, isLead ? b.y + 22 : b.y - 10 + (b.y > cy ? 20 : 0));
    ctx.globalAlpha = 1;
  }
  // corner readout
  if (!start) { ctx.fillStyle = GREY; ctx.textAlign = "left"; ctx.fillText(busy ? "SWEEP " + String(Math.round(sweep * 57.3)).padStart(3, "0") + "°" : "STANDBY", 8, 12);
  ctx.textAlign = "right"; ctx.fillText(Math.max(0, blobs.size - 1) + " CONTACT" + (blobs.size === 2 ? "" : "S"), W - 8, 12); }
  requestAnimationFrame(frame);
}

// ---------- panels ----------
const ts = () => new Date().toLocaleTimeString("en-GB");
function logLine(node, tool, arg) {
  const box = $("#log"), d = document.createElement("div"), m = meta(node);
  d.dataset.node = node; d.hidden = !!focus && focus !== node;
  const a = document.createElement("span"); a.className = "ts"; a.textContent = ts() + " ";
  const w = document.createElement("span"); w.className = "who"; w.style.color = color(node); w.textContent = m.code;
  const b = document.createElement("span"); b.className = "tool"; b.textContent = tool + " ";
  d.append(a, w, b, arg); box.append(d);
  while (box.children.length > 200) box.firstChild.remove();
}
function renderAgents(g) {
  const box = $("#agents");
  box.replaceChildren(...g.nodes.map(n => {
    const m = meta(n.id, n.kind === "lead" ? "Lead" : short(n.label || n.agent_type));
    const b = document.createElement("button"); b.style.setProperty("--c", color(n.id));
    b.setAttribute("aria-pressed", focus === n.id); b.onclick = () => setFocus(focus === n.id ? null : n.id);
    b.title = n.description || n.current || "";
    const c = document.createElement("span"); c.className = "c"; c.textContent = m.code;
    const t = document.createElement("span"); t.textContent = m.name + (n.description ? " · " + trunc(n.description, 40) : "");
    t.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    const s = document.createElement("span"); s.className = "s " + n.status; s.textContent = `${SV[n.status] || n.status} · ${n.tools || 0} tools`;
    b.append(c, t, s); return b;
  }));
  const tok = g.nodes.map(n => [n, n.tokens || 0]), max = Math.max(1, ...tok.map(x => x[1]));
  $("#tok").replaceChildren(...tok.filter(x => x[1]).slice(0, 7).map(([n, v]) => {
    const r = document.createElement("div"); r.className = "row"; r.style.setProperty("--c", color(n.id));
    const a = document.createElement("span"); a.textContent = meta(n.id).code; a.style.color = color(n.id);
    const bar = document.createElement("div"); bar.className = "bar"; const i = document.createElement("i"); i.style.width = v / max * 100 + "%"; bar.append(i);
    const e = document.createElement("span"); e.textContent = fmtTok(v); e.style.textAlign = "right";
    r.append(a, bar, e); return r;
  }));
  const total = tok.reduce((s, x) => s + x[1], 0), cost = g.session && g.session.cost_usd;
  $("#cost").textContent = cost != null ? "$" + cost.toFixed(2) : "$–";
  $("#toktot").textContent = total.toLocaleString("en-GB") + " tok";
  $("#s-tok").textContent = fmtTok(total);
  $("#s-tools").textContent = g.nodes.reduce((s, n) => s + (n.tools || 0), 0);
  $("#s-agents").textContent = g.nodes.length - 1;
  $("#nag").textContent = g.nodes.length;
}

// ---------- permission cards ----------
const cards = new Map();
function renderPerms(list) {
  const ids = new Set(list.map(p => p.request_id));
  for (const [id, c] of cards) if (!ids.has(id)) { c.remove(); cards.delete(id); }
  for (const p of list) if (!cards.has(p.request_id)) {
    speak(`Permission required, sir. ${p.tool_name}.`);
    const m = meta(p.node), c = document.createElement("div");
    c.className = "card"; c.style.setProperty("--c", color(p.node));
    c.innerHTML = `<div class="ph"><span class="tag"></span><span class="t"></span></div><code></code><div class="why"></div>
      <div class="btns"><button class="ok">Allow</button><button class="no">Deny</button></div>`;
    c.querySelector(".tag").textContent = m.code;
    c.querySelector(".t").textContent = `${m.name || "Lead"} wants to run ${p.tool_name}`;
    const inp = p.input || {};
    c.querySelector("code").textContent = inp.command || inp.file_path || trunc(JSON.stringify(inp, null, 1), 600);   // full input shown before allow
    c.querySelector(".why").textContent = p.description || p.blocked_path || "";
    const answer = async behavior => {
      c.querySelectorAll("button").forEach(b => b.disabled = true);
      try { await api(`/api/sessions/${sid}/permission`, { request_id: p.request_id, behavior }); c.classList.add("gone"); pulse(p.node, 1.2); }
      catch (e) { err("Could not answer: " + e.message); c.querySelectorAll("button").forEach(b => b.disabled = false); }
    };
    c.querySelector(".ok").onclick = () => answer("allow");
    c.querySelector(".no").onclick = () => answer("deny");
    cards.set(p.request_id, c); $("#cards").append(c);
  }
}

// ---------- chat ----------
// WebKit has no scroll anchoring: keep the chat pinned to the bottom across resizes/reflow if it was there
let stick = true;
$("#msgs").addEventListener("scroll", e => { const m = e.target; if (m.clientHeight) stick = m.scrollHeight - m.scrollTop - m.clientHeight < 30; });
new ResizeObserver(() => { if (stick) $("#msgs").scrollTop = $("#msgs").scrollHeight; }).observe($("#msgs"));
/** Chat line owned by a node ("lead" or a subagent id); the panel shows the focused node's chat, lead's when nothing is focused. */
function say(who, text, col, owner = "lead") {
  const box = $("#msgs"), d = document.createElement("div"), w = document.createElement("span");
  w.className = "who"; w.textContent = who; if (col) w.style.color = col;
  d.dataset.node = owner; d.hidden = owner !== (focus || "lead");
  d.append(w, trunc(text, 1200)); box.append(d);
  if (who === "✓" || who === "✕") d.dataset.done = "1";   // lets back-to-back results collapse into one row
  while (box.children.length > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
const err = t => { $("#err").textContent = t || ""; };
async function api(path, body) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401 || r.status === 403) throw new Error("invalid token, restart the app from the launcher");
  if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j;
}

// ---------- session stream ----------
function onEv(e) {
  if (t0 === null) t0 = Date.now();
  const node = e.parent_tool_use_id || "lead", c = e.message && e.message.content;
  if (e.type === "user" && e.am_local && typeof c === "string") { say("YOU", c); pulse("lead", 1.4); return; }
  if (e.type === "assistant" && Array.isArray(c)) {
    pulse(node, 0.9);
    for (const b of c) {
      if (b.type === "text" && b.text) { say(node === "lead" ? "LEAD" : meta(node).code, b.text, color(node), node); if (node === "lead") speak(b.text); }
      else if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        const i = b.input || {}; meta(b.id, short(i.subagent_type));
        say(meta(node).code, `→ dispatch ${short(i.subagent_type)}: ${trunc(i.description || "", 120)}`, color(node), node);
        if (i.prompt) say("TASK", i.prompt, color(node), b.id);   // what the subagent was asked, top of its own chat
      } else if (b.type === "tool_use") logLine(node, b.name, toolLabel(b.input));
    }
  } else if (e.type === "system" && e.subtype === "task_notification") {
    const m = meta(e.tool_use_id); pulse(e.tool_use_id, 1.4); pulse("lead", 0.8);
    say(m.code, `← handback ${m.name || ""}${e.summary ? ": " + trunc(e.summary, 200) : ""}`, color(e.tool_use_id));
    say("DONE", e.summary || "done", color(e.tool_use_id), e.tool_use_id);
  } else if (e.type === "result") {
    const bad = e.is_error || (e.subtype && e.subtype !== "success"), prev = $("#msgs").lastElementChild;
    if (prev && prev.dataset.done) prev.remove(); else speak(bad ? "The run was interrupted, sir." : "Done, sir.");
    say(bad ? "✕" : "✓", `${bad ? "interrupted/error" : "done"}${e.total_cost_usd != null ? " · $" + e.total_cost_usd.toFixed(2) : ""}${e.duration_ms != null ? " · " + (e.duration_ms / 1000).toFixed(1) + " s" : ""}`);
  } else if (e.type === "am_exit") say("—", "session ended");
}
function onGraph(g) {
  if (!g || !g.nodes) return;
  graph = g;
  syncBlobs(g); renderAgents(g); renderPerms(g.permissions || []);
  const st = (g.session && g.session.status) || "running", n = g.nodes.length - 1;
  $("#hmid").textContent = `${n} subagent${n === 1 ? "" : "s"} · ${{ running: "running", waiting: `${(g.permissions || []).length} waiting for your ok`, idle: "ready", ended: "ended" }[st] || st}`;
  $("#dot").style.animationPlayState = st === "running" || st === "waiting" ? "running" : "paused";
  setBusy(st === "running" || st === "waiting");
  $("#empty").hidden = true;
}
function reset() {
  if (src) src.close(); src = null; graph = null; t0 = null; focus = null;
  for (const b of blobs.values()) b.dispose(); blobs.clear(); info.clear();
  for (const c of cards.values()) c.remove(); cards.clear();
  $("#log").replaceChildren(); $("#msgs").replaceChildren(); $("#agents").replaceChildren(); $("#tok").replaceChildren();
  meta("lead", "Lead"); blobs.set("lead", makeBlob("lead", 0)); syncLeadIdle();
}
function syncLeadIdle() { layoutBlobs(); const b = blobs.get("lead"); b.status = "idle"; b.pill.innerHTML = "<i>A-01</i>Lead"; }
function connect(id) {
  reset(); sid = id; store.set("am.brain", id || ""); connectedAt = Date.now();
  $("#empty").hidden = !!id;
  document.body.classList.toggle("start", !id);
  $("#hmid").textContent = id ? "connecting…" : "new session";
  setBusy(false);
  if (!id) return;
  const s = src = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
  s.addEventListener("ev", m => { if (src === s) try { onEv(JSON.parse(m.data)); } catch {} });
  s.addEventListener("graph", m => { if (src === s) try { onGraph(JSON.parse(m.data)); } catch {} });
  s.addEventListener("end", () => { if (src !== s) return; s.close(); src = null; setBusy(false); $("#hmid").textContent = "ended · type to start a new one"; loadSessions(); });
}

// ---------- session picker ----------
let sessions = [];
async function loadSessions() {
  try {
    const r = await fetch("/api/sessions", { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401 || r.status === 403) { err("Invalid token. Restart the app from the launcher."); return; }
    if (!r.ok) return;
    sessions = await r.json();
  } catch { return; }
  const sel = $("#sess"), cur = sid || "";
  sel.replaceChildren(new Option("＋ new session", ""), ...sessions.slice().reverse().map(s => new Option(`${s.status === "ended" ? "○" : "●"} ${trunc(s.title || s.cwd, 36)}`, s.id)));
  sel.value = sessions.some(s => s.id === cur) ? cur : "";
  const me = sessions.find(s => s.id === sid);
  if (me && me.status !== "ended" && document.activeElement !== $("#mode")) $("#mode").value = me.mode;
}
$("#sess").onchange = e => connect(e.target.value || null);
function alive() { const s = sessions.find(x => x.id === sid); return !!sid && (!s || s.status !== "ended") && (!graph || graph.session.status !== "ended"); }

// ---------- prompt ----------
let running = false;
function setBusy(b) { running = b; $("#stop").hidden = !b; }
$("#chatf").onclick = () => setFocus(null);
$("#stop").onclick = async () => { try { await api(`/api/sessions/${sid}/interrupt`, {}); } catch (x) { err("Could not interrupt: " + x.message); } };
$("#cwd").value = store.get("am.cwd") || "~";
$("#mode").value = store.get("am.mode") || "default";
$("#mode").onchange = async e => {
  store.set("am.mode", e.target.value);
  if (alive()) try { await api(`/api/sessions/${sid}/mode`, { mode: e.target.value }); } catch (x) { err("Could not change mode: " + x.message); }
};
$("#f").onsubmit = async e => {
  e.preventDefault();
  const q = $("#q").value.trim(); if (!q || inflight) return;
  inflight = true; err("");
  try {
    if (alive()) await api(`/api/sessions/${sid}/prompt`, { text: q });
    else {
      const cwd = $("#cwd").value.trim() || "~";
      const j = await api("/api/sessions", { cwd, prompt: q, mode: $("#mode").value });
      store.set("am.cwd", cwd); await loadSessions(); connect(j.id); $("#sess").value = j.id;
    }
    $("#q").value = "";
  } catch (x) { err("✕ " + x.message); }
  inflight = false;
};
addEventListener("keydown", e => { if (e.key === "Escape" && document.activeElement.tagName !== "INPUT") setFocus(null); });

// ---------- voice (optional, local Piper + whisper; see packaging/install-voice.sh) ----------
let voiceOn = store.get("am.voice") === "1", connectedAt = 0, audio = null;
const queue = [];
function clean(t) {   // what's worth saying out loud: no code, links or markdown noise, ~2 sentences' worth
  t = t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[#*_>|]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= 400) return t;
  const cut = t.slice(0, 400), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 120 ? cut.slice(0, end + 1) : cut + "…";
}
function speak(text) {
  if (!voiceOn || Date.now() - connectedAt < 2000) return;   // don't read out the history replayed on connect
  const t = clean(text); if (!t) return;
  queue.push(t); if (!audio) next();
}
async function next() {   // the server speaks (pw-play) and answers when done; `audio` marks the current chain
  const t = queue.shift(); if (!t || !voiceOn) { audio = null; return; }
  const me = audio = {};
  try { await api("/api/tts", { text: t }); if (audio === me) next(); }
  catch (x) { err("Voice: " + x.message); if (audio === me) { queue.length = 0; audio = null; } }
}
function hush() { queue.length = 0; if (audio) api("/api/tts/stop", {}).catch(() => {}); audio = null; }
function setVoice(on) {
  voiceOn = on; store.set("am.voice", on ? "1" : "0");
  $("#spk").setAttribute("aria-pressed", on);
  if (!on) hush();
}
$("#spk").onclick = () => setVoice(!voiceOn);

let talking = false;
async function talk(on) {
  if (on === talking) return; talking = on; $("#mic").classList.toggle("on", on);
  if (on) { hush(); try { await api("/api/stt/start", {}); } catch (x) { err("Mic: " + x.message); } return; }
  $("#q").placeholder = "Transcribing…";
  try {
    const { text } = await api("/api/stt/stop", {});
    if (text) { $("#q").value = text; $("#f").requestSubmit(); }
  } catch (x) { err("Mic: " + x.message); }
  $("#q").placeholder = "Ask the lead anything… (slash commands work too)";
}
$("#mic").onpointerdown = e => { e.preventDefault(); talk(true); };
$("#mic").onpointerup = $("#mic").onpointerleave = () => talking && talk(false);
addEventListener("keydown", e => { if (e.code === "Space" && !e.repeat && !$("#mic").hidden && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); talk(true); } });
addEventListener("keyup", e => { if (e.code === "Space" && talking) talk(false); });
fetch("/api/voice", { credentials: "same-origin" }).then(r => r.ok ? r.json() : {}).then(v => {
  $("#spk").hidden = !v.tts; $("#mic").hidden = !v.stt; if (v.tts) setVoice(voiceOn);
}).catch(() => {});

// ---------- today's schedule on the start screen (Calm Week, if installed) ----------
async function loadCal() {
  let ev = [];
  try { const r = await fetch("/api/calendar", { cache: "no-store", credentials: "same-origin" }); if (r.ok) ev = await r.json(); } catch {}
  const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("#cal").hidden = !ev.length;
  $("#cal").replaceChildren($("#cal h2"), ...ev.map(e => {
    const d = document.createElement("div"), t = document.createElement("span"), b = document.createElement("b");
    d.className = e.end <= now ? "past" : e.start <= now ? "now" : ""; d.style.setProperty("--c", e.color || "var(--dim)");
    t.textContent = `${e.start}–${e.end}`; b.textContent = b.title = e.title; d.append(t, b); return d;
  }));
}
loadCal(); setInterval(loadCal, 60000);

// ---------- boot ----------
function tick() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("#st-time").textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("#st-date").textContent = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (t0 !== null) { const s = Math.floor((Date.now() - t0) / 1000); $("#s-time").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
}
setInterval(tick, 1000); tick();
setInterval(loadSessions, 4000);
resize(); brainCy = layoutTarget().cy; brainR = layoutTarget().R;
reset();
loadSessions();   // no auto-connect: the start screen stays until a prompt is sent or a session is picked
requestAnimationFrame(frame);
