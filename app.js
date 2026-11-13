const $ = s => document.querySelector(s);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const FONT = '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace';
const SV = { running: "running", waiting: "waiting for permission", done: "done", error: "error", idle: "waiting" };
const ST = { idle: "ready", running: "running", ended: "ended" };
const PRE = { running: "▶", waiting: "⏸", done: "✓", error: "✕", idle: "" };
const short = t => (t || "agent").split(":").pop();
const modelName = m => (m || "claude").replace("claude-", "").replace(/-(\d+)-(\d+).*/, " $1.$2");
const fmtTok = n => n == null ? "– tok" : n < 1e3 ? n + " tok" : n < 1e6 ? (n / 1e3).toFixed(1) + "k tok" : (n / 1e6).toFixed(1) + "M tok";
const isReview = t => /review|security|adversarial|verif/.test(t || "");
const hhmm = ts => { const d = ts && new Date(ts); return d && !isNaN(d) ? d.toLocaleTimeString("en-GB") : ""; };
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "…" : (s || "");
const rm = matchMedia("(prefers-reduced-motion: reduce)");
let sel = store.get("am.sel"), kind = "observed", drivenList = [], es = null, ended = false, last = null, view = store.get("am.view") === "list" ? "list" : "graph";
let cy = null, userMoved = false, pulseT = null, opener = null, curGraph = null, logSeq = 0;

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) k === "class" ? e.className = props[k] : k.startsWith("on") ? e.addEventListener(k.slice(2), props[k]) : e.setAttribute(k, props[k]);
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

