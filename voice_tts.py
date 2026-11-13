"""Text-to-speech worker, run with the voice venv's python by voice.py: keeps the Piper model loaded (loading takes ~2.5 s).
argv[1] = .onnx model. One JSON {"text", "speed", "path"} per stdin line -> wav written to path, one JSON {"ok"} line."""
import json, sys, wave
from piper import PiperVoice, SynthesisConfig

voice = PiperVoice.load(sys.argv[1])
for line in sys.stdin:
    try:
        req = json.loads(line)
        with wave.open(req["path"], "wb") as w:
            voice.synthesize_wav(req["text"], w, syn_config=SynthesisConfig(length_scale=float(req["speed"])))
        out = {"ok": True}
    except Exception as e:  # keep the worker alive
        out = {"error": str(e)[:200]}
    print(json.dumps(out), flush=True)
