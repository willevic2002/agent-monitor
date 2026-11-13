"""Speech-to-text worker, run with the voice venv's python by voice.py: one JSON wav path per stdin line -> one JSON {"text"} line."""
import json, sys, wave
import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel("small.en", device="cpu", compute_type="int8")
for line in sys.stdin:
    try:
        with wave.open(json.loads(line)) as w:   # pw-record writes 16 kHz mono s16; skips PyAV, whose 19.x API breaks faster-whisper
            pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        segs, _ = model.transcribe(pcm, language="en", vad_filter=True, beam_size=1)
        out = {"text": " ".join(s.text.strip() for s in segs).strip()}
    except Exception as e:  # bad/empty wav: report, keep the worker alive
        out = {"text": "", "error": str(e)[:200]}
    print(json.dumps(out), flush=True)