/* ---------- cytoscape ---------- */
function styles() {
  const fs = { "font-family": FONT };
  return [
    { selector: "node", style: { shape: "round-rectangle", width: 220, height: 84, "background-color": v("--panel"), "border-width": 1.5, "border-color": v("--line2"),
        label: "data(label)", color: v("--text"), ...fs, "font-size": 11, "text-wrap": "wrap", "text-max-width": 204, "text-valign": "center", "text-halign": "center", "line-height": 1.35 } },
    { selector: "node[?lead]", style: { width: "data(w)", height: 44, "text-max-width": 2000, "border-width": 2, "border-color": v("--green"), "background-color": v("--green-bg"), "font-weight": 600 } },
    { selector: 'node[status="running"]', style: { "border-color": v("--amber"), "background-color": v("--amber-bg"), "border-width": rm.matches ? 3 : 2,
        ...(rm.matches ? {} : { "transition-property": "border-width border-opacity", "transition-duration": "0.8s" }) } },
    { selector: 'node[status="running"][?review]', style: { "border-color": v("--violet"), "background-color": v("--violet-bg") } },
    { selector: 'node[status="waiting"]', style: { "border-color": v("--pink"), "background-color": v("--pink-bg"), "border-style": "double", "border-width": 4 } },
    { selector: 'node[status="done"]', style: { "border-color": v("--green"), "background-color": v("--green-bg") } },
    { selector: 'node[status="error"]', style: { "border-color": v("--red"), "background-color": v("--red-bg"), "border-style": "dashed" } },
    { selector: "node[sum]", style: { height: 50, "font-size": 10, color: v("--muted") } },
    { selector: "node.pulse", style: { "border-width": 4, "border-opacity": 0.45 } },
    { selector: "node:selected", style: { "overlay-color": v("--blue"), "overlay-opacity": 0.12, "overlay-padding": 5, "border-color": v("--blue") } },
    { selector: "$node > node", style: { shape: "round-rectangle", "background-color": v("--panel"), "background-opacity": 0.35, "border-width": 1, "border-style": "dashed",
        "border-color": v("--line2"), padding: 18, label: "data(label)", "text-valign": "top", "text-halign": "center", "text-margin-y": -6, "font-size": 10,
        color: v("--muted"), "text-transform": "uppercase", events: "no", ...fs } },
    { selector: "node.wave-current", style: { "border-style": "solid", "border-color": v("--blue"), color: v("--blue") } },
    { selector: "edge", style: { width: 1.5, "curve-style": "taxi", "taxi-direction": "rightward", "taxi-turn": "data(turn)", "taxi-turn-min-distance": 6,
        "source-endpoint": "50% 0%", "target-endpoint": "-50% 0%", "target-arrow-shape": "triangle", "arrow-scale": 0.9, "line-color": v("--amber"), "target-arrow-color": v("--amber"),
        "target-label": "data(lbl)", "target-text-offset": e => 22 + 2.9 * e.data("lbl").length, "font-size": 9, color: v("--muted"), "text-background-color": v("--bg"), "text-background-opacity": 1,
        "text-background-padding": 2, "min-zoomed-font-size": 7, "text-margin-y": -9, ...fs } },
    { selector: 'edge[st="wait"]', style: { "line-color": v("--pink"), "target-arrow-color": v("--pink") } },
    { selector: 'edge[st="done"]', style: { "line-style": "dashed", "line-dash-pattern": [6, 4], "line-color": v("--green"), "target-arrow-color": v("--green"),
        "source-arrow-shape": "triangle", "source-arrow-color": v("--green") } },
    { selector: 'edge[st="err"]', style: { "line-color": v("--red"), "target-arrow-color": v("--red") } },
    { selector: 'edge[?fromLead][st="done"], edge[?fromLead][st="err"]', style: { "line-color": v("--line2") } }, // shared bus trunk stays neutral; arrow keeps status colour
    { selector: 'edge[dir="down"]', style: { "taxi-direction": "downward", "taxi-turn": 0 } },
  ];
}
function initCy() {
  if (cy || typeof cytoscape === "undefined") return;
  cy = cytoscape({ container: $("#cy"), elements: [], style: styles(), layout: { name: "preset" }, minZoom: 0.3, maxZoom: 1.1, boxSelectionEnabled: false, autoungrabify: true });
  cy.on("tap", "node", e => {
    const t = e.target, sum = t.data("sum"), wv = t.data("wave");
    if (sum != null) { openWaves.add(sum); if (curGraph) sync(curGraph); return; }
    if (wv != null && t.isParent()) { if (openWaves.delete(wv) && curGraph) sync(curGraph); return; } cy.$(":selected").unselect(); e.target.select(); openLog(e.target.id(), $("#cy")); });
  cy.on("tap", e => { if (e.target === cy) cy.$(":selected").unselect(); });
  cy.on("userviewport", () => { userMoved = true; });
}
function nodeLabel(n, desc) {
  const st = n.status || "idle", pre = PRE[st] ? PRE[st] + " " : "", m = `${modelName(n.model).toLowerCase()} · ${SV[st] || st}`, t = `${n.tools || 0} verktyg · ${fmtTok(n.tokens)}`;
  if (n.kind === "lead") return `${pre}lead · ${m} · ${t}`;
  return `${pre}${short(n.agent_type || n.label)}\n${trunc(desc || "", 26)}\n${m}\n${t}`;
}
const openWaves = new Set(); // finished waves the user unfolded
let showAll = store.get("am.scope") === "all";
function sync(g) {
  initCy(); if (!cy) return;
  const waves = g.waves || [], nodes = g.nodes || [], edges = g.edges || [];
  const want = new Map(); // id -> {group,data,pos}
  const agents = nodes.filter(n => n.kind !== "lead");
  const col = new Map(); // wave key -> [nodes]
  agents.forEach(n => { const k = n.wave != null && waves.some(w => w.index === n.wave) ? n.wave : "x"; (col.get(k) || col.set(k, []).get(k)).push(n); });
  const all = [...(col.has("x") ? ["x"] : []), ...waves.map(w => w.index).filter(i => col.has(i))];
  // finished waves fold into one "Avklarat" column (one summary row each); click a row to unfold it
  const folded = k => { const w = waves.find(w => w.index === k);
    return !showAll && w && w.status !== "running" && !openWaves.has(k) && col.get(k).every(n => !["running", "waiting", "error"].includes(n.status)); };
  const done = all.filter(folded), keys = all.filter(k => !folded(k));
  const hasWaves = waves.length > 0, COLW = 260, X0 = 0, Y0 = 130, colX = new Map();
  const desc = new Map(edges.filter(e => e.kind !== "handback").map(e => [e.target, e.label]));
  const off = done.length ? 1 : 0;
  if (done.length) {
    want.set("wave:done", { data: { id: "wave:done", wave: "done", label: "Avklarat" } });
    done.forEach((k, j) => { const w = waves.find(w => w.index === k), l = col.get(k), tok = l.reduce((a, n) => a + (n.tokens || 0), 0);
      want.set("sum:" + k, { data: { id: "sum:" + k, parent: "wave:done", sum: k, status: "done", label: `✓ ${trunc(w.name, 26)}\n${l.length} agenter · ${fmtTok(tok)}` }, pos: { x: X0, y: Y0 - 17 + 64 * j } }); });
  }
  keys.forEach((k, i) => {
    const list = col.get(k), x = X0 + COLW * (i + off); colX.set(k, x);
    if (hasWaves) {
      const w = waves.find(w => w.index === k);
      want.set("wave:" + k, { data: { id: "wave:" + k, wave: k, label: w ? `${w.name}${openWaves.has(k) ? " · collapse ▴" : ""}` : "Other" }, cls: w && w.status === "running" ? "wave-current" : "" });
    }
    list.forEach((n, j) => want.set(n.id, { data: { id: n.id, parent: hasWaves ? "wave:" + k : undefined }, pos: { x, y: Y0 + 104 * j }, n }));
  });
  const lead = nodes.find(n => n.kind === "lead");
  // lead = header bar spanning all wave columns (no per-agent wires; status shows dispatch/handback)
  const span = Math.max(1, keys.length + off);
  if (lead) want.set(lead.id, { data: { id: lead.id, lead: true, w: Math.max(420, (span - 1) * COLW + 256) }, pos: { x: X0 + (span - 1) * COLW / 2, y: 0 }, n: lead });
  for (const [id, w] of want) if (w.n) {
    const n = w.n;
    Object.assign(w.data, { label: nodeLabel(n, desc.get(n.id)), status: n.status || "idle", review: isReview(n.agent_type), agent_id: n.agent_id || null });
  }
  // one edge per agent (id "e:<agent>": node ids already take the bare id); vertical run sits in the gutter left of the target column
  const hb = new Map(edges.filter(e => e.kind === "handback").map(e => [e.source, e]));
  // only nested dispatch (agent -> sub-agent) is drawn as a wire
  edges.filter(e => e.kind !== "handback" && !(lead && e.source === lead.id)).forEach(e => {
    const t = want.get(e.target), sp = want.get(e.source); if (!t || !sp || !t.n) return;
    const h = hb.get(e.target), stt = t.n.status, k = t.n.wave != null && colX.has(t.n.wave) ? t.n.wave : "x";
    const srcX = e.source === (lead && lead.id) ? 115 : sp.pos.x + 100;
    const st = stt === "error" ? "err" : stt === "waiting" ? "wait" : h || stt === "done" ? "done" : "run";
    const lbl = (st === "done" ? "↩ " : "") + trunc(e.label, 28);
    want.set("e:" + e.target, { edge: true, data: { id: "e:" + e.target, source: e.source, target: e.target, st, lbl, fromLead: e.source === (lead && lead.id), dir: colX.get(k) - 290 - srcX < 8 ? "down" : "r", turn: Math.max(8, colX.get(k) - 290 - srcX) } });
  });
  let added = false;
  const before = cy.elements().length;
  cy.batch(() => {
    cy.elements().forEach(x => { if (!want.has(x.id())) cy.remove(x); });
    for (const [id, w] of want) {
      if (w.edge && !(want.has(w.data.source) && want.has(w.data.target))) continue;
      let x = cy.getElementById(id);
      if (x.empty()) continue;
      const { parent, ...d } = w.data; x.data(d);
      if (!w.edge && w.data.wave == null && (x.data("parent") || null) !== (parent || null)) x.move({ parent: parent || null });
      if (w.pos && (x.position("x") !== w.pos.x || x.position("y") !== w.pos.y)) x.position(w.pos);
    }
    const add = pred => { for (const [id, w] of want) if (pred(w) && cy.getElementById(id).empty()) {
      if (w.edge && !(want.has(w.data.source) && want.has(w.data.target))) continue;
      cy.add({ group: w.edge ? "edges" : "nodes", data: w.data, position: w.pos, classes: w.cls || "" }); added = true; } };
    add(w => w.data.wave != null); add(w => !w.edge && w.data.wave == null); add(w => w.edge);
    for (const [id, w] of want) if (w.data.wave != null) cy.getElementById(id).toggleClass("wave-current", w.cls === "wave-current");
  });
  if ((added || cy.elements().length < before) && !userMoved) fitGraph();
  $("#hint").hidden = agents.length > 0;
  updatePulse();
}
// minZoom clamps wide graphs: then anchor the lead (left edge) instead of centring and cutting both ends
function fitGraph() {
  cy.fit(undefined, 40);
  if (cy.zoom() < 0.6) { // big graph: stay readable, centre on the active node (user can still zoom out)
    const ns = cy.nodes().filter(n => !n.isParent()), pick = ns.filter('[status="running"]')[0] || ns.filter('[status="waiting"]')[0] || ns.filter("[?lead]")[0] || ns[0];
    cy.zoom({ level: Math.max(0.6, cy.minZoom()), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    if (pick) cy.center(pick);
  } else
  if (cy.zoom() <= cy.minZoom() + 1e-6) cy.pan({ x: 40 - cy.elements().boundingBox().x1 * cy.zoom(), y: cy.pan().y });
}
function updatePulse() {
  const any = cy && cy.nodes('[status="running"]').length > 0 && !rm.matches;
  if (any && !pulseT) pulseT = setInterval(() => cy.nodes('[status="running"]').toggleClass("pulse"), 800);
  if (!any && pulseT) { clearInterval(pulseT); pulseT = null; cy && cy.nodes().removeClass("pulse"); }
}
rm.addEventListener("change", () => { if (cy) { cy.style(styles()); updatePulse(); } });

/* ---------- list view ---------- */
function renderList(g) {
  const root = $("#nodelist"), fid = document.activeElement?.dataset?.node; root.replaceChildren();
  const agents = (g.nodes || []).filter(n => n.kind !== "lead");
  if (!agents.length) { root.append(el("p", { class: "empty" }, "No agents yet.")); return; }
  const waves = g.waves || [], groups = new Map();
  agents.forEach(n => { const w = waves.find(w => w.index === n.wave); const k = w ? `Wave ${w.index + 1} · ${w.name}` : "Other"; (groups.get(k) || groups.set(k, []).get(k)).push(n); });
  const ol = el("ol", { "aria-label": "Agenter" });
  for (const [name, list] of groups) {
    const inner = el("ol");
    list.forEach(n => {
      const st = n.status || "idle", b = el("button", { class: st + (st === "running" && isReview(n.agent_type) ? " review" : ""), "data-node": n.id, onclick: e => openLog(n.id, e.currentTarget) },
        `${PRE[st]} ${short(n.agent_type || n.label)} — ${modelName(n.model)} — ${SV[st] || st} — ${n.tools || 0} verktyg — ${fmtTok(n.tokens)}`);
      if (n.description) b.append(el("span", { class: "sub" }, "dispatchad av lead: " + n.description));
      inner.append(el("li", null, b));
    });
    ol.append(el("li", null, el("h3", null, name), inner));
  }
  root.append(ol);
  if (fid) root.querySelector(`[data-node="${CSS.escape(fid)}"]`)?.focus();
}

/* ---------- log panel ---------- */
async function openLog(nodeId, invoker) {
  const s = curSession(); if (!s || !curGraph) return;
  const n = (curGraph.nodes || []).find(x => x.id === nodeId); if (!n) return;
  opener = invoker || opener;
  const seq = ++logSeq;
  $("#log-h").textContent = `${n.kind === "lead" ? "lead" : short(n.agent_type || n.label)} · ${modelName(n.model)}`;
  const st = n.status || "idle"; $("#log-st").textContent = `${PRE[st]} ${SV[st] || st}`.trim();
  $("#log-meta").textContent = `${n.tools || 0} verktyg · ${fmtTok(n.tokens)}` + (n.started ? ` · start ${hhmm(n.started)}` : "") + (n.ended ? ` · slut ${hhmm(n.ended)}` : "");
  const body = $("#log-body"); body.replaceChildren(el("p", { class: "muted" }, "laddar…"));
  $("#log").classList.add("open"); $("#log-h").focus();
  const node = n.kind === "lead" ? "lead" : (n.agent_id || "lead");
  try {
    const r = await fetch(`/api/log?session=${encodeURIComponent(s.id)}&node=${encodeURIComponent(node)}`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw 0;
    const j = await r.json(); if (seq !== logSeq) return;
    const ents = Array.isArray(j) ? j : (j.entries || j.lines || []);
    body.replaceChildren();
    if (n.description) body.append(el("p", { class: "muted" }, n.description));
    const hbk = (curGraph.edges || []).find(x => x.kind === "handback" && x.source === nodeId);
    if (hbk && hbk.label) body.append(el("p", { class: "muted" }, "↩ " + hbk.label));
    if (!ents.length) body.append(el("p", { class: "muted" }, "No log yet."));
    ents.forEach(e => body.append(el("div", { class: "ent " + (e.role === "user" ? "user" : "") },
      el("div", { class: "r" }, `${e.role || ""} ${hhmm(e.ts)} `, e.tool ? el("span", { class: "tl" }, e.tool) : null),
      el("div", { class: "x" }, String(e.text ?? "")))));
  } catch {
    if (seq !== logSeq) return;
    body.replaceChildren(el("p", { class: "muted" }, "Could not read the log. "), el("button", { class: "btn", onclick: () => openLog(nodeId) }, "Try again"));
  }
}
function closeLog() {
  if (!$("#log").classList.contains("open")) return;
  logSeq++; $("#log").classList.remove("open");
  const id = opener?.dataset?.node, t = (id && $(`[data-node="${CSS.escape(id)}"]`)) || (opener?.isConnected ? opener : null) || $("#cy");
  t.focus();
  if (cy) cy.$(":selected").unselect();
}
$("#log-x").addEventListener("click", closeLog);
addEventListener("keydown", e => {
  if (e.key === "Escape") closeLog();
  if (e.altKey && e.key.toLowerCase() === "l") setView(view === "graph" ? "list" : "graph");
});


/* ---------- view / sessions ---------- */
function setView(x) {
  view = x; store.set("am.view", x);
  $("#v-graph").setAttribute("aria-pressed", x === "graph"); $("#v-list").setAttribute("aria-pressed", x === "list");
  $("#cy").hidden = x !== "graph"; $("#nodelist").hidden = x !== "list"; $("#scope").hidden = x !== "graph";
  if (x === "graph" && cy) fitView();
}
function fitView() { cy.resize(); fitGraph(); }
addEventListener("resize", () => { if (cy && !$("#cy").hidden) { cy.resize(); if (!userMoved) fitGraph(); } });
$("#v-graph").onclick = () => setView("graph"); $("#v-list").onclick = () => setView("list");
function setScope(all) {
  showAll = all; store.set("am.scope", all ? "all" : "now");
  $("#s-now").setAttribute("aria-pressed", !all); $("#s-all").setAttribute("aria-pressed", all);
  if (curGraph) { userMoved = false; sync(curGraph); fitGraph(); }
}
$("#s-now").onclick = () => setScope(false); $("#s-all").onclick = () => setScope(true);
$("#s-now").setAttribute("aria-pressed", !showAll); $("#s-all").setAttribute("aria-pressed", showAll);
const curSession = () => kind === "driven" ? (curGraph && curGraph.session && { id: curGraph.session.id }) : last && (last.sessions || []).find(s => s.id === sel);
const drivenEntry = () => drivenList.find(s => s.id === sel);

function reset() {
  if (es) { es.close(); es = null; }
  userMoved = false; closeLog(); curGraph = null; openWaves.clear(); ended = false;
  if (cy) cy.elements().remove();
  $("#nodelist").replaceChildren(); $("#hint").hidden = true; $("#sr-chat").textContent = "";
  chatReset(); perr(""); permReset();
}
function pick(id, k) {
  if (sel === id && kind === k) return;
  reset(); sel = id; kind = k;
  if (k === "observed") store.set("am.sel", id);
  if (k === "driven") connect(id);
  chrome(); render(last);
}
function chrome() {
  const d = kind === "driven", s = d ? drivenEntry() : null;
  $("#main").classList.toggle("chat-on", d);
  if (d) $("#ttl").textContent = s ? (s.title || s.id.slice(0, 8)) : "", $("#cwd").textContent = s ? s.cwd : "";
  if (kind === "new") { $("#ttl").textContent = "New session"; $("#cwd").textContent = ""; msg("Type the first prompt below to start the session."); curGraph = null; }
  const pr = $("#prompt");
  const can = (d && !ended) || kind === "new" || kind === "observed";
  pr.disabled = !can; $("#send").disabled = !(can && kind !== "observed");
  pr.placeholder = d && ended ? "The session has ended" : kind === "observed" ? "Observed session — type a prompt and click Continue here"
    : kind === "new" ? "First prompt (Enter sends, Shift+Enter for a new line)" : d ? "Type a prompt or /command … (Enter sends, Shift+Enter for a new line)" : "Select or create a session";
  const run = d && s && !ended && (s.status === "running" || s.status === "waiting");
  $("#stop").hidden = !run; $("#mode").hidden = !(d && s && !ended);
  if (d && s && s.mode && document.activeElement !== $("#mode") && !modeBusy) $("#mode").value = s.mode;
  renderSidebar();
}

/* sidebar */
function renderSidebar() {
  const nav = $("#list"), fk = document.activeElement?.dataset?.key, ss = (last && last.sessions) || [];
  nav.replaceChildren(el("p", { class: "lbl", style: "margin-top:0" }, "Styrda"));
  if (!drivenList.length) nav.append(el("p", { class: "muted" }, "No driven sessions."));
  drivenList.forEach(s => {
    const k = "d:" + s.id;
    nav.append(el("div", { class: "item" }, el("button", { class: "sess", "data-testid": "session", "data-kind": "driven", "data-key": k, "aria-current": kind === "driven" && s.id === sel ? "true" : "false", onclick: () => pick(s.id, "driven") },
      el("div", { class: "t" }, el("span", { class: "dot" + (s.status === "running" ? " on" : "") }), s.title || s.id.slice(0, 8)),
      el("div", { class: "m" }, el("span", { class: "pill bl" }, "driven"), el("span", { class: s.status === "waiting" ? "pill pk" : "" }, s.status === "waiting" ? `⏸ waiting for permission (${s.pending || 0})` : ST[s.status] || s.status || "")))));
  });
  nav.append(el("p", { class: "lbl" }, "Observerade"));
  if (!ss.length) nav.append(el("p", { class: "muted" }, "No observed sessions."));
  ss.forEach(s => {
    const waiting = ((s.graph && s.graph.nodes) || []).some(n => n.status === "waiting"), k = "o:" + s.id;
    nav.append(el("div", { class: "item" },
      el("button", { class: "sess", "data-testid": "session", "data-kind": "observed", "data-key": k, "aria-current": kind === "observed" && s.id === sel ? "true" : "false", onclick: () => pick(s.id, "observed") },
        el("div", { class: "t" }, el("span", { class: "dot" + (s.busy ? " on" : "") }), s.title || s.id.slice(0, 8)),
        el("div", { class: "m" }, el("span", { class: "pill" }, "observed"), waiting ? el("span", { class: "pill pk" }, "⏸ permission") : null,
          el("span", null, `${(s.agents || []).filter(a => a.status === "running").length} running`))),
      el("button", { class: "btn", "data-testid": "resume", "data-key": "r:" + s.id, "aria-label": "Continue here (new branch): " + (s.title || s.id.slice(0, 8)), ...(inflight ? { disabled: "" } : {}), onclick: () => resume(s) }, "Continue here")));
  });
  if (fk) nav.querySelector(`[data-key="${CSS.escape(fk)}"]`)?.focus();
}
$("#list").addEventListener("keydown", e => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const bs = [...document.querySelectorAll("#list .sess")], i = bs.indexOf(document.activeElement); if (i < 0) return;
  e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus();
});

/* new session form */
function openForm(on) {
  $("#newform").hidden = !on; $("#new-session").setAttribute("aria-expanded", on);
  if (on) {
    if (!$("#ncwd").value) $("#ncwd").value = store.get("am.cwd") || "";
    reset(); sel = null; kind = "new"; chrome(); $("#ncwd").focus();
  } else if (kind === "new") { sel = null; kind = "none"; $("#ttl").textContent = ""; $("#cwd").textContent = ""; chrome(); render(last); }
}
$("#new-session").onclick = () => openForm($("#newform").hidden);
$("#ncancel").onclick = () => { openForm(false); $("#new-session").focus(); };
$("#newform").addEventListener("submit", e => { e.preventDefault(); $("#prompt").focus(); });
$("#ncwd").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("#prompt").focus(); } });
$("#ncwd").addEventListener("input", () => $("#ncwd").removeAttribute("aria-invalid"));
addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#newform").hidden && !$("#log").classList.contains("open")) { openForm(false); $("#new-session").focus(); }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !$("#prompt").disabled) { e.preventDefault(); $("#prompt").focus(); }
});

