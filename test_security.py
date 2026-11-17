import http.client, json, os, shutil, stat, sys, tempfile, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
AFAKE = os.path.join(tempfile.mkdtemp(), "stdin.log")
os.environ.update(AM_CLAUDE=os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "fake_claude.py"), AM_FAKE_STDIN_LOG=AFAKE, AM_FAKE_DELAY="0")
import server, driver

HERE = os.path.dirname(os.path.abspath(__file__))
proj = tempfile.mkdtemp()
shutil.copytree(os.path.join(HERE, "tests", "fixtures", "t2"), os.path.join(proj, "p"))
server.PROJ = proj
SID = "cb492573-7564-46f0-ab1d-df4568c13342"
cfg = os.path.join(tempfile.mkdtemp(), "cfg")
httpd, tok = server.make_server(0, cfg)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
H = f"127.0.0.1:{port}"
J = {"Content-Type": "application/json"}


def req(method, path, headers=None, body=None, host=H):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Host": host, **(headers or {})}
    c.request(method, path, body=body, headers=h)
    r = c.getresponse(); data = r.read(); hd = {k.lower(): v for k, v in r.getheaders()}
    c.close()
    return r.status, hd, data


def once():
    s, _, d = req("POST", "/api/once", {**J, "X-AM-Token": tok}, "{}")
    assert s == 200, s
    import json; return json.loads(d)["once"]

seen = []
def chk(*a, **k):
    r = req(*a, **k); seen.append(r[1]); return r

# bound to loopback; token file perms
assert httpd.server_address[0] == "127.0.0.1"
assert stat.S_IMODE(os.stat(cfg).st_mode) == 0o700
assert stat.S_IMODE(os.stat(os.path.join(cfg, "token")).st_mode) == 0o600
assert open(os.path.join(cfg, "token")).read() == tok

# auth
assert chk("GET", "/api/state")[0] == 401
assert chk("GET", "/api/state", {"X-AM-Token": "wrong"})[0] == 401
assert chk("GET", "/api/state", {"Cookie": "am=wrong"})[0] == 401
assert chk("GET", "/api/state", {"X-AM-Token": tok})[0] == 200
assert chk("POST", "/api/once", J, "{}")[0] == 401

# token path symlink is refused; config dir must be ours
evil = os.path.join(tempfile.mkdtemp(), "evil")
os.makedirs(os.path.join(evil, "cfg")); open(os.path.join(evil, "target"), "w").write("keep")
os.symlink(os.path.join(evil, "target"), os.path.join(evil, "cfg", "token"))
try:
    server.make_server(0, os.path.join(evil, "cfg")); raise SystemExit("symlinked token followed")
except OSError:
    pass
assert open(os.path.join(evil, "target")).read() == "keep"
real_uid = os.getuid; os.getuid = lambda: real_uid() + 1
try:
    server.make_server(0, os.path.join(evil, "cfg")); raise SystemExit("foreign-owned dir accepted")
except SystemExit as e:
    assert "not owned" in str(e)
finally:
    os.getuid = real_uid

# Sec-Fetch-Site
ck0 = {"Cookie": f"am={tok}"}
for v, want in (("same-site", 403), ("cross-site", 403), ("same-origin", 200), ("none", 200)):
    assert chk("GET", "/api/state", {**ck0, "Sec-Fetch-Site": v})[0] == want, v

# nonce flow
n = once()
s, hd, _ = chk("GET", "/login?once=" + n)
assert s == 303 and hd["location"] == "/"
assert hd["set-cookie"] == f"am={tok}; HttpOnly; SameSite=Strict; Path=/", hd["set-cookie"]
assert chk("GET", "/api/state", {"Cookie": f"am={tok}"})[0] == 200
assert chk("GET", "/login?once=" + n)[0] == 403          # single use
assert chk("GET", "/login?once=bogus")[0] == 403
s, hd, _ = chk("GET", "/login?once=" + once() + "&to=brain"); assert s == 303 and hd["location"] == "/brain"
s, hd, _ = chk("GET", "/login?once=" + once() + "&to=//evil.example"); assert s == 303 and hd["location"] == "/"   # no open redirect
assert chk("GET", "/brain")[0] == 200   # static page like "/"; all data stays behind /api auth
assert chk("GET", "/brain.js", {"Cookie": f"am={tok}"})[0] == 200 and chk("GET", "/vendor/three.min.js", {"Cookie": f"am={tok}"})[0] == 200
httpd.once_ttl = 0.2
n = once(); time.sleep(0.4)
assert chk("GET", "/login?once=" + n)[0] == 403          # expired
httpd.once_ttl = 30
first = once()
for _ in range(20): once()
assert len(httpd.nonces) <= 16 and chk("GET", "/login?once=" + first)[0] == 403

