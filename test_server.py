import http.client, json, os, sys, tempfile, threading, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
LOG = os.path.join(tempfile.mkdtemp(), "stdin.log")
os.environ.update(AM_CLAUDE=os.path.join(HERE, "tests", "fake_claude.py"), AM_FAKE_DELAY="0.01", AM_FAKE_STDIN_LOG=LOG)
import server, driver

# stage heuristics
assert server.stage_of("Agent", {"subagent_type": "cdt:code-reviewer"}) == "review"
assert server.stage_of("Agent", {"subagent_type": "cdt:backend-engineer"}) == "dispatch"
assert server.stage_of("Bash", {"command": "cdt-verify -- pytest"}) == "gates"
assert server.stage_of("Read", {"file_path": "x"}) is None

# transcript parsing: pending vs answered tool calls
lines = [
    {"type": "assistant", "timestamp": "t1", "message": {"model": "claude-opus-5-5", "content": [
        {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "ls"}},
        {"type": "tool_use", "id": "b", "name": "Read", "input": {"file_path": "/x/y.py"}}]}},
    {"type": "user", "timestamp": "t2", "message": {"content": [{"type": "tool_result", "tool_use_id": "a"}]}},
]
p = server.parse(lines)
assert p["model"] == "claude-opus-5-5" and [c["pending"] for c in p["calls"]] == [False, True]

# tail_lines drops a half-cut first line instead of crashing
with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
    f.write("\n".join(json.dumps({"type": "user", "n": i}) for i in range(50)))
assert all("n" in d for d in server.tail_lines(f.name, 200))
os.unlink(f.name)

# calendar: one day's Calm Week blocks, sorted, skipped ones dropped; missing or broken data gives []
cw = tempfile.mkdtemp(); os.mkdir(os.path.join(cw, "data"))
assert server.calendar("2026-11-13", cw) == []
blk = lambda start, minutes, **k: {"title": "T", "category": "study", "start": start, "minutes": minutes, "skipped": False, **k}
json.dump({"weeks": {"2026-W46": {"blocks": [blk("2026-11-13T21:00", 180), blk("2026-11-13T08:15", 45, title="Lab"), blk(None, 60),
                                             blk("2026-11-13T09:00", 60, skipped=True), blk("2026-11-12T10:00", 60)]}}}, open(os.path.join(cw, "data", "state.json"), "w"))
json.dump({"categories": {"study": {"name": "Study", "color": "#6c8ebf"}}}, open(os.path.join(cw, "data", "template.json"), "w"))
assert server.calendar("2026-11-13", cw) == [{"start": "08:15", "end": "09:00", "title": "Lab", "color": "#6c8ebf"},
                                             {"start": "21:00", "end": "24:00", "title": "T", "color": "#6c8ebf"}]
open(os.path.join(cw, "data", "state.json"), "w").write("{broken")
assert server.calendar("2026-11-13", cw) == []

# full state() against the real ~/.claude runs without raising
assert isinstance(server.state()["sessions"], list)

# end to end over HTTP with the fake claude
httpd, tok = server.make_server(0, os.path.join(tempfile.mkdtemp(), "cfg"))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_address[1]
HD = {"Host": f"127.0.0.1:{port}", "Cookie": f"am={tok}", "Content-Type": "application/json"}
c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
c.request("POST", "/api/sessions", json.dumps({"cwd": tempfile.mkdtemp(), "prompt": "/cdt:orchestration test"}), HD)
r = c.getresponse(); assert r.status == 201; sid = json.loads(r.read())["id"]
hm = tempfile.mkdtemp(); os.makedirs(os.path.join(hm, "rel")); os.environ["HOME"] = hm
c3 = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
c3.request("POST", "/api/sessions", json.dumps({"cwd": "~/rel", "prompt": "tilde"}), HD)
r = c3.getresponse(); assert r.status == 201; tid = json.loads(r.read())["id"]; driver.get(tid).close(); c3.close()
assert server.tilde(server.HOME + "x") == server.HOME + "x" and server.tilde(server.HOME + "/a") == "~/a" and server.tilde(server.HOME) == "~"
c.request("GET", "/api/sessions", headers=HD); r = c.getresponse()
lst = [x for x in json.loads(r.read()) if x["id"] == sid]; assert lst[0]["id"] == sid and lst[0]["title"] == "/cdt:orchestration test" and lst[0]["mode"] == "default"
c.request("POST", "/api/sessions/" + "0" * 32 + "/prompt", json.dumps({"text": "x"}), HD); r = c.getresponse(); r.read(); assert r.status == 404
c.request("POST", f"/api/sessions/{sid}/prompt", json.dumps({"text": ""}), HD); r = c.getresponse(); r.read(); assert r.status == 400

