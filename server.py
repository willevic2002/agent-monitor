#!/usr/bin/env python3
"""Live monitor for Claude Code / claude-dev-team agents. Stdlib only.

Reads (read-only): ~/.claude/projects/**/*.jsonl transcripts, their subagents/, <cwd>/.claude/runtime/phase.json
and ~/.claude/claude-dev-team.db. Serves index.html + /api/state on http://127.0.0.1:7777
"""
import json, os, glob, time, sqlite3, sys, re, hmac, secrets, threading
import driver, voice
from urllib.parse import urlparse, parse_qs, unquote
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from graph import tail_lines, tool_label, node_log, reduce, events_from_transcript, AGENT_ID, TAIL

HOME = os.path.expanduser("~")
PROJ = os.environ.get("AM_PROJECTS_DIR") or os.path.join(HOME, ".claude", "projects")
DB = os.path.join(HOME, ".claude", "claude-dev-team.db")
ACTIVE_S = 30 * 60      # a session counts as live if its transcript changed within this window
RUNNING_S = 120         # a subagent with no write for this long and no pending tool is considered done

STAGES = ["triage", "contract", "dispatch", "gates", "review", "ship"]
REVIEWERS = ("review", "security", "adversarial", "verif")


def tilde(p):
    return "~" + p[len(HOME):] if p == HOME or p.startswith(HOME + "/") else p


def prompt_text(d):
    if d.get("type") != "user": return ""
    c = (d.get("message") or {}).get("content")
    if isinstance(c, list): c = " ".join(x.get("text", "") for x in c if x.get("type") == "text" and not x.get("text", "").lstrip().startswith("<"))
    return (c or "").strip() if isinstance(c, str) else ""


def stage_of(name, inp):
    """Map one tool call to a CDT orchestration stage (heuristic; None = no signal)."""
    inp = inp or {}
    if name == "Skill":
        s = inp.get("skill", "")
        if "ship" in s or "finishing" in s: return "ship"
        if "review" in s: return "review"
        if "triage" in s or "orchestration" in s or "brainstorm" in s: return "triage"
        if "plan" in s: return "contract"
    if name in ("Agent", "Task"):
        t = inp.get("subagent_type", "")
        if any(r in t for r in REVIEWERS): return "review"
        if "architect" in t or "product" in t or "Plan" in t: return "contract"
        return "dispatch"
    if name == "Bash":
        c = inp.get("command", "")
        if any(k in c for k in ("cdt-triage", "cdt-route", "cdt-prompt")): return "triage"
        if "cdt-contract" in c: return "contract"
        if any(k in c for k in ("cdt-verify", "pytest", "npm test", "vitest", "cargo test", "make test", "go test", "xcodebuild test")): return "gates"
        if any(k in c for k in ("cdt-phase done", "gh pr create", "cdt ship")): return "ship"
    return None


def parse(lines):
    """Summarise one transcript: model, tool calls (pending/done), last text, timestamps."""
    model, calls, results, last_text, last_ts, first_ts, finished = None, [], set(), "", None, None, False
    for d in lines:
        ts = d.get("timestamp")
        if ts: last_ts = ts; first_ts = first_ts or ts
        m = d.get("message") or {}
        c = m.get("content")
        if d.get("type") == "assistant":
            model = m.get("model") or model
            finished = m.get("stop_reason") == "end_turn"
            for x in c if isinstance(c, list) else []:
                if x.get("type") == "tool_use":
                    calls.append({"id": x.get("id"), "name": x.get("name"), "input": x.get("input"), "ts": ts})
                elif x.get("type") == "text" and x.get("text", "").strip():
                    last_text = x["text"].strip()
        elif d.get("type") == "user" and isinstance(c, list):
            finished = False
            for x in c:
                if x.get("type") == "tool_result": results.add(x.get("tool_use_id"))
    for k in calls: k["pending"] = k["id"] not in results
    return {"model": model, "calls": calls, "last_text": last_text[:240], "last_ts": last_ts, "first_ts": first_ts, "finished": finished}


