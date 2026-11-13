"""Optional local voice: Piper text-to-speech and push-to-talk speech-to-text (faster-whisper) for the brain view.
Everything lives in VOICE_DIR (installed by packaging/install-voice.sh); without it the API reports voice as unavailable."""
import json, os, subprocess, tempfile, threading

VOICE_DIR = os.environ.get("AM_VOICE_DIR") or os.path.expanduser("~/.local/share/agent-monitor/voice")
PY = os.path.join(VOICE_DIR, "venv", "bin", "python")
PIPER = os.path.join(VOICE_DIR, "venv", "bin", "piper")
MODEL = os.path.join(VOICE_DIR, "en_GB-alan-medium.onnx")
# "assistant in the walls" colour: short room echo + trimmed lows; skipped if ffmpeg is missing
FX = "highpass=f=110,aecho=0.8:0.6:18|36:0.22|0.12,volume=1.4"
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_stt.py")
MAX_TTS = 2000      # chars per request; the UI trims long answers anyway
MAX_REC = 120       # seconds; a stuck "hold" can't record forever

_lock = threading.Lock()
_rec = None         # (Popen, wav path) while recording
_stt = None         # persistent worker: keeps the whisper model loaded between utterances
_play = None        # pw-play process while speaking


CONF = os.path.join(os.environ.get("AM_CONFIG_DIR") or os.path.expanduser("~/.config/agent-monitor"), "voice.json")


def _conf():
    """Optional local voice.json, e.g. {"piper_model": "en_US-ryan-high", "fx": false} picks another .onnx in VOICE_DIR.
    Lives in the user's config dir, never the repo."""
    try:
        with open(CONF) as f: c = json.load(f)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def _model():
    name = str(_conf().get("piper_model") or "en_GB-alan-medium")
    p = os.path.join(VOICE_DIR, os.path.basename(name) + ".onnx")   # basename: config can't point outside VOICE_DIR
    return p if os.path.exists(p) else MODEL


def status():
    return {"tts": os.path.exists(PIPER) and os.path.exists(_model()) and _which("pw-play"), "stt": os.path.exists(PY) and _which("pw-record")}


def _which(c):
    return any(os.access(os.path.join(p, c), os.X_OK) for p in os.environ.get("PATH", "").split(":"))


def tts(text):
    """WAV bytes for text via local Piper. Text goes via stdin, never argv."""
    c = _conf()
    r = subprocess.run([PIPER, "--model", _model(), "--length_scale", str(float(c.get("speed", 1.08))), "--output_file", "-"],
                       input=text[:MAX_TTS].encode(), capture_output=True, timeout=60)
    if r.returncode != 0 or not r.stdout: raise RuntimeError("piper failed: " + r.stderr.decode(errors="replace")[-200:])
    if not c.get("fx", True) or not _which("ffmpeg"): return r.stdout
    f = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-af", FX, "-f", "wav", "pipe:1"], input=r.stdout,
                       capture_output=True, timeout=30)
    return f.stdout if f.returncode == 0 and f.stdout else r.stdout


def say(text):
    """Speak text on this machine's default output. Played here, not in the WebKit window: its media stack
    needs extra GStreamer plugins, autoplay rights, and stalled on blob audio. Blocks until done or hush()."""
    global _play
    wav = tts(text)
    fd, path = tempfile.mkstemp(prefix="am-tts-", suffix=".wav")
    try:
        with os.fdopen(fd, "wb") as f: f.write(wav)
        with _lock:
            _play = p = subprocess.Popen(["pw-play", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try: p.wait(timeout=300)
        except subprocess.TimeoutExpired: p.kill()
    finally:
        os.unlink(path)


def hush():
    with _lock: p = _play
    if p and p.poll() is None: p.terminate()


def rec_start():
    global _rec
    with _lock:
        if _rec: return
        fd, path = tempfile.mkstemp(prefix="am-rec-", suffix=".wav"); os.close(fd)
        p = subprocess.Popen(["timeout", str(MAX_REC), "pw-record", "--rate", "16000", "--channels", "1", "--format", "s16", path],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _rec = (p, path)


def rec_stop():
    """Stop recording and return the transcript ('' if nothing was said)."""
    global _rec, _stt
    with _lock:
        if not _rec: return ""
        p, path = _rec; _rec = None
    p.terminate()
    try: p.wait(5)
    except subprocess.TimeoutExpired: p.kill()
    try:
        with _lock:
            if _stt is None or _stt.poll() is not None:
                _stt = subprocess.Popen([PY, WORKER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            _stt.stdin.write(json.dumps(path) + "\n"); _stt.stdin.flush()
            line = _stt.stdout.readline()
        if not line: raise RuntimeError("speech worker died")
        out = json.loads(line)
        if out.get("error"): raise RuntimeError("speech-to-text failed: " + out["error"])
        return out.get("text", "")
    finally:
        try: os.unlink(path)
        except OSError: pass


def close():
    for p in ([_rec[0]] if _rec else []) + ([_stt] if _stt else []):
        try: p.kill()
        except Exception: pass
import atexit; atexit.register(close)
