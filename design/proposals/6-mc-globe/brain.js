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

// ---------- three.js globe: wireframe geodesic sphere, agents as lit points on its surface ----------
const canvas = $("#gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const FOV = 35, TANH = Math.tan(FOV * Math.PI / 360);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
const globe = new THREE.Group();
scene.add(globe);
const lineMat = (c, o) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o });
globe.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 3), 1), lineMat("#8b8d92", 0.5)));
const ring = (tilt, s, c, o) => {   // thin great-circle rings, instrument-style
  const pts = []; for (let i = 0; i < 128; i++) { const t = i / 128 * 6.2832; pts.push(new THREE.Vector3(Math.cos(t), 0, Math.sin(t))); }
  const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat(c, o)); l.rotation.x = tilt; l.scale.setScalar(s); return l;
};
globe.add(ring(0, 1.16, "#e8a317", 0.5), ring(1.2, 1.28, "#8b8d92", 0.35));
const rnd = (a, b) => a + Math.random() * (b - a);

let W = 0, H = 0, brainR = 0, brainCy = 0, focus = null;
let sid = null, src = null, graph = null, t0 = null, inflight = false;
const blobs = new Map();      // node id -> point on the globe
const info = new Map();       // node id -> { code, k, name }

/** Agent k sits on the sphere surface: the lead on the pole, subagents spread on a Fibonacci spiral below it. */
function surfacePoint(slot) {
  if (slot < 0) return new THREE.Vector3(0, 1, 0);
  const y = 0.62 - slot * 0.31, r = Math.sqrt(Math.max(0, 1 - y * y)), a = slot * 2.39996;
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
}
function makeBlob(id, k) {
  const col = new THREE.Color(PAL[k % PAL.length][0]), lead = id === "lead";
  const g = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const pm = new THREE.PointsMaterial({ color: col, size: lead ? 9 : 6, sizeAttenuation: false, transparent: true, depthTest: false });
  const pts = new THREE.Points(g, pm);
  const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat(col, 0.2));
  const halo = new THREE.Points(g, new THREE.PointsMaterial({ color: col, size: 6, sizeAttenuation: false, transparent: true, opacity: 0, depthTest: false }));
  globe.add(pts, spoke, halo);
  const pill = document.createElement("button");
  pill.className = "pill"; pill.style.setProperty("--c", PAL[k % PAL.length][0]);
  pill.onclick = () => setFocus(focus === id ? null : id);
  $("#labels").append(pill);
  return { id, k, pts, spoke, halo, pm, pill, act: 0, pos: surfacePoint(lead ? -1 : 0), target: surfacePoint(lead ? -1 : 0), status: "idle", al: 1,
    dispose() { globe.remove(pts, spoke, halo); g.dispose(); pm.dispose(); halo.material.dispose(); spoke.geometry.dispose(); spoke.material.dispose(); pill.remove(); } };
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
function layoutBlobs() { let j = 0; for (const b of blobs.values()) b.target = surfacePoint(b.id === "lead" ? -1 : j++); }

function syncBlobs(g) {
  const lead = g.nodes.find(n => n.kind === "lead");
  const keep = [lead, ...g.nodes.filter(n => n.kind !== "lead").slice(-(MAX_BLOBS - 1))].filter(Boolean);
  const want = new Set(keep.map(n => n.id));
  let changed = false;
  for (const [id, b] of blobs) if (!want.has(id)) { b.dispose(); blobs.delete(id); changed = true; }
  for (const n of keep) if (!blobs.has(n.id)) { blobs.set(n.id, makeBlob(n.id, meta(n.id).k)); pulse(n.id, 1.4); changed = true; }
  if (changed) {
    const order = [...blobs.entries()].sort((a, b) => meta(a[0]).k - meta(b[0]).k);
    blobs.clear(); order.forEach(([id, b]) => blobs.set(id, b));
    layoutBlobs();
  }
  for (const n of keep) {
    const b = blobs.get(n.id), m = meta(n.id, n.kind === "lead" ? "Lead" : short(n.label || n.agent_type));
    b.status = n.status;
    b.pill.innerHTML = ""; const i = document.createElement("i"); i.textContent = m.code; b.pill.append(i, m.name + (n.status === "waiting" ? " ⏸" : n.status === "done" ? " ✓" : ""));
    b.pill.setAttribute("aria-label", `${m.code} ${m.name}: ${SV[n.status] || n.status}`);
  }
}

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
  renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  const px = renderer.getPixelRatio();
  for (const b of blobs.values()) b.halo.material.size = 6;
}
addEventListener("resize", resize);
new ResizeObserver(resize).observe(canvas.parentElement);
function layoutTarget() { return { R: 0, cy: 0 }; }

const tmp = new THREE.Vector3(), nrm = new THREE.Vector3();
let last = performance.now(), T = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED; last = now; T += dt;
  const k = 1 - Math.exp(-dt * 3);
  const start = document.body.classList.contains("start");
  const Rpx = Math.max(50, Math.min(W * 0.34, H * (start ? 0.36 : 0.34)));
  camera.position.z = H / (2 * TANH * Rpx);
  globe.rotation.y += dt * 0.12; globe.rotation.x = 0.42; globe.rotation.z = 0.14;
  globe.updateMatrixWorld(); camera.updateMatrixWorld();
  for (const b of blobs.values()) {
    if (b.status === "running" && b.act < 0.25) b.act += dt * 0.6;
    if (b.status === "waiting") b.act = 0.6 + 0.5 * Math.sin(T * 4);
    b.act = Math.max(0, b.act - dt * 1.4);
    b.pos.lerp(b.target, k);
    const act = Math.min(1, b.act), lead = b.id === "lead";
    // keep the point and the spoke on the surface; flare = bigger point + halo ring expanding + brighter spoke
    b.pts.geometry.attributes.position.setXYZ(0, b.pos.x, b.pos.y, b.pos.z); b.pts.geometry.attributes.position.needsUpdate = true;
    const sp = b.spoke.geometry.attributes.position; sp.setXYZ(1, b.pos.x, b.pos.y, b.pos.z); sp.needsUpdate = true;
    tmp.copy(b.pos).applyMatrix4(globe.matrixWorld).project(camera);
    nrm.copy(b.pos).transformDirection(globe.matrixWorld);
    const front = nrm.z > -0.05 ? 1 : 0.3;
    let br = b.status === "done" ? 0.4 : b.status === "error" ? 0.5 : 1;
    if (focus && focus !== b.id) br *= 0.35;
    b.al += (br * front - b.al) * Math.min(1, dt * 8);
    b.pm.size = (lead ? 9 : 6) + act * 7; b.pm.opacity = Math.min(1, b.al * (0.75 + 0.25 * act));
    b.halo.material.size = 10 + (1 - act) * 26 * (act > 0.03 ? 1 : 0); b.halo.material.opacity = act > 0.03 ? act * 0.5 * b.al : 0;
    b.spoke.material.opacity = (0.12 + 0.6 * act) * b.al;
    b.pill.style.left = (tmp.x + 1) / 2 * W + 12 + "px"; b.pill.style.top = (1 - tmp.y) / 2 * H - 12 + "px";
    b.pill.style.opacity = Math.min(1, b.al * 1.3); b.pill.classList.toggle("dim", !!focus && focus !== b.id);
  }
  renderer.render(scene, camera);
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