def subagents(sess_dir, now):
    out = []
    for meta in glob.glob(os.path.join(sess_dir, "subagents", "agent-*.meta.json")):
        jl = meta.replace(".meta.json", ".jsonl")
        if not os.path.exists(jl): continue
        try: info = json.load(open(meta))
        except Exception: info = {}
        p = parse(tail_lines(jl))
        age = now - os.path.getmtime(jl)
        pending = any(c["pending"] for c in p["calls"])
        status = "done" if p["finished"] or age > RUNNING_S and not pending or age > ACTIVE_S else "running"
        last = p["calls"][-1] if p["calls"] else None
        out.append({
            "id": os.path.basename(jl)[6:-6], "type": info.get("agentType", "agent"),
            "description": info.get("description", ""), "toolUseId": info.get("toolUseId"),
            "model": p["model"], "status": status, "age": round(age), "tools": len(p["calls"]),
            "current": f'{last["name"]} · {tool_label(last["name"], last["input"])}' if last else "",
            "last_text": p["last_text"], "started": p["first_ts"],
        })
    return sorted(out, key=lambda a: a["started"] or "")


def gate_events(sid):
    try:
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=1)
        rows = con.execute("select ts,type,message from events where session_id=? and type like '%gate%' order by ts desc limit 5", (sid,)).fetchall()
        con.close()
        return [{"ts": r[0], "type": r[1], "msg": r[2]} for r in rows]
    except Exception:
        return []


def session_state(path, now):
    sid = os.path.basename(path)[:-6]
    lines = tail_lines(path)
    p = parse(lines)
    cwd = next((d["cwd"] for d in lines if d.get("cwd")), "")
    title = next((d.get("aiTitle") or d.get("customTitle") or d.get("summary") for d in reversed(lines) if d.get("type") in ("summary", "custom-title", "ai-title")), None)
    first_prompt = next((t for t in map(prompt_text, lines) if t and not t.startswith("<")), "")
    subs = subagents(path[:-6], now)

    stage = None
    for c in p["calls"]:
        stage = stage_of(c["name"], c["input"]) or stage
    running = [a for a in subs if a["status"] == "running"]
    if running:
        stage = "review" if any(any(r in a["type"] for r in REVIEWERS) for a in running) else "dispatch"
    gates = gate_events(sid)

    phase = None
    try: phase = json.load(open(os.path.join(cwd, ".claude", "runtime", "phase.json")))
    except Exception: pass

    feed = [{"ts": c["ts"], "who": "lead", "tool": c["name"], "label": tool_label(c["name"], c["input"]), "pending": c["pending"]} for c in p["calls"][-25:]]
    last = p["calls"][-1] if p["calls"] else None
    age = now - os.path.getmtime(path)
    return {
        "id": sid, "cwd": tilde(cwd), "title": title or (first_prompt or "")[:90],
        "model": p["model"], "age": round(age), "busy": age < 20 or bool(last and last["pending"]),
        "current": f'{last["name"]} · {tool_label(last["name"], last["input"])}' if last else "",
        "last_text": p["last_text"], "stage": stage or "triage", "stages": STAGES,
        "phase": phase, "gates": gates, "agents": subs, "feed": feed, "tools": len(p["calls"]),
    }


def graph_of(path, phase):
    """Any failure just omits the graph."""
    try:
        return reduce(events_from_transcript(path), phase)
    except Exception as e:
        print("graph failed", type(e).__name__, file=sys.stderr)
        return None


def state():
    now = time.time()
    files = [f for f in glob.glob(os.path.join(PROJ, "*", "*.jsonl")) if now - os.path.getmtime(f) < ACTIVE_S]
    mine = {x.sid for x in driver.live() if x.sid}   # driven sessions are listed separately
    files = [f for f in files if os.path.basename(f)[:-6] not in mine]
    files.sort(key=os.path.getmtime, reverse=True)
    sessions = []
    for f in files[:12]:
        try:
            s = session_state(f, now)
            g = graph_of(f, s.get("phase"))
            if g is not None:
                if not s["busy"]:   # transcripts carry no "result" event; v1's mtime/pending heuristic decides idle
                    g["session"]["status"] = "idle"
                    for n in g["nodes"]:
                        if n["id"] == "lead" and n["status"] == "running": n["status"] = "done"
                s["graph"] = g
            sessions.append(s)
        except Exception as e: print("skip", f, type(e).__name__, file=sys.stderr)
    return {"now": now, "sessions": sessions}