/* ---------- api ---------- */
async function api(path, body) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { status: r.status });
  return j;
}
const perr = t => { $("#perr").textContent = t || ""; };
let inflight = false;
function busy(b) { inflight = b; $("#send").disabled = b || kind === "observed" || $("#prompt").disabled; $("#send").textContent = b ? "sending…" : "Send"; document.querySelectorAll("#list [data-testid=resume]").forEach(x => { x.disabled = b; }); }
async function startSession(cwd, prompt, mode, resumeId) {
  const j = await api("/api/sessions", { cwd, prompt, mode, ...(resumeId ? { resume: resumeId } : {}) });
  store.set("am.cwd", cwd); await loadDriven();
  if (!$("#newform").hidden) openForm(false);
  kind = "none"; pick(j.id, "driven");
}
async function resume(s) {
  const pr = $("#prompt"), text = pr.value;
  if (!text.trim()) { pick(s.id, "observed"); pr.focus(); perr("Type a prompt first — it is sent when you continue here."); return; }
  if (inflight) return;
  perr(""); busy(true);
  try { await startSession(s.cwd, text, $("#nmode").value, s.id); pushHist(text); pr.value = ""; grow(); }
  catch (e) { perr("Could not continue: " + e.message); }
  busy(false); chrome();
}
async function send() {
  const pr = $("#prompt"), text = pr.value;
  if (inflight || !text.trim()) return;
  if (kind === "observed") { perr("Click Continue here to resume this session."); return; }
  if (kind !== "driven" && kind !== "new") { perr("Select a session or create a new one."); return; }
  perr(""); busy(true);
  try {
    if (kind === "new") {
      const cwd = $("#ncwd").value.trim();
      if (!cwd) { $("#ncwd").setAttribute("aria-invalid", "true"); $("#ncwd").focus(); throw new Error("Ange arbetskatalog"); }
      try { await startSession(cwd, text, $("#nmode").value); } catch (e) { $("#ncwd").setAttribute("aria-invalid", "true"); throw e; }
    } else { await api(`/api/sessions/${encodeURIComponent(sel)}/prompt`, { text }); }
    pushHist(text); pr.value = ""; grow();
  } catch (e) { perr("✕ Fel: " + e.message); }
  busy(false); chrome();
}
$("#send").onclick = send;

