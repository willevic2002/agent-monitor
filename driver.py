"""Drives one `claude -p` stream-json child (docs/architecture-v2.md §1,§3,§6). Stdlib only.

Security: argv is built from fixed flags plus validated values; no shell. Never --bare, never bypassPermissions.
"""
import atexit, collections, json, os, re, signal, shutil, subprocess, threading, uuid

MODES = ("default", "acceptEdits", "plan", "auto")   # auto = claude decides itself, blocks risky actions; never bypassPermissions
# Only sessions started from Agent Monitor get this; the plain claude CLI is unaffected.
PERSONA = ("You are JARVIS, the user's personal AI assistant. Speak like a calm, composed British butler-AI: "
           "polite, precise, quietly confident, with dry understated wit. Address the user as \"sir\". "
           "Keep replies short and spoken-friendly (they may be read aloud). Stay fully competent: the persona "
           "is tone only and never replaces accuracy or the usual rules. "
           "Before your first tool call, write 1-2 short sentences: what you understood and what you're about to do. Then start working.")
CLAUDE = shutil.which(os.environ.get("AM_CLAUDE", "claude"))   # resolved once; None = not installed
MAX_LIVE, MAX_EVENTS, MAX_ENDED = 8, 20_000, 8
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SESSIONS, LOCK = {}, threading.Lock()


class TooMany(Exception): pass
class NoClaude(Exception): pass


def live():
    return [s for s in list(SESSIONS.values()) if s.alive()]


class Session:
    def __init__(self, cwd, mode="default", resume=None, fork=False, model=None):
        if mode not in MODES: raise ValueError("bad mode")
        if resume is not None and not (isinstance(resume, str) and UUID_RE.match(resume)): raise ValueError("bad resume id")
        if not isinstance(cwd, str) or not cwd: raise ValueError("bad cwd")
        cwd = os.path.realpath(os.path.expanduser(cwd))
        if not os.path.isdir(cwd): raise ValueError("cwd is not a directory")
        if model is not None and not re.fullmatch(r"[A-Za-z0-9._\[\]-]{1,64}", model): raise ValueError("bad model")
        if CLAUDE is None: raise NoClaude("claude not found")
        self.id, self.sid, self.cwd, self.mode, self.title = uuid.uuid4().hex, None, cwd, mode, ""
        self.events, self.base, self.pending, self.rc = [], 0, {}, None
        self.cond, self.wlock = threading.Condition(), threading.Lock()
        self.stderr = collections.deque(maxlen=50)
        self.argv = [CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                     "--permission-prompt-tool", "stdio", "--permission-mode", mode,
                     "--append-system-prompt", PERSONA]
        if resume: self.argv += ["--resume", resume]
        if fork: self.argv.append("--fork-session")
        if model: self.argv += ["--model", model]
        env = {k: v for k, v in os.environ.items() if not k.startswith("AM_") or k.startswith("AM_FAKE_")}
        with LOCK:
            if len(live()) >= MAX_LIVE: raise TooMany("too many live sessions")
            for k in [k for k, v in SESSIONS.items() if not v.alive()][:-MAX_ENDED or None]: del SESSIONS[k]   # keep newest ended
            self.proc = subprocess.Popen(self.argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, text=True, bufsize=1, start_new_session=True)
            SESSIONS[self.id] = self
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: [self.stderr.append(l.rstrip()) for l in self.proc.stderr], daemon=True).start()
        self._send({"type": "control_request", "request_id": "req_1_init", "request": {"subtype": "initialize", "hooks": None}})

    def alive(self): return self.rc is None and self.proc.poll() is None

    @property
    def status(self):
        if not self.alive(): return "ended"
        if self.pending: return "waiting"
        last = next((e for e in reversed(self.events) if e.get("type") in ("result", "user", "assistant")), None)
        return "idle" if last and last["type"] == "result" else "running"

    def _append(self, ev):
        with self.cond:
            self.events.append(ev)
            drop = len(self.events) - MAX_EVENTS
            if drop > 0:
                del self.events[:drop]; self.base += drop
            self.cond.notify_all()

    def _read(self):
        for line in self.proc.stdout:
            try: ev = json.loads(line)
            except ValueError: continue
            if not isinstance(ev, dict): continue
            t, r = ev.get("type"), ev.get("request") or {}
            if t == "system" and ev.get("subtype") == "init": self.sid = ev.get("session_id")
            if t == "control_request" and r.get("subtype") == "can_use_tool": self.pending[ev.get("request_id")] = ev
            if t == "control_cancel_request": self.pending.pop(ev.get("request_id"), None)
            self._append(ev)
        self.rc = self.proc.wait()
        self.pending.clear()
        self._append({"type": "am_exit", "code": self.rc})

    def _send(self, obj):
        with self.wlock:
            try:
                self.proc.stdin.write(json.dumps(obj) + "\n"); self.proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                raise RuntimeError("session has exited")

    def prompt(self, text):
        self._append({"type": "user", "am_local": True, "message": {"role": "user", "content": text}, "parent_tool_use_id": None})
        self._send({"type": "user", "message": {"role": "user", "content": text}, "parent_tool_use_id": None, "session_id": "default"})
        self.title = self.title or text[:90]

    def answer(self, request_id, allow, message="Denied in Agent Monitor"):
        req = self.pending.pop(request_id, None)
        if req is None: raise KeyError(request_id)
        resp = {"behavior": "allow", "updatedInput": req["request"].get("input")} if allow else {"behavior": "deny", "message": message}
        self._send({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": resp}})
        self._append({"type": "am_answered", "request_id": request_id, "behavior": "allow" if allow else "deny"})

    def interrupt(self):
        for rid in list(self.pending):   # never leave the CLI blocked on a permission prompt
            try: self.answer(rid, False, "Avbruten i Agent Monitor")
            except KeyError: pass
        self._send({"type": "control_request", "request_id": "int_" + uuid.uuid4().hex[:8], "request": {"subtype": "interrupt"}})

    def set_mode(self, mode):
        if mode not in MODES: raise ValueError("bad mode")
        self._send({"type": "control_request", "request_id": "mode_" + uuid.uuid4().hex[:8],
                    "request": {"subtype": "set_permission_mode", "mode": mode}})
        self.mode = mode

    def batch(self, since, timeout=15):
        """(first_index, events) with index >= since; waits up to timeout if none. Dropped indices start at the oldest kept."""
        with self.cond:
            self.cond.wait_for(lambda: self.base + len(self.events) > since, timeout)
            start = max(since, self.base)
            return start, self.events[start - self.base:]

    def wait(self, since, timeout=15): return self.batch(since, timeout)[1]

    def snapshot(self):
        with self.cond: return list(self.events)

    def close(self):
        try: self.proc.stdin.close()
        except OSError: pass
        for sig in (None, signal.SIGTERM, signal.SIGKILL):
            if sig:
                try: os.killpg(self.proc.pid, sig)
                except OSError: pass
            try: self.proc.wait(5); break
            except subprocess.TimeoutExpired: pass


def get(sid): return SESSIONS.get(sid)


@atexit.register
def close_all():
    for s in list(SESSIONS.values()): s.close()
