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
const PAL = [["#e8a317", "#f2f2f0"], ["#f2f2f0", "#a8a29a"], ["#f5c451", "#cfcfcc"], ["#a8a29a", "#e8a317"], ["#c98a0c", "#f2f2f0"], ["#cfcfcc", "#7d7f84"], ["#7d7f84", "#f5c451"]];   // amber / white / grey family
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
uniform float uTime, uMT, uAct, uScale, uPetal, uSeed, uBright, uMerge;
uniform vec3 uCenter, uOut, uColA, uColB, uMergeCol;
vec3 shape(vec3 d, float depth){
  float t = uMT;   // morph clock: runs faster while the agent is busy
  // three lobe directions wander on their own orbits; each swells and recedes on its own beat
  vec3 a1 = normalize(vec3(sin(t*0.31+uSeed), cos(t*0.23+uSeed*1.7), sin(t*0.19+2.0)));
  vec3 a2 = normalize(vec3(cos(t*0.17+4.0), sin(t*0.29+uSeed*0.6), cos(t*0.21+1.0)));
  vec3 a3 = normalize(vec3(sin(t*0.13+1.0+uSeed), sin(t*0.37), cos(t*0.27+3.0)));
  float l1 = pow(max(dot(d,a1),0.0),2.0)*sin(t*0.53+uSeed);
  float l2 = pow(max(dot(d,a2),0.0),2.0)*sin(t*0.41+2.0+uSeed);
  float l3 = pow(max(dot(d,a3),0.0),2.0)*sin(t*0.67+4.0);
  float n  = snoise(d*1.35 + vec3(uSeed + t*0.17, uSeed*0.7 - t*0.11, t*0.14));
  float n2 = snoise(d*3.4 + vec3(-uSeed, t*0.3, -t*0.2));
  float r = (1.0 + 0.16*n + 0.03*n2 + 0.42*l1 + 0.34*l2 + 0.28*l3 + uAct*0.04*sin(uTime*8.0 + d.x*7.0 + d.y*5.0)) * depth;
  vec3 p = d*r * vec3(1.0+0.18*sin(t*0.21), 1.0+0.18*sin(t*0.17+2.0), 1.0+0.18*sin(t*0.14+4.0));   // axes stretch out of phase
  p += uOut*max(dot(d,uOut),0.0)*0.38*uPetal;
  return uCenter + p*uScale;
}`;
const LINE_VS = NOISE + SHAPE + `
attribute float aDepth; attribute float aMix; varying vec3 vCol;
void main(){
  vec3 d = normalize(position);
  vec4 mv = modelViewMatrix*vec4(shape(d, aDepth),1.0);
  vec3 nv = normalize(normalMatrix*d);
  float rim = 1.0-abs(nv.z);
  float a = (0.07 + 0.55*rim*rim) * uBright * (0.7 + 0.5*uAct);
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
  gl_PointSize = 0.010*(1.0 + 2.2*uAct)*uScale*uPx/(-mv.z);
  vCol = mix(vec3(1.0), mix(uColA, uMergeCol, uMerge*0.5), 0.45) * (0.25 + 0.6*uAct) * uBright;
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
const rnd = (a, b) => a + Math.random() * (b - a);
const randUnit = () => new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
const MERGE_COL = new THREE.Color("#fff0d0");

/** One agent = one neuron blob: wandering fibres + orbiting sparks + glow sprite. */
function makeBlob(id, k) {
  const [c1, c2] = PAL[k % PAL.length];
  const uni = {
    uTime: { value: 0 }, uMT: { value: k * 7 }, uAct: { value: 0 }, uScale: { value: 0.05 }, uPetal: { value: 1 }, uSeed: { value: k * 3.7 },
    uBright: { value: 1 }, uMerge: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uOut: { value: new THREE.Vector3(0, 1, 0) },
    uColA: { value: new THREE.Color(c1) }, uColB: { value: new THREE.Color(c2) }, uMergeCol: { value: MERGE_COL }, uPx: { value: pxScale() },
  };
  const pos = [], depth = [], mix = [], tint = randUnit();
  for (let c = 0; c < (k === 0 ? 380 : 300); c++) {
    const a = randUnit(), u = new THREE.Vector3().crossVectors(a, randUnit()).normalize(), v = new THREE.Vector3().crossVectors(a, u);
    const t0 = rnd(0, 6.3), len = rnd(1.4, 5), wob = rnd(0.15, 0.5), fq = rnd(1, 4), ph = rnd(0, 6.3), dp = rnd(0.72, 1.0);
    let prev = null;
    for (let s = 0; s <= 32; s++) {
      const t = t0 + len * s / 32;
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
  for (let i = 0; i < 90; i++) { const d = randUnit(), x = randUnit(); pp.push(d.x, d.y, d.z); ax.push(x.x, x.y, x.z); sp.push(rnd(0.15, 0.7) * (Math.random() < .5 ? -1 : 1)); }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.Float32BufferAttribute(pp, 3));
  pg.setAttribute("aAxis", new THREE.Float32BufferAttribute(ax, 3));
  pg.setAttribute("aSpeed", new THREE.Float32BufferAttribute(sp, 1));
  const pmat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: PT_VS, fragmentShader: PT_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const pts = new THREE.Points(pg, pmat); pts.frustumCulled = false;
  brain.add(lines, pts);
  const pill = document.createElement("button");
  pill.className = "pill"; pill.style.setProperty("--c", c1);
  pill.onclick = () => setFocus(focus === id ? null : id);
  $("#labels").append(pill);
  return { id, uni, pill, mt: k * 7, act: 0, out: new THREE.Vector3(0, 1, 0), center: new THREE.Vector3(), scale: 0.6, petal: 1, bright: 1,
    dispose() { brain.remove(lines, pts); lg.dispose(); pg.dispose(); lmat.dispose(); pmat.dispose(); pill.remove(); } };
}

// ---------- state ----------
let W = 0, H = 0, brainR = 200, brainCy = 0, brainCx = 0, focus = null;
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
  if (document.body.classList.contains("start")) return { R: H * 0.15, cy: H * 0.28, cx: W / 2 };   // start screen: brain in the upper half, clock under it
  const r = $("#stage").getBoundingClientRect(), top = r.top + 10, bot = $("#stats").getBoundingClientRect().top - 10;
  const f = blobs.size === 1 ? 0.5 : 0.36;   // a lone brain fills the stage; a ring of subagents needs room around it
  return { R: Math.min(r.width * f, (bot - top) * f), cy: (top + bot) / 2, cx: r.left + r.width / 2 };
}
const tmp = new THREE.Vector3();
let last = performance.now(), T = 0, spin = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * SPEED; last = now; T += dt;
  const k = 1 - Math.exp(-dt * 2.4);
  const L = layoutTarget();
  brainR += (L.R - brainR) * k; brainCy += (L.cy - brainCy) * k; brainCx += (L.cx - brainCx) * k;
  const camZ = WORLD_R * H / (2 * TANH * Math.max(60, brainR));
  camera.position.z = camZ;
  const ppu = H / (2 * TANH * camZ);
  brain.position.y = (H / 2 - brainCy) / ppu; brain.position.x = (brainCx - W / 2) / ppu;
  // lone lead turns continuously; with subagents around it eases back to the front-facing wobble so their layout stays readable
  if (blobs.size === 1) spin += dt * 0.5; else spin -= (spin - Math.round(spin / 6.2832) * 6.2832) * k;
  brain.rotation.y = spin + Math.sin(T * 0.15) * 0.35;
  brain.rotation.x = Math.sin(T * 0.19) * (blobs.size === 1 ? 0.45 : 0.12);
  brain.updateMatrixWorld(); camera.updateMatrixWorld();
  for (const b of blobs.values()) {
    const u = b.uni;
    if (b.status === "running" && b.act < 0.25) b.act += dt * 0.6;        // live agents keep a slow heartbeat
    if (b.status === "waiting") b.act = 0.6 + 0.5 * Math.sin(T * 4);       // asking for permission: throb
    b.act = Math.max(0, b.act - dt * 1.4);
    b.mt += dt * (0.9 + 2.2 * Math.min(1, b.act)); u.uMT.value = b.mt;   // busy agents morph faster
    u.uTime.value = T; u.uAct.value += (Math.min(1, b.act) - u.uAct.value) * Math.min(1, dt * 8);
    u.uCenter.value.lerp(b.center, k);
    u.uScale.value += (b.scale - u.uScale.value) * k;
    u.uPetal.value += (b.petal - u.uPetal.value) * k;
    let br = b.status === "done" ? 0.4 : b.status === "error" ? 0.3 : 1;
    if (focus && focus !== b.id) br *= 0.3;
    u.uBright.value += (br - u.uBright.value) * k;
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
    t.className = "n";
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
resize(); { const L = layoutTarget(); brainCy = L.cy; brainR = L.R; brainCx = L.cx; }
reset();
loadSessions();   // no auto-connect: the start screen stays until a prompt is sent or a session is picked
requestAnimationFrame(frame);