/* prompt box: history + autosize */
const hist = () => { try { const h = JSON.parse(store.get("am.hist") || "[]"); return Array.isArray(h) ? h : []; } catch { return []; } };
let hi = null, draft = "";
function pushHist(t) { const h = hist().filter(x => x !== t); h.push(t); store.set("am.hist", JSON.stringify(h.slice(-100))); hi = null; }
function grow() { const p = $("#prompt"); p.style.height = "auto"; p.style.height = Math.min(p.scrollHeight, 160) + "px"; }
$("#prompt").addEventListener("input", () => { hi = null; grow(); });
$("#prompt").addEventListener("keydown", e => {
  const p = e.target;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return; }
  if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || p.selectionStart !== p.selectionEnd) return;
  const h = hist(), up = e.key === "ArrowUp";
  if (up ? p.value.lastIndexOf("\n", p.selectionStart - 1) !== -1 && p.selectionStart > 0 : p.value.indexOf("\n", p.selectionEnd) !== -1) return;
  if (up) { if (!h.length || hi === 0) return; if (hi === null) { draft = p.value; hi = h.length; } hi--; }
  else { if (hi === null) return; hi++; }
  e.preventDefault();
  p.value = hi >= h.length ? (hi = null, draft) : h[hi];
  p.setSelectionRange(p.value.length, p.value.length); grow();
});