c.request("GET", f"/api/sessions/{sid}/events", headers=HD)
r = c.getresponse(); assert r.status == 200 and r.getheader("Content-Type") == "text/event-stream" and r.getheader("Cache-Control") == "no-store"


def sse_until(pred):
    ev, data, ids = None, None, []
    while True:
        line = r.readline().decode()
        assert line, "stream ended"
        line = line.rstrip("\n")
        if line.startswith("id: "): ids.append(int(line[4:]))
        elif line.startswith("event: "): ev = line[7:]
        elif line.startswith("data: "): data = json.loads(line[6:])
        elif line == "" and ev:
            if ev == "graph" and pred(data): return data, ids
            ev = None


g, ids = sse_until(lambda g: any(n["kind"] == "agent" for n in g["nodes"]))
assert ids == sorted(ids) and ids[0] == 0
sess = driver.get(sid)
for _ in range(500):
    if sess.pending: break
    time.sleep(0.02)
sess.answer(next(iter(sess.pending)), True)
g, _ = sse_until(lambda g: any(e["kind"] == "handback" for e in g["edges"]) and all(n["status"] == "done" for n in g["nodes"] if n["kind"] == "agent"))
# resume from Last-Event-ID replays only later events
c2 = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
c2.request("GET", f"/api/sessions/{sid}/events", headers={**HD, "Last-Event-ID": "5"}); r2 = c2.getresponse()
assert r2.readline().decode() == "id: 6\n"
c2.close(); c.close()
# observed list hides the driven session's transcript
import shutil
server.PROJ = tempfile.mkdtemp(); shutil.copytree(os.path.join(HERE, "tests", "fixtures", "t2"), os.path.join(server.PROJ, "p"))
T = os.path.join(server.PROJ, "p", "cb492573-7564-46f0-ab1d-df4568c13342.jsonl"); os.utime(T)
assert [x["id"] for x in server.state()["sessions"]] == ["cb492573-7564-46f0-ab1d-df4568c13342"]
sess.sid = "cb492573-7564-46f0-ab1d-df4568c13342"
assert server.state()["sessions"] == []
# local prompt is in the log; stream ends with `event: end` after the child exits
assert sess.snapshot()[0].get("am_local")
sess.close()
c4 = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
c4.request("GET", f"/api/sessions/{sid}/events", headers=HD); tail = c4.getresponse().read().decode()
assert "event: end" in tail
httpd.shutdown()
print("ok")

# control endpoints over HTTP (permission / interrupt / mode)
httpd, tok = server.make_server(0, os.path.join(tempfile.mkdtemp(), "cfg"))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()


