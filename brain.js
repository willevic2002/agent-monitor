"use strict";
// Agent Brain: the 3D neuron view of a driven `claude -p` session (same API as app.js; graph from graph.reduce via SSE).
const $ = s => document.querySelector(s);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = RM ? 0.25 : 1;
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
const short = t => (t || "agent").split(":").pop();
const fmtTok = n => !n ? "0" : n < 1e3 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
const toolLabel = i => trunc(String((i && (i.command || i.file_path || i.pattern || i.path || i.url || i.description || i.query)) || "").split("\n")[0], 80);
const PAL = [["#5ee7ff", "#8a7dff"], ["#3df0c0", "#5ee7ff"], ["#ff6ad5", "#9b7bff"], ["#ffb35c", "#ff6ad5"], ["#8dff9e", "#3df0c0"], ["#8a7dff", "#5ee7ff"], ["#ff4d6d", "#ffb35c"]];
const MAX_BLOBS = 7; // lead + 6 subagents; older finished agents only stay in the list
const SV = { running: "running", waiting: "waiting for you", done: "done", error: "error", idle: "ready" };

// ---------- three.js brain ----------
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;
const SHAPE = `
uniform float uTime, uAct, uScale, uPetal, uSeed, uBright, uMerge;
uniform vec3 uCenter, uOut, uColA, uColB, uMergeCol;
vec3 shape(vec3 d, float depth){
  float n  = snoise(d*1.35 + vec3(uSeed, uSeed*0.7, uTime*0.16));
  float n2 = snoise(d*3.2 + vec3(-uSeed, uTime*0.27, 0.0));
  float r = (1.0 + 0.24*n + 0.035*n2 + uAct*0.05*sin(uTime*8.0 + d.x*7.0 + d.y*5.0)) * depth;
  vec3 p = d*r + uOut*max(dot(d,uOut),0.0)*0.38*uPetal;
  return uCenter + p*uScale;
}`;
const LINE_VS = NOISE + SHAPE + `
attribute float aDepth; attribute float aMix; varying vec3 vCol;
void main(){
  vec3 d = normalize(position);
  vec4 mv = modelViewMatrix*vec4(shape(d, aDepth),1.0);
  vec3 nv = normalize(normalMatrix*d);
  float rim = 1.0-abs(nv.z);
  float a = (0.10 + 0.75*rim*rim) * uBright * (0.75 + 0.6*uAct);
  vec3 c = mix(mix(uColA, uColB, aMix), uMergeCol, uMerge*0.55);
  vCol = c*a;
  gl_Position = projectionMatrix*mv;
}`;
const PT_VS = NOISE + SHAPE + `
attribute vec3 aAxis; attribute float aSpeed; uniform float uPx; varying vec3 vCol;
vec3 rot(vec3 v, vec3 k, float a){ return v*cos(a)+cross(k,v)*sin(a)+k*dot(k,v)*(1.0-cos(a)); }
void main(){
  vec3 d = normalize(rot(normalize(position), aAxis, uTime*aSpeed));
  vec4 mv = modelViewMatrix*vec4(shape(d, 0.9 + 0.1*fract(aSpeed*13.0)),1.0);
  gl_PointSize = 0.014*(1.0 + 2.2*uAct)*uScale*uPx/(-mv.z);
  vCol = mix(vec3(1.0), mix(uColA, uMergeCol, uMerge*0.5), 0.45) * (0.3 + 0.7*uAct) * uBright;
  gl_Position = projectionMatrix*mv;
}`;
const LINE_FS = `varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol,1.0); }`;
const PT_FS = `varying vec3 vCol; void main(){ float a = smoothstep(0.5,0.0,length(gl_PointCoord-0.5)); gl_FragColor = vec4(vCol*a,1.0); }`;

const canvas = $("#gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const FOV = 35, TANH = Math.tan(FOV * Math.PI / 360), WORLD_R = 1.6;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
const brain = new THREE.Group();
scene.add(brain);
function glowTex() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,.9)"); gr.addColorStop(0.35, "rgba(255,255,255,.25)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTex();
const rnd = (a, b) => a + Math.random() * (b - a);
const randUnit = () => new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
const MERGE_COL = new THREE.Color("#bff4ff");