/* ---------- chat ---------- */
const chat = $("#chat"), tools = new Map(), agents = new Map(), handed = new Set();
let lastText = "";
function chatReset() { chat.replaceChildren(el("p", { class: "chat-empty" }, "Type a prompt below to begin.")); tools.clear(); agents.clear(); handed.clear(); lastText = ""; }
const atBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
function keep(fn) { const b = atBottom(); fn(); if (b) chat.scrollTop = chat.scrollHeight; }
function add(node) { keep(() => { chat.querySelector(".chat-empty")?.remove(); chat.append(node); }); }
const line = (role, text, cls) => el("div", { class: "msg " + role + (cls ? " " + cls : ""), "data-testid": "chat-msg", "data-role": role }, text);
const blockText = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(x => (x && x.text) || "").join("\n") : "";
const toolLabel = i => trunc(String((i && (i.command || i.file_path || i.pattern || i.path || i.url || i.description || i.query)) || "").split("\n")[0], 80);
function addTool(b) {
  const inp = b.input || {}, sum = el("summary", null, `${b.name} · ${toolLabel(inp)}`), res = el("span", null, "(waiting for result)");
  const d = el("details", { class: "msg tool", "data-testid": "chat-msg", "data-role": "tool" }, sum, el("pre", null, trunc(JSON.stringify(inp, null, 2), 4000), "\n—\n", res));
  tools.set(b.id, { d, sum, res, name: b.name, label: toolLabel(inp) }); add(d);
}
function onResult(b) {
  const txt = blockText(b.content), t = tools.get(b.tool_use_id);
  if (t) keep(() => { t.res.textContent = trunc(txt, 4000) || "(tomt)"; if (b.is_error) { t.d.classList.add("err"); t.sum.textContent = `✕ ${t.name} · ${t.label} — ${trunc(txt.split("\n")[0], 80)}`; } });
  else if (agents.has(b.tool_use_id) && !handed.has(b.tool_use_id) && !txt.startsWith("Async agent launched")) { handed.add(b.tool_use_id); add(line("system", `← handback ${agents.get(b.tool_use_id)}`)); }
}
function finish(code) {
  if (ended) return;
  ended = true; add(line("system", "sessionen avslutades" + (code ? ` (kod ${code})` : ""))); $("#sr-chat").textContent = "Sessionen avslutades"; chrome();
}
function onEv(e) {
  const lead = !e.parent_tool_use_id, c = e.message && e.message.content;
  if (e.type === "user" && e.am_local && typeof c === "string") return add(line("user", c));
  if (e.type === "assistant" && lead && Array.isArray(c)) for (const b of c) {
    if (b.type === "text" && b.text) { lastText = b.text; add(line("assistant", b.text)); }
    else if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
      const i = b.input || {}, t = short(i.subagent_type || "agent"); agents.set(b.id, t);
      add(line("system", `→ dispatch ${t}: ${trunc(i.description || "", 120)}`));
    } else if (b.type === "tool_use") addTool(b);
  } else if (e.type === "user" && lead && Array.isArray(c)) c.forEach(b => b.type === "tool_result" && onResult(b));
  else if (e.type === "system" && e.subtype === "task_notification") {
    handed.add(e.tool_use_id); add(line("system", `← handback ${agents.get(e.tool_use_id) || ""}${e.summary ? ": " + trunc(e.summary, 200) : ""}`));
  } else if (e.type === "result") {
    const ms = e.duration_ms ?? e.duration_api_ms, bad = e.is_error || (e.subtype && e.subtype !== "success");
    add(line("result", `${bad ? `✕ interrupted/error${e.subtype ? " (" + e.subtype + ")" : ""}` : "✓ done"}${e.total_cost_usd != null ? " · $" + e.total_cost_usd.toFixed(2) : ""}${ms != null ? " · " + (ms / 1000).toFixed(1) + " s" : ""}`, bad ? "err" : ""));
    $("#sr-chat").textContent = lastText ? "Svar klart: " + trunc(lastText, 200) : "Svar klart";
  } else if (e.type === "am_exit") {
    finish(e.code);
  }
}
function connect(id) {
  const src = es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
  src.addEventListener("ev", m => { if (es === src) try { onEv(JSON.parse(m.data)); } catch {} });
  src.addEventListener("end", () => { if (es !== src) return; src.close(); es = null; finish(); });
  src.addEventListener("graph", m => { if (es === src) try { showGraph(JSON.parse(m.data)); } catch {} });
}

