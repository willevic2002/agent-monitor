"use strict";
// Agent Monitor swimlanes: the timeline view of a driven `claude -p` session (graph from graph.reduce via SSE).
const $ = s => document.querySelector(s);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = RM ? 0.25 : 1;
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
const short = t => (t || "agent").split(":").pop();
const fmtTok = n => !n ? "0" : n < 1e3 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
const toolLabel = i => trunc(String((i && (i.command || i.file_path || i.pattern || i.path || i.url || i.description || i.query)) || "").split("\n")[0], 80);
const PAL = [["#e8a317"], ["#f2f2f0"], ["#f5c451"], ["#a8a29a"], ["#c98a0c"], ["#cfcfcc"], ["#7d7f84"]];   // amber / white / grey family
const SV = { running: "running", waiting: "waiting for you", done: "done", error: "error", idle: "ready" };

// ---------- state ----------
let focus = null, sid = null, src = null, graph = null, t0 = null, inflight = false, endT = null;
const info = new Map();       // node id -> { code, k, name, t0, end }
const lanes = new Map();      // node id -> { ticks: [], act, status }
const tickById = new Map();   // tool_use id -> tick
function meta(id, name) {
  if (!info.has(id)) { const k = info.size; info.set(id, { k, code: "A-" + String(k + 1).padStart(2, "0"), name, t0: Date.now(), end: null }); }
  const m = info.get(id); if (name) m.name = name; return m;
}
const color = id => PAL[meta(id).k % PAL.length][0];
const laneOf = id => { meta(id); if (!lanes.has(id)) lanes.set(id, { ticks: [], act: 0, status: "idle" }); return lanes.get(id); };
function pulse(id, amt = 1) { const l = laneOf(id); l.act = Math.min(1.4, l.act + amt); }
function setFocus(id) {
  focus = id;
  $("#logf").textContent = id ? meta(id).code : "all";
  [...$("#log").children].forEach(d => { d.hidden = !!id && d.dataset.node !== id; });
  [...$("#msgs").children].forEach(d => { d.hidden = d.dataset.node !== (id || "lead"); });
  $("#chatf").textContent = id ? meta(id).code + " " + (meta(id).name || "") : "lead";
  $("#msgs").scrollTop = $("#msgs").scrollHeight;
  if (graph) renderAgents(graph);
}

/** Lanes follow the graph: one per node (lead first); a lane ends when its agent is done/error. */
function syncLanes(g) {
  for (const n of g.nodes) {
    const m = meta(n.id, n.kind === "lead" ? "Lead" : short(n.label || n.agent_type)), l = laneOf(n.id);
    l.status = n.status;
    if (n.status === "done" || n.status === "error") m.end = m.end || Date.now(); else m.end = null;
  }
}

// ---------- swimlanes (2D canvas) ----------
const AX = 16, BG = "#0d0e10", AMBER = "#e8a317", GREY = "#8b8d92", RED = "#e5484d";
const lc = $("#lc"), lx = lc.getContext("2d");
let hits = [], cw = 0, ch = 0, dpr = 1;
const fmtAgo = s => s >= 60 ? (s / 60) + "m" : s + "s";
function drawLanes(dt) {
  const box = $("#lanes"), cv = $("#cv"), ids = graph ? graph.nodes.map(n => n.id) : ["lead"], n = ids.length;
  const rh = Math.max(28, Math.min(52, Math.floor((box.clientHeight - AX) / n)));
  box.style.setProperty("--rh", rh + "px");
  const w = cv.clientWidth, h = Math.max(box.clientHeight, AX + n * rh);
  if (!w) return;
  if (w !== cw || h !== ch || dpr !== devicePixelRatio) {
    cw = w; ch = h; dpr = devicePixelRatio; lc.width = w * dpr; lc.height = h * dpr; lc.style.height = h + "px";
  }
  lx.setTransform(dpr, 0, 0, dpr, 0, 0); lx.clearRect(0, 0, w, h);
  const now = endT || Date.now(), start = t0 || now, span = Math.max(12000, now - start + 1000), left = now - span, W = w - 10;
  const X = t => (t - left) / span * W;
  lx.font = "10px " + getComputedStyle(document.body).fontFamily; lx.textBaseline = "middle";
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find(s => s * 1000 >= span / 7) || 3600;
  for (let k = 0; k * step * 1000 < span; k++) {   // time grid, newest at the right edge
    const x = Math.round(X(now - k * step * 1000)) + .5;
    lx.fillStyle = k ? "#1c1e22" : "rgba(232,163,23,.5)"; lx.fillRect(x, AX, 1, h - AX);
    lx.fillStyle = k ? GREY : AMBER; lx.textAlign = k ? "center" : "right";
    lx.fillText(k ? "-" + fmtAgo(k * step) : "now", k ? Math.min(Math.max(x, 14), W - 14) : x - 4, AX / 2);
  }
  lx.fillStyle = "#2c2e33"; lx.fillRect(0, AX - 1, w, 1);
  hits = [];
  ids.forEach((id, i) => {
    const m = meta(id), l = laneOf(id), y = AX + i * rh, cy = y + rh / 2, bh = Math.round(rh * .46);
    const dim = focus && focus !== id;
    lx.globalAlpha = dim ? .3 : 1;
    lx.fillStyle = "#26282c"; lx.fillRect(0, y + rh - 1, w, 1);
    const x0 = Math.max(0, X(id === "lead" ? start : m.t0)), x1 = m.end ? X(m.end) : W;
    lx.fillStyle = l.status === "running" ? "rgba(232,163,23,.45)" : "#3a3c42"; lx.fillRect(x0, Math.round(cy), Math.max(1, x1 - x0), 1);
    lx.fillStyle = GREY; if (id !== "lead") lx.fillRect(Math.round(x0), cy - 6, 1, 12);   // spawn
    if (m.end) lx.fillRect(Math.round(x1), cy - 6, 1, 12);                                  // done
    for (const t of l.ticks) {
      const xs = X(t.t), xe = X(t.end || now), bw = Math.max(6, xe - xs);
      if (xs + bw < 0) continue;
      lx.fillStyle = t.end ? (t.err ? RED : GREY) : AMBER;
      lx.fillRect(Math.round(xs), cy - bh / 2, Math.round(bw) - 1, bh);
      hits.push({ x: xs, w: bw, y: cy - bh / 2, h: bh, t });
    }
    if (l.act > .05) { lx.fillStyle = `rgba(232,163,23,${Math.min(1, l.act)})`; const s = 4 + 6 * Math.min(1, l.act); lx.fillRect(W - s / 2, cy - s / 2, s, s); }
    l.act = Math.max(0, l.act - dt * 1.4);
    lx.globalAlpha = 1;
  });
}
lc.onmousemove = e => {
  const r = lc.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = hits.find(a => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
  lc.title = hit ? `${hit.t.tool} ${hit.t.arg}${hit.t.end ? ` · ${((hit.t.end - hit.t.t) / 1000).toFixed(1)} s${hit.t.err ? " · error" : ""}` : " · running"}` : "";
};
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!document.body.classList.contains("start")) drawLanes(dt);
  requestAnimationFrame(frame);
}