/** One agent = one neuron blob: wandering fibres + orbiting sparks + glow sprite. */
function makeBlob(id, k) {
  const [c1, c2] = PAL[k % PAL.length];
  const uni = {
    uTime: { value: 0 }, uAct: { value: 0 }, uScale: { value: 0.05 }, uPetal: { value: 1 }, uSeed: { value: k * 3.7 },
    uBright: { value: 1 }, uMerge: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uOut: { value: new THREE.Vector3(0, 1, 0) },
    uColA: { value: new THREE.Color(c1) }, uColB: { value: new THREE.Color(c2) }, uMergeCol: { value: MERGE_COL }, uPx: { value: pxScale() },
  };
  const pos = [], depth = [], mix = [], tint = randUnit();
  for (let c = 0; c < 130; c++) {
    const a = randUnit(), u = new THREE.Vector3().crossVectors(a, randUnit()).normalize(), v = new THREE.Vector3().crossVectors(a, u);
    const t0 = rnd(0, 6.3), len = rnd(1.4, 5), wob = rnd(0.15, 0.5), fq = rnd(1, 4), ph = rnd(0, 6.3), dp = rnd(0.72, 1.0);
    let prev = null;
    for (let s = 0; s <= 40; s++) {
      const t = t0 + len * s / 40;
      const d = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(v, Math.sin(t)).addScaledVector(a, wob * Math.sin(t * fq + ph)).normalize();
      if (prev) for (const p of [prev, d]) { pos.push(p.x, p.y, p.z); depth.push(dp); mix.push(0.5 + 0.5 * p.dot(tint)); }
      prev = d;
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  lg.setAttribute("aDepth", new THREE.Float32BufferAttribute(depth, 1));
  lg.setAttribute("aMix", new THREE.Float32BufferAttribute(mix, 1));
  const lmat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: LINE_VS, fragmentShader: LINE_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const lines = new THREE.LineSegments(lg, lmat); lines.frustumCulled = false;
  const pp = [], ax = [], sp = [];
  for (let i = 0; i < 70; i++) { const d = randUnit(), x = randUnit(); pp.push(d.x, d.y, d.z); ax.push(x.x, x.y, x.z); sp.push(rnd(0.15, 0.7) * (Math.random() < .5 ? -1 : 1)); }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
  pg.setAttribute("aAxis", new THREE.Float32BufferAttribute(ax, 3));
  pg.setAttribute("aSpeed", new THREE.Float32BufferAttribute(sp, 1));
  const pmat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: PT_VS, fragmentShader: PT_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const pts = new THREE.Points(pg, pmat); pts.frustumCulled = false;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: c1, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.2 }));
  brain.add(lines, pts, glow);
  const pill = document.createElement("button");
  pill.className = "pill"; pill.style.setProperty("--c", c1);
  pill.onclick = () => setFocus(focus === id ? null : id);
  $("#labels").append(pill);
  return { id, uni, glow, pill, act: 0, out: new THREE.Vector3(0, 1, 0), center: new THREE.Vector3(), scale: 0.6, petal: 1, bright: 1,
    dispose() { brain.remove(lines, pts, glow); lg.dispose(); pg.dispose(); lmat.dispose(); pmat.dispose(); glow.material.dispose(); pill.remove(); } };
}

// ---------- state ----------
let W = 0, H = 0, brainR = 200, brainCy = 0, focus = null;
let sid = null, src = null, graph = null, t0 = null, inflight = false;
const blobs = new Map();      // node id -> blob
const info = new Map();       // node id -> { code, k, name }
const pxScale = () => (H || innerHeight) * renderer.getPixelRatio() / (2 * TANH);

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

/** Lay blobs out on a ring (lead on top); a lone lead sits in the middle as one whole brain. */
function layoutBlobs() {
  const list = [...blobs.values()], n = list.length;
  list.forEach((b, i) => {
    const ang = Math.PI / 2 - i * 2 * Math.PI / Math.max(n, 1);
    b.out.set(Math.cos(ang), Math.sin(ang), 0);
    b.center.copy(b.out).multiplyScalar(n === 1 ? 0 : 0.78);
    b.scale = n === 1 ? 1 : n <= 3 ? 0.6 : n <= 5 ? 0.5 : 0.42;
    b.petal = n === 1 ? 0.15 : 1;
    b.uni.uOut.value.copy(b.out);
  });
}