/* ---------- render ---------- */
function msg(text, err) { const m = $("#msg"); m.textContent = text || ""; m.hidden = !text; m.className = "empty" + (err ? " err" : ""); }
function showGraph(g) {
  if (!g || !g.nodes) return;
  msg(""); curGraph = g;
  const ag = g.nodes.filter(n => n.kind !== "lead"), c = k => ag.filter(n => n.status === k).length;
  $("#cy").setAttribute("aria-label", `Agent graph: ${ag.length} agents, ${c("running")} running, ${c("waiting")} waiting for permission. Switch to List for keyboard use.`);
  sync(g); renderList(g); if (kind === "driven") renderPerms(g.permissions || []);
}
function render(st) {
  renderSidebar();
  if (kind === "driven") { if (!curGraph) msg("laddar graf…"); return; }
  if (kind === "new") return;
  if (!st) return;
  const ss = st.sessions || [];
  if (kind === "none" && ss[0]) { kind = "observed"; sel = ss.some(x => x.id === sel) ? sel : ss[0].id; chrome(); }
  else if (kind === "observed" && !ss.find(s => s.id === sel) && ss[0]) sel = ss[0].id;
  const s = kind === "observed" && ss.find(x => x.id === sel);
  $("#ttl").textContent = s ? (s.title || s.id) : ""; $("#cwd").textContent = s ? s.cwd : "";
  if (!s) { msg("Select a session on the left or create a new one."); curGraph = null; return; }
  const g = s.graph;
  if (!g || !g.nodes) { msg("ingen graf"); curGraph = null; if (cy) cy.elements().remove(); $("#nodelist").replaceChildren(); $("#hint").hidden = true; return; }
  showGraph(g);
}

