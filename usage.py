"""API-equivalent cost of all Claude Code usage (today / this month) from ~/.claude/projects transcripts."""
import glob, json, os
from datetime import datetime

# USD per 1M tokens: (in, out[, cache_read]); cache_read defaults to 0.1x in.
# ponytail: Haiku 5.5's >100K-prompt tier ($0.50/$2.50) and long-context surcharges are not modelled.
PRICES = {"fable-5-2": (8, 40, .2), "mythos-5-2": (8, 40, .2), "fable-5-1": (10, 50), "mythos-5-1": (10, 50),
          "fable-5": (10, 50), "opus-5-5": (4, 20, .2), "opus-5": (5, 25), "opus-4-8": (5, 25), "opus-4-7": (5, 25),
          "opus-4-6": (5, 25), "sonnet-5-5": (2, 10, .1), "sonnet-5": (2, 10), "sonnet-4-6": (3, 15),
          "haiku-5-5": (.1, .5), "haiku-4-5": (1, 5)}
_cache = {}  # path -> (mtime, size, {dedup key: (local datetime, model, cost|None, tokens)})

def norm(m):
    m = m.removeprefix("claude-").split("[")[0]
    return m[:-9] if len(m) > 9 and m[-9] == "-" and m[-8:].isdigit() else m

def entry(d):
    msg = d["message"]; u = msg["usage"]; m = norm(msg.get("model") or "")
    ts = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
    i, o, cr = u.get("input_tokens") or 0, u.get("output_tokens") or 0, u.get("cache_read_input_tokens") or 0
    cc = u.get("cache_creation") or {}
    if "ephemeral_5m_input_tokens" in cc or "ephemeral_1h_input_tokens" in cc:
        w5, w1 = cc.get("ephemeral_5m_input_tokens") or 0, cc.get("ephemeral_1h_input_tokens") or 0
    else:
        w5, w1 = u.get("cache_creation_input_tokens") or 0, 0
    p = PRICES.get(m)
    if p:
        crp = p[2] if len(p) > 2 else .1 * p[0]
        c = (i * p[0] + o * p[1] + cr * crp + w5 * 1.25 * p[0] + w1 * 2 * p[0]) / 1e6 * (2 if u.get("speed") == "fast" else 1)
    return ts, m, c if p else None, i + o + cr + w5 + w1

def parse(path):
    out = {}
    with open(path, errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
                if d.get("type") != "assistant" or not d["message"]["id"]: continue
                out[f"{d['message']['id']}|{d.get('requestId')}"] = entry(d)
            except Exception:
                pass
    return out

def summary(root=None, now=None):
    now = now or datetime.now()
    month0 = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    seen = {}
    for p in glob.glob(os.path.join(root or os.path.expanduser("~/.claude/projects"), "**/*.jsonl"), recursive=True):
        try:
            st = os.stat(p)
            if st.st_mtime < month0.timestamp(): continue
            if p not in _cache or _cache[p][:2] != (st.st_mtime, st.st_size):
                _cache[p] = (st.st_mtime, st.st_size, parse(p))
            seen.update(_cache[p][2])
        except OSError:
            pass
    r = {"today": [0., 0], "month": [0., 0]}; models = {}; unpriced = set()
    for ts, m, c, t in seen.values():
        if ts < month0: continue
        if c is None and m != "<synthetic>": unpriced.add(m)
        c = c or 0
        for k in ("month",) + (("today",) if ts.date() == now.date() else ()):
            r[k][0] += c; r[k][1] += t
        a = models.setdefault(m, [0., 0]); a[0] += c; a[1] += t
    return {**{k: {"cost": round(v[0], 4), "tokens": v[1]} for k, v in r.items()},
            "models": sorted(({"model": m, "cost": round(v[0], 4), "tokens": v[1]} for m, v in models.items()),
                             key=lambda x: -x["cost"]), "unpriced": sorted(unpriced)}