HERE = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 1024 * 1024  # 1 MiB
ONCE_TTL, ONCE_MAX = 30, 16
SID_RE = re.compile(r"^[0-9a-f-]{36}$")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'")
MAX_PROMPT = 100_000


def scrub(ev):
    """The initialize response carries the account email; the browser never needs it."""
    r = ev.get("response") if ev.get("type") == "control_response" else None
    if isinstance(r, dict) and isinstance(r.get("response"), dict) and "account" in r["response"]:
        return {**ev, "response": {**r, "response": {k: v for k, v in r["response"].items() if k != "account"}}}
    return ev


MIME = {".js": "application/javascript; charset=utf-8"}


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler, token):
        super().__init__(addr, handler)
        self.token, self.port = token, self.server_address[1]
        self.nonces, self.lock, self.once_ttl = {}, threading.Lock(), ONCE_TTL

    def new_nonce(self):
        n, now = secrets.token_urlsafe(24), time.monotonic()
        with self.lock:
            self.nonces = {k: v for k, v in self.nonces.items() if v > now}
            while len(self.nonces) >= ONCE_MAX: self.nonces.pop(next(iter(self.nonces)))
            self.nonces[n] = now + self.once_ttl
        return n

    def burn_nonce(self, n):
        with self.lock:
            exp = self.nonces.pop(n, 0)
        return exp > time.monotonic()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body=b"", ctype="application/json", extra=()):
        self.send_response(code)
        for k, v in (("Content-Type", ctype), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"),
                     ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
                     ("Content-Security-Policy", CSP), ("X-Frame-Options", "DENY"), *extra):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj, extra=()):
        self._send(code, json.dumps(obj).encode(), extra=extra)

    def _authed(self):
        tok = self.server.token
        cookie = next((p.strip()[3:] for p in self.headers.get("Cookie", "").split(";") if p.strip().startswith("am=")), "")
        return any(hmac.compare_digest(c.encode(), tok.encode()) for c in (cookie, self.headers.get("X-AM-Token", "")))

    def _guard(self, api):
        """Host on every request; Origin (when present) on POST and /api. Returns True if request may proceed."""
        p = self.server.port
        if self.headers.get("Host") not in (f"127.0.0.1:{p}", f"localhost:{p}"):
            self._json(403, {"error": "bad host"}); return False
        o = self.headers.get("Origin")
        if o is not None and (api or self.command == "POST") and o not in (f"http://127.0.0.1:{p}", f"http://localhost:{p}"):
            self._json(403, {"error": "bad origin"}); return False
        if api and self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            self._json(403, {"error": "cross-site"}); return False
        if api and not self._authed():
            self._json(401, {"error": "unauthorized"}); return False
        return True

    def do_OPTIONS(self):
        self._json(405, {"error": "method not allowed"})

    def do_GET(self):
        u = urlparse(self.path)
        api = u.path.startswith("/api/")
        if not self._guard(api): return
        q = parse_qs(u.query)
        if u.path == "/login":
            if not self.server.burn_nonce((q.get("once") or [""])[0]):
                return self._json(403, {"error": "invalid or expired"})
            to = "/brain" if (q.get("to") or [""])[0] == "brain" else "/"   # fixed whitelist: never an open redirect
            return self._send(303, extra=(("Location", to), ("Set-Cookie", f"am={self.server.token}; HttpOnly; SameSite=Strict; Path=/")))
        if u.path in ("/", "/index.html"):
            return self._send(200, open(os.path.join(HERE, "index.html"), "rb").read(), "text/html; charset=utf-8")
        if u.path == "/brain":
            return self._send(200, open(os.path.join(HERE, "brain.html"), "rb").read(), "text/html; charset=utf-8")
        if u.path in ("/app.js", "/brain.js"):
            try: body = open(os.path.join(HERE, u.path[1:]), "rb").read()
            except OSError: return self._json(404, {"error": "not found"})
            return self._send(200, body, "text/javascript; charset=utf-8")
        if u.path.startswith("/vendor/"):
            name = unquote(u.path[8:])
            vd = os.path.join(HERE, "vendor")
            if name not in os.listdir(vd):   # whitelist: plain files directly in vendor/
                return self._json(404, {"error": "not found"})
            return self._send(200, open(os.path.join(vd, name), "rb").read(), MIME.get(os.path.splitext(name)[1], "text/plain; charset=utf-8"))
        if u.path == "/api/state":
            return self._json(200, state())
        if u.path == "/api/sessions": return self._sessions()
        if u.path == "/api/voice": return self._json(200, voice.status())
        m = re.fullmatch(r"/api/sessions/([0-9a-f]{32})/events", u.path)
        if m:
            s = driver.get(m.group(1))
            if s is None: return self._json(404, {"error": "no such session"})
            try:
                lid = self.headers.get("Last-Event-ID")
                since = int(lid) + 1 if lid else int((q.get("since") or ["0"])[0])
            except ValueError: return self._json(400, {"error": "bad since"})
            return self._sse(s, max(since, 0))
        if u.path == "/api/log":
            sid, node = (q.get("session") or [""])[0], (q.get("node") or [""])[0]
            if not SID_RE.match(sid) or not (node == "lead" or AGENT_ID.fullmatch(node)):
                return self._json(400, {"error": "bad session or node"})
            hit = glob.glob(os.path.join(glob.escape(PROJ), "*", sid + ".jsonl"))
            if not hit: return self._json(404, {"error": "no such session"})
            try:
                return self._json(200, {"entries": node_log(hit[0], node)})
            except ValueError:
                return self._json(400, {"error": "bad node"})
            except Exception:
                return self._json(501, {"error": "log unavailable"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if not self._guard(u.path.startswith("/api/")): return
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self._json(415, {"error": "json only"})
        try: n = int(self.headers.get("Content-Length", "0"))
        except ValueError: n = -1
        if n < 0: return self._json(400, {"error": "bad length"})
        if n > MAX_BODY: return self._json(413, {"error": "too large"})
        raw = self.rfile.read(n)
        if u.path == "/api/once":
            if not hmac.compare_digest(self.headers.get("X-AM-Token", "").encode(), self.server.token.encode()):
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {"once": self.server.new_nonce()})
        try: body = json.loads(raw or b"{}")
        except ValueError: body = None
        if not isinstance(body, dict): return self._json(400, {"error": "bad json"})
        if u.path == "/api/sessions": return self._create(body)
        if u.path == "/api/tts":
            text = body.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= 5000: return self._json(400, {"error": "bad text"})
            try: return self._send(200, voice.tts(text), "audio/wav")
            except Exception as e: return self._json(503, {"error": f"voice unavailable: {e}"[:300]})
        if u.path in ("/api/stt/start", "/api/stt/stop"):
            if not voice.status()["stt"]: return self._json(503, {"error": "speech-to-text not installed (packaging/install-voice.sh)"})
            try:
                if u.path.endswith("start"): voice.rec_start(); return self._json(202, {})
                return self._json(200, {"text": voice.rec_stop()})
            except Exception as e: return self._json(500, {"error": str(e)[:300]})
        m = re.fullmatch(r"/api/sessions/([0-9a-f]{32})/prompt", u.path)
        if m:
            s, text = driver.get(m.group(1)), body.get("text")
            if s is None: return self._json(404, {"error": "no such session"})
            if not isinstance(text, str) or not 1 <= len(text) <= MAX_PROMPT: return self._json(400, {"error": "bad text"})
            try: s.prompt(text)
            except RuntimeError: return self._json(409, {"error": "session has exited"})
            return self._json(202, {})
        m = re.fullmatch(r"/api/sessions/([0-9a-f]{32})/(permission|interrupt|mode)", u.path)
        if m:
            s, act = driver.get(m.group(1)), m.group(2)
            if s is None: return self._json(404, {"error": "no such session"})
            try:
                if act == "interrupt": s.interrupt(); return self._json(202, {})
                if act == "mode":
                    if body.get("mode") not in driver.MODES: return self._json(400, {"error": "bad mode"})   # exact match, no coercion
                    s.set_mode(body["mode"]); return self._json(200, {"ok": True})
                rid, beh = body.get("request_id"), body.get("behavior")   # tool input is never taken from the client
                if not isinstance(rid, str) or beh not in ("allow", "deny"): return self._json(400, {"error": "bad request"})
                s.answer(rid, beh == "allow"); return self._json(200, {"ok": True})
            except KeyError: return self._json(404, {"error": "no such pending request"})
            except RuntimeError: return self._json(409, {"error": "session has exited"})
        self._json(404, {"error": "not found"})

    def _create(self, b):
        prompt, resume, fork = b.get("prompt"), b.get("resume"), b.get("fork", False)
        if not isinstance(prompt, str) or not 1 <= len(prompt) <= MAX_PROMPT or not isinstance(fork, bool):
            return self._json(400, {"error": "bad prompt or fork"})
        if resume is not None: fork = True   # a resumed session may be live in a terminal: never two writers
        try:
            s = driver.Session(b.get("cwd"), b.get("mode", "default"), resume, fork)
        except ValueError as e: return self._json(400, {"error": str(e)})
        except driver.NoClaude: return self._json(503, {"error": "claude not found"})
        except driver.TooMany: return self._json(429, {"error": "too many sessions"})
        except OSError: return self._json(500, {"error": "spawn failed"})
        try: s.prompt(prompt)
        except RuntimeError: return self._json(409, {"error": "session has exited"})
        self._json(201, {"id": s.id})

    def _sessions(self):
        self._json(200, [{"id": s.id, "sid": s.sid, "cwd": tilde(s.cwd), "mode": s.mode, "status": s.status, "pending": len(s.pending), "title": s.title}
                         for s in list(driver.SESSIONS.values())])

    def _sse(self, s, since):
        self.send_response(200)
        for k, v in (("Content-Type", "text/event-stream"), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                     ("Referrer-Policy", "no-referrer"), ("Content-Security-Policy", CSP), ("X-Frame-Options", "DENY")):
            self.send_header(k, v)
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                start, evs = s.batch(since, 15)
                if not evs:
                    if not s.alive():
                        self.wfile.write(b"event: end\ndata: {}\n\n"); self.wfile.flush(); return
                    self.wfile.write(b": ping\n\n"); self.wfile.flush(); continue
                out = "".join(f"id: {start + i}\nevent: ev\ndata: {json.dumps(scrub(e))}\n\n" for i, e in enumerate(evs))
                try: phase = json.load(open(os.path.join(s.cwd, ".claude", "runtime", "phase.json")))
                except Exception: phase = None
                try: g = json.dumps(reduce(s.snapshot(), phase))
                except Exception as e:
                    print("graph failed", type(e).__name__, file=sys.stderr); g = None
                if g: out += f"event: graph\ndata: {g}\n\n"
                if any(e.get("type") == "am_exit" for e in evs): out += "event: end\ndata: {}\n\n"
                self.wfile.write(out.encode()); self.wfile.flush()
                if out.endswith("event: end\ndata: {}\n\n"): return
                since = start + len(evs)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def make_server(port, config_dir):
    token = secrets.token_urlsafe(32)
    os.makedirs(config_dir, mode=0o700, exist_ok=True)
    if os.lstat(config_dir).st_uid != os.getuid():
        raise SystemExit(f"refusing to start: config dir {config_dir} is not owned by the current user")
    os.chmod(config_dir, 0o700)
    fd = os.open(os.path.join(config_dir, "token"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600); f.write(token)
    return Server(("127.0.0.1", port), H, token), token


if __name__ == "__main__":
    if "--once" in sys.argv:
        print(json.dumps(state(), indent=1)[:4000]); sys.exit()
    port = int(os.environ.get("PORT", 7777))
    cfg = os.environ.get("AM_CONFIG_DIR") or os.path.join(HOME, ".config", "agent-monitor")
    import signal
    for sg in (signal.SIGTERM, signal.SIGINT): signal.signal(sg, lambda *_: sys.exit(0))   # run atexit: close children
    httpd, _ = make_server(port, cfg)
    print(f"agent monitor → http://127.0.0.1:{httpd.port}")
    httpd.serve_forever()   # localhost only: transcripts are private