# host check, even with valid token
for bad in ("evil.com:%d" % port, "127.0.0.1.nip.io", "127.0.0.1", "localhost:1"):
    assert chk("GET", "/api/state", {"X-AM-Token": tok}, host=bad)[0] == 403, bad
    assert chk("GET", "/", host=bad)[0] == 403, bad
assert chk("GET", "/api/state", {"X-AM-Token": tok}, host=f"localhost:{port}")[0] == 200

# foreign origin
ck = {"Cookie": f"am={tok}", "Origin": "http://evil.example", **J}
assert chk("POST", "/api/once", ck, "{}")[0] == 403
assert chk("POST", "/api/sessions", ck, "{}")[0] == 403
assert chk("GET", "/api/state", ck)[0] == 403
assert chk("POST", "/api/once", {"X-AM-Token": tok, "Origin": f"http://localhost:{port}", **J}, "{}")[0] == 200

# content-type / size
assert chk("POST", "/api/once", {"X-AM-Token": tok, "Content-Type": "text/plain"}, "{}")[0] == 415
c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
c.putrequest("POST", "/api/once", skip_host=True); c.putheader("Host", H)
c.putheader("X-AM-Token", tok); c.putheader("Content-Type", "application/json")
c.putheader("Content-Length", str(1024 * 1024 + 1)); c.endheaders()
assert c.getresponse().status == 413; c.close()

# OPTIONS, nosniff etc.
s, hd, _ = chk("OPTIONS", "/api/state")
assert s == 405
s, hd, _ = chk("GET", "/")
assert s == 200 and hd["x-content-type-options"] == "nosniff" and hd["x-frame-options"] == "DENY" \
    and hd["referrer-policy"] == "no-referrer" and "frame-ancestors 'none'" in hd["content-security-policy"]

# static
assert chk("GET", "/vendor/three.min.js")[0] == 200
s, hd, _ = chk("GET", "/")
csp = hd["content-security-policy"]
assert "unsafe-inline" not in [d for d in csp.split(";") if "script-src" in d][0] and "style-src 'self' 'unsafe-inline'" in csp
assert chk("GET", "/app.js")[0] == 404   # graph view removed; only brain remains
assert chk("GET", "/vendor/../server.py")[0] == 404
assert chk("GET", "/vendor/%2e%2e/server.py")[0] == 404
assert chk("GET", "/server.py")[0] == 404

# /api/log validation
A = {"X-AM-Token": tok}
sid = "0" * 8 + "-0000-0000-0000-" + "0" * 12
assert chk("GET", f"/api/log?session={sid}&node=../../etc", A)[0] == 400
assert chk("GET", "/api/log?session=../x&node=lead", A)[0] == 400
assert chk("GET", f"/api/log?session={sid}&node=lead", A)[0] == 404

s, _, d = chk("GET", f"/api/log?session={SID}&node=lead", A)
assert s == 200 and json.loads(d)["entries"]
aid = sorted(f[6:-6] for f in os.listdir(os.path.join(proj, "p", SID, "subagents")) if f.endswith(".jsonl"))[0]
s, _, d = chk("GET", f"/api/log?session={SID}&node={aid}", A)
assert s == 200 and json.loads(d)["entries"]
now = time.time(); os.utime(os.path.join(proj, "p", SID + ".jsonl"), (now, now))   # make it "live"
s, _, d = chk("GET", "/api/state", A)
gr = [x["graph"] for x in json.loads(d)["sessions"] if "graph" in x]
assert s == 200 and len(gr) == 1 and len(gr[0]["nodes"]) == 6

assert not [h for h in seen if any(k.startswith("access-control-") for k in h)]
# session spawning: nothing is spawned unless every gate passes
GOOD = json.dumps({"cwd": tempfile.mkdtemp(), "prompt": "hi"})
assert chk("POST", "/api/sessions", {**ck, "Origin": "http://evil.example"}, GOOD)[0] == 403
assert chk("POST", "/api/sessions", J, GOOD)[0] == 401
assert chk("POST", "/api/sessions", {"X-AM-Token": tok, "Content-Type": "text/plain"}, GOOD)[0] == 415
assert chk("POST", "/api/sessions", {"X-AM-Token": tok, "Sec-Fetch-Site": "cross-site", **J}, GOOD)[0] == 403
assert not driver.SESSIONS and not os.path.exists(AFAKE)
for bad in ({"mode": "bypassPermissions"}, {"mode": "dontAsk"}, {"resume": "../x"}, {"cwd": "/nonexistent-dir"},
            {"cwd": 5}, {"fork": "yes"}, {"prompt": ""}):
    assert chk("POST", "/api/sessions", {"X-AM-Token": tok, **J}, json.dumps({**json.loads(GOOD), **bad}))[0] == 400, bad