def call(method, path, body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request(method, path, json.dumps(body) if body is not None else None,
              {"Host": f"127.0.0.1:{port}", "X-AM-Token": tok, "Content-Type": "application/json"})
    r = c.getresponse(); d = r.read(); c.close()
    return r.status, json.loads(d)


def until(f, what, t=10):
    end = time.time() + t
    while time.time() < end:
        if (r := f()): return r
        time.sleep(0.02)
    raise AssertionError("timeout: " + what)


def has(s, pred): return any(pred(e) for e in s.snapshot())


def new(fixture):
    os.environ["AM_FAKE_FIXTURE"] = os.path.join(HERE, "tests", "fixtures", fixture)
    st, d = call("POST", "/api/sessions", {"cwd": tempfile.mkdtemp(), "prompt": "go"}); assert st == 201
    s = driver.get(d["id"]); return s, f"/api/sessions/{s.id}"


def listed(s): return next(x for x in call("GET", "/api/sessions")[1] if x["id"] == s.id)


def stdin_lines(): return [json.loads(l) for l in open(LOG)]


# allow: original input is sent, client-supplied input is ignored; second answer 404
s, base = new("stream-recording.jsonl")
rid = next(iter(until(lambda: dict(s.pending), "pending")))
assert listed(s)["status"] == "waiting" and listed(s)["pending"] == 1
assert call("POST", base + "/permission", {"request_id": "nope", "behavior": "allow"})[0] == 404
for bad in ({}, {"request_id": rid}, {"request_id": rid, "behavior": "ALLOW"}, {"request_id": 5, "behavior": "allow"}):
    assert call("POST", base + "/permission", bad)[0] == 400, bad
assert call("POST", base + "/permission", {"request_id": rid, "behavior": "allow", "updatedInput": {"command": "rm -rf /"},
                                           "input": {"command": "evil"}, "updatedPermissions": [1]}) == (200, {"ok": True})
assert call("POST", base + "/permission", {"request_id": rid, "behavior": "allow"})[0] == 404
until(lambda: has(s, lambda e: e.get("type") == "result"), "result")
assert has(s, lambda e: e.get("subtype") == "task_notification")
resp = next(l for l in stdin_lines() if l.get("type") == "control_response" and l["response"]["request_id"] == rid)
assert resp["response"]["response"] == {"behavior": "allow", "updatedInput": {"command": "touch x.txt", "description": "Create empty file x.txt"}}
assert "rm -rf" not in open(LOG).read() and "updatedPermissions" not in open(LOG).read()
until(lambda: listed(s)["status"] == "idle", "idle"); assert listed(s)["pending"] == 0
# mode: only the three safe ones
for m in ("default", "acceptEdits", "plan"):
    assert call("POST", base + "/mode", {"mode": m}) == (200, {"ok": True}) and listed(s)["mode"] == m
for m in ("dontAsk", "bypassPermissions", "", "Plan", None, 1):
    assert call("POST", base + "/mode", {"mode": m})[0] == 400, m
until(lambda: sum(l.get("request", {}).get("subtype") == "set_permission_mode" for l in stdin_lines()) == 3, "3 mode requests")
assert call("POST", "/api/sessions/" + "0" * 32 + "/mode", {"mode": "plan"})[0] == 404
s.close()

# deny
s, base = new("stream-deny.jsonl")
rid = next(iter(until(lambda: dict(s.pending), "pending")))
assert call("POST", base + "/permission", {"request_id": rid, "behavior": "deny"})[0] == 200
until(lambda: has(s, lambda e: e.get("type") == "user" and "Denied" in json.dumps(e)), "deny tool_result")
s.close()

# interrupt with a pending request: denied first, then interrupt
s, base = new("stream-deny.jsonl")
rid = next(iter(until(lambda: dict(s.pending), "pending")))
assert call("POST", base + "/interrupt", {})[0] == 202
until(lambda: has(s, lambda e: e.get("subtype") == "error_during_execution"), "interrupted")
assert not s.pending
ls = stdin_lines(); i = max(n for n, l in enumerate(ls) if l.get("type") == "control_response" and l["response"]["request_id"] == rid and l["response"]["response"]["behavior"] == "deny")
assert ls[i]["response"]["response"] == {"behavior": "deny", "message": "Avbruten i Agent Monitor"}
assert any(l.get("request", {}).get("subtype") == "interrupt" for l in ls[i:])
s.close()

# voice not installed: 503, bad text 400
import voice
def _no_tts(t): raise FileNotFoundError("piper")
voice.status, voice.tts = (lambda: {"tts": False, "stt": False}), _no_tts
assert call("GET", "/api/voice") == (200, {"tts": False, "stt": False})
assert call("POST", "/api/tts", {"text": "hej"})[0] == 503
for t in ("", None, "x" * 5001): assert call("POST", "/api/tts", {"text": t})[0] == 400, t
assert call("POST", "/api/stt/start", {})[0] == 503
assert call("POST", "/api/stt/stop", {})[0] == 503
# speaking: played server-side by pw-play; /api/tts/stop cuts it off and the temp wav is removed
fake = tempfile.mkdtemp(); open(os.path.join(fake, "pw-play"), "w").write("#!/bin/sh\necho \"$1\" > \"$(dirname \"$0\")/arg\"; sleep 30\n")
os.chmod(os.path.join(fake, "pw-play"), 0o755); os.environ["PATH"] = fake + ":" + os.environ["PATH"]
voice.tts = lambda t: b"RIFF"
res = []; th = threading.Thread(target=lambda: res.append(call("POST", "/api/tts", {"text": "hej"}))); th.start()
until(lambda: os.path.exists(os.path.join(fake, "arg")), "pw-play started")
t0 = time.time(); assert call("POST", "/api/tts/stop", {}) == (200, {})
th.join(5); assert res == [(200, {})] and time.time() - t0 < 3, res
assert not os.path.exists(open(os.path.join(fake, "arg")).read().strip())
httpd.shutdown()
print("ok")