/** Keep blobs in step with the graph: lead + up to 6 subagents, running/waiting ones first. */
function syncBlobs(g) {
  const lead = g.nodes.find(n => n.kind === "lead");
  // finished subagents leave the brain (they stay in the Agenter list); only live ones get a blob
  const ag = g.nodes.filter(n => n.kind !== "lead" && (n.status === "running" || n.status === "waiting"));
  const keep = [lead, ...ag.slice(-(MAX_BLOBS - 1))].filter(Boolean);
  const want = new Set(keep.map(n => n.id));
  let changed = false;
  for (const [id, b] of blobs) if (!want.has(id)) { b.dispose(); blobs.delete(id); changed = true; }
  for (const n of keep) if (!blobs.has(n.id)) { blobs.set(n.id, makeBlob(n.id, meta(n.id).k)); pulse(n.id, 1.4); changed = true; }
  if (changed) {   // keep the lead first, the rest in first-seen order
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

// ---------- layout + frame ----------
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false); canvas.style.width = W + "px"; canvas.style.height = H + "px";
  camera.aspect = W / H; camera.updateProjectionMatrix();
  blobs.forEach(b => b.uni.uPx.value = pxScale());
}
addEventListener("resize", resize);
function layoutTarget() {
  const sw = W >= 1100 ? Math.min(440, Math.max(300, W * 0.26)) + 32 : 0;
  const top = 110, bot = W >= 1100 ? H - 40 : Math.max(top + 120, $("#chat").getBoundingClientRect().top - 36);   // narrow: chat sits below the brain
  return { R: Math.min((W - 2 * sw) * 0.36, (bot - top) * 0.36), cy: (top + bot) / 2 };
}
const tmp = new THREE.Vector3();
let last = performance.now(), T = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED; last = now; T += dt;
  const k = 1 - Math.exp(-dt * 2.4);
  const L = layoutTarget();
  brainR += (L.R - brainR) * k; brainCy += (L.cy - brainCy) * k;
  const camZ = WORLD_R * H / (2 * TANH * Math.max(60, brainR));
  camera.position.z = camZ;
  brain.position.y = (H / 2 - brainCy) / (H / (2 * TANH * camZ));
  brain.rotation.y = Math.sin(T * 0.15) * 0.35;
  brain.rotation.x = Math.sin(T * 0.11) * 0.12;
  brain.updateMatrixWorld(); camera.updateMatrixWorld();
  for (const b of blobs.values()) {
    const u = b.uni;
    if (b.status === "running" && b.act < 0.25) b.act += dt * 0.6;        // live agents keep a slow heartbeat
    if (b.status === "waiting") b.act = 0.6 + 0.5 * Math.sin(T * 4);       // asking for permission: throb
    b.act = Math.max(0, b.act - dt * 1.4);
    u.uTime.value = T; u.uAct.value += (Math.min(1, b.act) - u.uAct.value) * Math.min(1, dt * 8);
    u.uCenter.value.lerp(b.center, k);
    u.uScale.value += (b.scale - u.uScale.value) * k;
    u.uPetal.value += (b.petal - u.uPetal.value) * k;
    let br = b.status === "done" ? 0.4 : b.status === "error" ? 0.3 : 1;
    if (focus && focus !== b.id) br *= 0.3;
    u.uBright.value += (br - u.uBright.value) * k;
    b.glow.position.copy(u.uCenter.value);
    b.glow.scale.setScalar(u.uScale.value * 3.4);
    b.glow.material.opacity = (0.12 + 0.22 * u.uAct.value) * u.uBright.value;
    tmp.copy(u.uCenter.value).addScaledVector(b.out, u.uScale.value * (blobs.size === 1 ? 1.25 : 1.3)).applyMatrix4(brain.matrixWorld).project(camera);
    b.pill.style.left = (tmp.x + 1) / 2 * W + "px"; b.pill.style.top = (1 - tmp.y) / 2 * H + "px";
    b.pill.classList.toggle("dim", !!focus && focus !== b.id);
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
      catch (e) { err("Kunde inte svara: " + e.message); c.querySelectorAll("button").forEach(b => b.disabled = false); }
    };
    c.querySelector(".ok").onclick = () => answer("allow");
    c.querySelector(".no").onclick = () => answer("deny");
    cards.set(p.request_id, c); $("#cards").append(c);
  }
}

// ---------- chat ----------
/** Chat line owned by a node ("lead" or a subagent id); the panel shows the focused node's chat, lead's when nothing is focused. */
function say(who, text, col, owner = "lead") {
  const box = $("#msgs"), d = document.createElement("div"), w = document.createElement("span");
  w.className = "who"; w.textContent = who; if (col) w.style.color = col;
  d.dataset.node = owner; d.hidden = owner !== (focus || "lead");
  d.append(w, trunc(text, 1200)); box.append(d);
  while (box.children.length > 600) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
const err = t => { $("#err").textContent = t || ""; };
async function api(path, body) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 401 || r.status === 403) throw new Error("ogiltig token, starta om appen via startaren");
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
      if (b.type === "text" && b.text) say(node === "lead" ? "LEAD" : meta(node).code, b.text, color(node), node);
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
    const bad = e.is_error || (e.subtype && e.subtype !== "success");
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
  reset(); sid = id; store.set("am.brain", id || "");
  $("#empty").hidden = !!id;
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
    if (r.status === 401 || r.status === 403) { err("Ogiltig token. Starta om appen via startaren."); return; }
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

// ---------- boot ----------
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (t0 !== null) { const s = Math.floor((Date.now() - t0) / 1000); $("#s-time").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
}, 1000);
setInterval(loadSessions, 4000);
resize(); brainCy = layoutTarget().cy; brainR = layoutTarget().R;
reset();
loadSessions().then(() => {
  const saved = store.get("am.brain"), live = sessions.filter(s => s.status !== "ended");
  const pick = sessions.find(s => s.id === saved && s.status !== "ended") || live[live.length - 1];
  if (pick) { connect(pick.id); $("#sess").value = pick.id; }
});
requestAnimationFrame(frame);
