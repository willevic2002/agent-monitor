import json, os, sys, tempfile
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage

def ts(*a): return datetime(*a).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
def line(mid, model, u, t, req="r"):
    return json.dumps({"type": "assistant", "requestId": req, "timestamp": t, "message": {"id": mid, "model": model, "usage": u}})

now = datetime(2026, 11, 17, 15, 0)
today, early, last = ts(2026, 11, 17, 10), ts(2026, 11, 2, 10), ts(2026, 10, 20, 10)
M = 1_000_000
d = tempfile.mkdtemp(); os.makedirs(d + "/p/sub")
open(d + "/p/a.jsonl", "w").write("\n".join([
    line("1", "claude-opus-5-5-20261101", {"input_tokens": M}, today),             # 4.00, date suffix
    line("1", "claude-opus-5-5", {"input_tokens": M}, today),                       # dup: counted once
    line("2", "claude-opus-5[1m]", {"output_tokens": M}, today),                    # 25.00, exact opus-5
    line("3", "claude-sonnet-5", {"cache_creation": {"ephemeral_5m_input_tokens": M, "ephemeral_1h_input_tokens": M}}, early),  # 2*1.25+2*2=6.5
    line("4", "claude-sonnet-5", {"cache_creation_input_tokens": M, "cache_read_input_tokens": M}, early),  # 2.5+0.2
    line("5", "claude-sonnet-5", {"input_tokens": M, "speed": "fast"}, early),      # 4.00
    line("6", "claude-mystery-1", {"input_tokens": 5}, today),
    line("7", "<synthetic>", {"input_tokens": 5}, today),
    line("8", "claude-opus-5", {"input_tokens": M}, last),                          # last month
    "not json {", json.dumps({"type": "assistant", "message": {"usage": {}}}),
]))
open(d + "/p/sub/b.jsonl", "w").write(line("9", "claude-haiku-4-5", {"input_tokens": M}, today))  # 1.00

s = usage.summary(d, now)
assert s["today"] == {"cost": 30.0, "tokens": 2 * M + 5 + 5 + M}, s["today"]
assert s["month"]["cost"] == round(30 + 6.5 + 2.7 + 4, 4), s["month"]
assert s["month"]["tokens"] == 3 * M + 5 + 5 + 2 * M + 2 * M + M, s["month"]
assert [m["model"] for m in s["models"]][:2] == ["opus-5", "sonnet-5"], s["models"]
assert {m["model"]: m["cost"] for m in s["models"]}["opus-5-5"] == 4.0
assert s["unpriced"] == ["mystery-1"], s["unpriced"]
print("ok")