// ---------- panels ----------
const ts = () => new Date().toLocaleTimeString("en-GB");
function logLine(node, tool, arg, id) {
  const tk = { t: Date.now(), end: null, err: false, tool, arg }; laneOf(node).ticks.push(tk); if (id) tickById.set(id, tk);
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
    t.className = "n";
    const s = document.createElement("span"); s.className = "s " + n.status; s.textContent = `${SV[n.status] || n.status} · ${n.tools || 0} tools · ${fmtTok(n.tokens || 0)}`;
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
        { const tk = { t: Date.now(), end: null, err: false, tool: "Agent", arg: short(i.subagent_type) }; laneOf(node).ticks.push(tk); tickById.set(b.id, tk); }
        say(meta(node).code, `→ dispatch ${short(i.subagent_type)}: ${trunc(i.description || "", 120)}`, color(node), node);
        if (i.prompt) say("TASK", i.prompt, color(node), b.id);   // what the subagent was asked, top of its own chat
      } else if (b.type === "tool_use") logLine(node, b.name, toolLabel(b.input), b.id);
    }
  } else if (e.type === "user" && Array.isArray(c)) {   // tool results close their tick on the lane
    for (const b of c) { const tk = b.type === "tool_result" && tickById.get(b.tool_use_id); if (tk) { tk.end = Date.now(); tk.err = !!b.is_error; } }
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
  syncLanes(g); renderAgents(g); renderPerms(g.permissions || []);
  const st = (g.session && g.session.status) || "running", n = g.nodes.length - 1;
  $("#hmid").textContent = `${n} subagent${n === 1 ? "" : "s"} · ${{ running: "running", waiting: `${(g.permissions || []).length} waiting for your ok`, idle: "ready", ended: "ended" }[st] || st}`;
  $("#dot").style.animationPlayState = st === "running" || st === "waiting" ? "running" : "paused";
  setBusy(st === "running" || st === "waiting");
  $("#empty").hidden = true;
}
function reset() {
  if (src) src.close(); src = null; graph = null; t0 = null; focus = null;
  lanes.clear(); info.clear(); tickById.clear(); endT = null;
  for (const c of cards.values()) c.remove(); cards.clear();
  $("#log").replaceChildren(); $("#msgs").replaceChildren(); $("#agents").replaceChildren(); $("#tok").replaceChildren();
  meta("lead", "Lead"); laneOf("lead");
}
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
  s.addEventListener("end", () => { if (src !== s) return; endT = Date.now(); for (const tk of tickById.values()) tk.end = tk.end || endT; s.close(); src = null; setBusy(false); $("#hmid").textContent = "ended · type to start a new one"; loadSessions(); });
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
reset();
loadSessions();   // no auto-connect: the start screen stays until a prompt is sent or a session is picked
requestAnimationFrame(frame);