/* ---------- polling ---------- */
async function loadDriven() {
  try {
    const r = await fetch("/api/sessions", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) { drivenList = j; if (kind === "driven") chrome(); else renderSidebar(); } }
  } catch {}
}
let delay = 1500, stopped = false;
async function tick() {
  const live = $("#live");
  try {
    const r = await fetch("/api/state", { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401 || r.status === 403) {
      stopped = true; live.className = "live off"; live.lastChild.textContent = "ej inloggad";
      msg("Ogiltig token. Starta om appen via startaren.", true); return;
    }
    if (!r.ok) throw 0;
    last = await r.json(); delay = 1500;
    live.className = "live"; live.lastChild.textContent = "live";
    if (!getSelection().toString()) render(last);
  } catch { live.className = "live off"; live.lastChild.textContent = "disconnected — retrying…"; delay = delay < 2000 ? 2000 : 5000; }
  $("#clock").textContent = new Date().toLocaleTimeString("en-GB");
  if (!stopped) setTimeout(tick, delay);
}
setView(view); chatReset(); kind = "none"; chrome(); $("#live").className = "live wait"; loadDriven(); setInterval(() => { if (!stopped) loadDriven(); }, 3000); tick();


/* ---------- permissions / stop / mode ---------- */
const cards = new Map();
function permReset() { cards.clear(); $("#perms").replaceChildren(); $("#perms").classList.remove("on"); $("#sr-perm").textContent = ""; }
// the COMPLETE approval-relevant input as plain text (what "Allow" actually sends)
function permText(p) {
  const i = p.input || {}, t = p.tool_name, s = v => String(v ?? "");
  const json = v => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
  let head = null, used = [];
  if (t === "Bash" && i.command) { head = s(i.command); used = ["command"]; }
  else if (t === "Write" && i.file_path) { head = `${i.file_path}\n\n${s(i.content)}`; used = ["file_path", "content"]; }
  else if ((t === "Edit" || t === "MultiEdit") && i.file_path) {
    const es = Array.isArray(i.edits) ? i.edits : [i];
    head = `${i.file_path}\n` + es.map(e => `\n--- old_string ---\n${s(e.old_string)}\n--- new_string ---\n${s(e.new_string)}`).join("\n");
    used = Array.isArray(i.edits) ? ["file_path", "edits"] : ["file_path", "old_string", "new_string"];
    if (Array.isArray(i.edits) && i.edits.some(e => Object.keys(e).some(k => k !== "old_string" && k !== "new_string"))) used = ["file_path"];
  }
  else if (t === "NotebookEdit" && (i.notebook_path || i.new_source != null)) { head = `${s(i.notebook_path)}\n\n${s(i.new_source)}`; used = ["notebook_path", "new_source"]; }
  // every field "Allow" sends must be on screen: append whatever the friendly view did not render
  const rest = Object.fromEntries(Object.entries(i).filter(([k]) => !used.includes(k)));
  const text = head === null ? json(i) : Object.keys(rest).length ? `${head}\n\n--- other fields ---\n${json(rest)}` : head;
  // show invisible/bidi control chars (Trojan Source) as escapes; keep \n and \t
  return text.replace(/[\p{Cf}\p{Cc}]/gu, c => c === "\n" || c === "\t" ? c : `\\u{${c.codePointAt(0).toString(16)}}`);
}
const PERM_CHARS = 600, PERM_LINES = 12;
function focusNode(id) {
  const n = cy && !$("#cy").hidden ? cy.getElementById(id) : null;
  if (n && !n.empty()) { cy.$(":selected").unselect(); n.select(); cy.animate({ center: { eles: n } }, { duration: rm.matches ? 0 : 200 }); }
  else if (curGraph) openLog(id);
}
function makeCard(p) {
  const nd = ((curGraph && curGraph.nodes) || []).find(n => n.id === p.node);
  const who = !nd || nd.kind === "lead" ? "lead" : short(nd.agent_type || nd.label);
  const hid = "ph-" + p.request_id, err = el("p", { class: "perm-err", role: "alert" });
  const allow = el("button", { class: "btn allow", "data-testid": "perm-allow", type: "button" }, "Allow");
  const deny = el("button", { class: "btn deny", "data-testid": "perm-deny", type: "button" }, "Deny");
  const full = permText(p), lines = full.split("\n"), long = full.length > PERM_CHARS || lines.length > PERM_LINES;
  const shown = lines.slice(0, PERM_LINES).join("\n").slice(0, PERM_CHARS);
  const pre = el("pre", { tabindex: "0", "aria-label": "Input being approved" }, el("code", null, long ? shown : full));
  let more = null;
  if (long) {
    allow.disabled = true; allow.title = "Show the full input before allowing";
    more = el("button", { class: "btn more", type: "button", "data-testid": "perm-expand", "aria-expanded": "false",
      onclick: () => { pre.firstChild.textContent = full; more.remove(); allow.disabled = false; allow.removeAttribute("title"); pre.focus(); } }, `Visa allt (+${full.length - shown.length} tecken)`);
  }
  const card = el("div", { class: "perm", role: "group", "aria-labelledby": hid, "data-testid": "perm-card", "data-request-id": p.request_id },
    el("h3", { id: hid }, `Permission required · ${p.tool_name}`),
    el("div", null, "from ", el("button", { class: "who", type: "button", "aria-label": `Show agent ${who} in graph`, onclick: () => focusNode(p.node) }, who)),
    p.description ? el("div", { class: "desc" }, p.description) : null,
    pre, p.tool_name === "Bash" && p.input && p.input.description && p.input.description !== p.description ? el("div", { class: "desc" }, String(p.input.description)) : null, more,
    p.blocked_path ? el("div", { class: "desc" }, "Blocked path: ", el("code", null, p.blocked_path)) : null,
    el("div", { class: "acts" }, allow, deny), err);
  const answer = async behavior => {
    allow.disabled = deny.disabled = true; err.textContent = "";
    try {
      await api(`/api/sessions/${encodeURIComponent(sel)}/permission`, { request_id: p.request_id, behavior });
      add(line("system", `${behavior === "allow" ? "✓ Allowed" : "✕ Denied"}: ${p.tool_name} (${who})`));
      const nx = [...cards.values()].map(c => c.card).find(c => c !== card && c.isConnected);
      (nx && nx.querySelector("button:not(:disabled)") || $("#prompt")).focus();
    }
    catch (e) {
      if (e.status === 404) { err.textContent = "redan besvarad"; setTimeout(() => { card.remove(); cards.delete(p.request_id); fixPerms(); }, 1200); return; }
      err.textContent = "Could not send the response — try again"; deny.disabled = false; allow.disabled = !!(more && more.isConnected);
    }
  };
  allow.onclick = () => answer("allow"); deny.onclick = () => answer("deny");
  return { card, who };
}
const fixPerms = () => $("#perms").classList.toggle("on", cards.size > 0);
function renderPerms(list) {
  const root = $("#perms"), ids = new Set(list.map(p => p.request_id));
  const prev = cards.size; let fresh = false;
  for (const [id, c] of cards) if (!ids.has(id)) { c.card.remove(); cards.delete(id); }
  for (const p of list) if (!cards.has(p.request_id)) {
    const c = makeCard(p); cards.set(p.request_id, c); root.append(c.card);
    $("#sr-perm").textContent = `Permission required: ${p.tool_name} for ${c.who}`; fresh = true;
  }
  if (fresh || cards.size !== prev) loadDriven(); // refresh sidebar status/pending count
  fixPerms();
}
$("#stop").onclick = async () => {
  const b = $("#stop"); b.disabled = true; perr("");
  try { await api(`/api/sessions/${encodeURIComponent(sel)}/interrupt`, {}); } catch (e) { perr("Could not interrupt: " + e.message); }
  b.disabled = false;
};
let modeBusy = false;
$("#mode").addEventListener("change", async e => {
  const s = drivenEntry(), sel_ = e.target, prev = s && s.mode || "default"; modeBusy = true; perr("");
  try { await api(`/api/sessions/${encodeURIComponent(sel)}/mode`, { mode: sel_.value }); if (s) s.mode = sel_.value; }
  catch (er) { sel_.value = prev; perr("Could not change mode: " + er.message); }
  modeBusy = false;
});