assert chk("POST", "/api/sessions", {"X-AM-Token": tok, **J}, "[1]")[0] == 400
assert not driver.SESSIONS and not os.path.exists(AFAKE)
assert chk("GET", "/api/sessions", {"Cookie": f"am={tok}"})[0] == 200 and chk("GET", "/api/sessions")[0] == 401

# SSE gates, and the account email never reaches the browser
src = open(os.path.join(HERE, "tests", "fixtures", "stream-recording.jsonl")).read()
assert "REDACTED" in src
fx = os.path.join(tempfile.mkdtemp(), "fx.jsonl"); open(fx, "w").write(src.replace("REDACTED", "victim@secret.example"))
os.environ["AM_FAKE_FIXTURE"] = fx
s, _, d = chk("POST", "/api/sessions", {"X-AM-Token": tok, **J}, GOOD)
assert s == 201; sid = json.loads(d)["id"]; ev = f"/api/sessions/{sid}/events"
assert chk("GET", ev)[0] == 401
assert chk("GET", ev, {"Cookie": f"am={tok}", "Origin": "http://evil.example"})[0] == 403
c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
c.request("GET", ev, headers={"Host": H, "Cookie": f"am={tok}"}); r = c.getresponse(); assert r.status == 200
buf = ""
while "can_use_tool" not in buf: buf += r.readline().decode()    # the whole handshake precedes the first permission request
assert "initialize" in open(AFAKE).read() and '"subtype": "success"' in buf and "victim@secret" not in buf and '"account"' not in buf
c.close()
# foreign Origin cannot inject a prompt into a live session
n0 = len(open(AFAKE).read())
assert chk("POST", f"/api/sessions/{sid}/prompt", {**ck, "Origin": "http://evil.example"}, json.dumps({"text": "PWNED-PROMPT"}))[0] == 403
time.sleep(0.3); assert "PWNED-PROMPT" not in open(AFAKE).read()
driver.get(sid).close()
# claude missing -> 503
real = driver.CLAUDE; driver.CLAUDE = None
s, _, d = chk("POST", "/api/sessions", {"X-AM-Token": tok, **J}, GOOD)
assert s == 503 and json.loads(d) == {"error": "claude not found"}
driver.CLAUDE = real

# control endpoints: every gate blocks them, and nothing reaches the CLI
os.environ["AM_FAKE_FIXTURE"] = os.path.join(HERE, "tests", "fixtures", "stream-recording.jsonl")
s, _, d = chk("POST", "/api/sessions", {"X-AM-Token": tok, **J}, GOOD)
assert s == 201; sid = json.loads(d)["id"]; sess = driver.get(sid)
t0 = time.time()
while not sess.pending and time.time() - t0 < 10: time.sleep(0.02)
rid = next(iter(sess.pending)); before = open(AFAKE).read()
bodies = {"permission": {"request_id": rid, "behavior": "allow"}, "interrupt": {}, "mode": {"mode": "plan"}}
for act, b in bodies.items():
    path, js = f"/api/sessions/{sid}/{act}", json.dumps(b)
    assert chk("POST", path, {**ck, "Origin": "http://evil.example"}, js)[0] == 403, act
    assert chk("POST", path, J, js)[0] == 401, act
    assert chk("POST", path, {"X-AM-Token": "wrong", **J}, js)[0] == 401, act
    assert chk("POST", path, {"X-AM-Token": tok, "Sec-Fetch-Site": "cross-site", **J}, js)[0] == 403, act
    assert chk("POST", path, {"X-AM-Token": tok, **J}, js, host="evil.com")[0] == 403, act
    assert chk("POST", path, {"X-AM-Token": tok, "Content-Type": "text/plain"}, js)[0] == 415, act
time.sleep(0.3)
assert open(AFAKE).read() == before and rid in sess.pending
for m in ("bypassPermissions", "dontAsk", "BypassPermissions", ""):
    assert chk("POST", f"/api/sessions/{sid}/mode", {"X-AM-Token": tok, **J}, json.dumps({"mode": m}))[0] == 400, m
time.sleep(0.3)
assert open(AFAKE).read() == before and "set_permission_mode" not in before
sess.close()
# nothing we write to stdin can carry updatedPermissions or bypassPermissions
assert "updatedPermissions" not in open(AFAKE).read() and "bypassPermissions" not in open(AFAKE).read()
for f in ("driver.py", "server.py"):
    src = open(os.path.join(HERE, f)).read()
    assert "updatedPermissions" not in src and "bypassPermissions" not in src.replace("never bypassPermissions", "")
httpd.shutdown()
print("ok")
