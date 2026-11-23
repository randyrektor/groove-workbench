"""Drum reading: decode, separate the drum stem, find hits, fit a bar grid, quantize.

Everything works in seconds on the decoded song.wav, which is the same file the
browser plays, so analysis time and playback time are the same clock.
"""
import math
import subprocess

import numpy as np
import scipy.signal as sg
import soundfile as sf

SR = 22050
HOP = 128
FRAME = HOP / SR  # 5.8 ms

KICK, SNARE, HAT = 36, 38, 42

METERS = {
    # beats per bar, slots per beat, MIDI ticks per beat (PPQ 480), accent templates
    "4/4": {"beats": 4, "spb": 4, "ticks": 480, "kick": [1, 0, 0.5, 0], "snare": [-0.5, 1, -0.5, 1], "bpm": (50, 200)},
    "3/4": {"beats": 3, "spb": 4, "ticks": 480, "kick": [1, 0, 0], "snare": [-0.5, 0.5, 0.5], "bpm": (50, 200)},
    "6/8": {"beats": 6, "spb": 2, "ticks": 240, "kick": [1, 0, 0, 0.2, 0, 0], "snare": [-0.5, 0, 0, 1, 0, 0], "bpm": (100, 330)},
}
SWINGS = {
    "straight": (0.0, 0.25, 0.5, 0.75),
    "swing8": (0.0, 1.0 / 3.0, 2.0 / 3.0, 5.0 / 6.0),
    "shuffle16": (0.0, 1.0 / 3.0, 0.5, 5.0 / 6.0),
}


# ---------------------------------------------------------------- audio files

def decode(src, dst):
    """Any audio file to 44.1 kHz stereo 16-bit WAV."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", dst],
        check=True,
    )


_MODEL = None


def separate_drums(song_wav, drums_wav):
    """Demucs drum stem, written mono at the song's sample rate."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    wav, sr = sf.read(song_wav, dtype="float32", always_2d=True)
    global _MODEL
    if _MODEL is None:
        _MODEL = get_model("htdemucs")
        _MODEL.eval()
    model = _MODEL
    mix = torch.from_numpy(np.ascontiguousarray(wav.T))
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    batch = ((mix - mean) / std)[None]
    out = None
    devices = (["mps"] if torch.backends.mps.is_available() else []) + ["cpu"]
    for device in devices:
        try:
            with torch.no_grad():
                out = apply_model(model, batch, device=device, split=True, overlap=0.25, progress=False)
            break
        except Exception:
            if device == "cpu":
                raise
    drums = out[0, model.sources.index("drums")].cpu() * std + mean
    mono = drums.mean(0).numpy()
    sf.write(drums_wav, np.clip(mono, -1, 1), sr, subtype="PCM_16")


# ------------------------------------------------------------------- features

def _env(x):
    frames = len(x) // HOP - 1
    idx = np.arange(frames)[:, None] * HOP + np.arange(HOP * 2)[None, :]
    return np.sqrt(np.mean(x[idx] ** 2, axis=1))


def _flux(env):
    out = np.zeros_like(env)
    out[2:] = np.maximum(0.0, env[2:] - env[:-2])
    return out


def features(drums_wav):
    """Attack curves per band for the whole drum stem."""
    y, sr = sf.read(drums_wav, dtype="float32", always_2d=True)
    y = y.mean(1)
    y = sg.resample_poly(y, SR, sr).astype(np.float32)
    bands = {
        "low": sg.butter(4, 110, "lowpass", fs=SR, output="sos"),
        "body": sg.butter(4, (150, 320), "bandpass", fs=SR, output="sos"),
        "crack": sg.butter(4, (1800, 6000), "bandpass", fs=SR, output="sos"),
        "air": sg.butter(4, 7500, "highpass", fs=SR, output="sos"),
    }
    feat = {"all": _flux(_env(y))}
    for name, sos in bands.items():
        feat[name] = _flux(_env(sg.sosfiltfilt(sos, y).astype(np.float32)))
    return {k: v.astype(np.float32) for k, v in feat.items()}


def _peaks(f, lo, hi, gap=0.05):
    """Local maxima of f in frames [lo, hi): list of (frame, value), strongest kept within gap."""
    seg = f[lo:hi]
    if len(seg) < 3:
        return []
    mid = seg[1:-1]
    idx = np.nonzero((mid >= seg[:-2]) & (mid > seg[2:]) & (mid > 0))[0] + 1
    order = idx[np.argsort(-seg[idx])]
    taken = []
    min_gap = gap / FRAME
    for i in order:
        if all(abs(i - j) >= min_gap for j in taken):
            taken.append(i)
    taken.sort()
    return [(lo + int(i), float(seg[i])) for i in taken]


def _ref(values, top=8):
    """Level of a typical strong hit: median of the loudest few peaks."""
    if not values:
        return 0.0
    ordered = sorted(values, reverse=True)[:top]
    return float(np.median(ordered))


def detect(feat, t0, t1, norm=None):
    """Drum hits between t0 and t1.

    Returns events {t, kick, snare, hat, masked}: strengths are 0..1+ relative to a
    typical strong hit of that drum inside this window, so no absolute loudness floors.
    """
    n = len(feat["all"])
    lo = max(0, int(t0 / FRAME))
    hi = min(n, int(t1 / FRAME))
    pk = {name: _peaks(feat[name], lo, hi) for name in ("low", "body", "crack", "air", "all")}
    # Loudness reference comes from the marked bars, not from a fill next door.
    n0, n1 = (int(norm[0] / FRAME), int(norm[1] / FRAME)) if norm else (lo, hi)
    ref = {name: _ref([v for i, v in pk[name] if n0 <= i < n1]) for name in pk}
    if ref["all"] <= 0:
        return []
    # A band with no real part in it is only bleed. Hold its reference up so bleed stays small.
    floor = {"low": 0.10, "body": 0.05, "crack": 0.04, "air": 0.012}
    for name, frac in floor.items():
        ref[name] = max(ref[name], frac * ref["all"], 1e-9)

    seeds = sorted(
        (i, name, v / ref[name])
        for name in ("low", "body", "crack", "air")
        for i, v in pk[name]
        if v / ref[name] >= 0.06
    )
    groups = []
    for i, name, s in seeds:
        if groups and i - groups[-1]["last"] <= 0.030 / FRAME:
            groups[-1]["last"] = i
            groups[-1]["frames"].append((s, i))
        else:
            groups.append({"last": i, "frames": [(s, i)]})

    def band(name, c, half=4):
        a, b = max(0, c - half), min(n, c + half + 1)
        return float(feat[name][a:b].max()) / ref[name]

    raw = []
    for g in groups:
        c = max(g["frames"])[1]
        low, body, crack, air = (band(k, c) for k in ("low", "body", "crack", "air"))
        # Time: steepest full-band rise near the group.
        f0, f1 = max(0, c - 5), min(n, c + 6)
        t = (f0 + int(np.argmax(feat["all"][f0:f1]))) * FRAME
        if raw and t - raw[-1][0] < 0.02:
            # Two groups found the same attack: it is one hit. Keep the bigger reading of each
            # band and the time of the stronger one, so a faint tick cannot displace a kick.
            r = raw[-1]
            keep_t = r[0] if max(r[1:]) >= max(low, body, crack, air) else t
            raw[-1] = (keep_t, max(r[1], low), max(r[2], body), max(r[3], crack), max(r[4], air))
            continue
        # The drum head keeps moving after a kick: a second swell of sub with no attack
        # in any other band is the tail of that kick, not another hit.
        other = max(body, crack, air)
        head = None
        if other < max(0.08, 0.3 * low):
            head = next((i for i in range(len(raw) - 1, max(-1, len(raw) - 4), -1) if t - raw[i][0] < 0.14 and raw[i][1] >= 0.3 * low), None)
        elif raw and t - raw[-1][0] < 0.09 and raw[-1][1] >= 0.3 * low and other < 0.5 * low and other < 0.5 * max(raw[-1][2], raw[-1][3]):
            # Right behind a kick's attack, mostly sub, and far less attack than that kick had.
            head = len(raw) - 1
        if head is not None:
            # Keep the time of the attack; the swell only tells us how big the kick was.
            r = raw[head]
            raw[head] = (r[0], max(r[1], low), r[2], r[3], r[4])
            continue
        raw.append((t, low, body, crack, air))

    inside = [r for r in raw if not norm or norm[0] - 0.05 <= r[0] <= norm[1]] or raw
    # A snare alone has shell and wires and no sub. Learn what one looks like in these bars.
    pure = sorted((math.sqrt(r[2] * r[3]) for r in inside if r[1] < 0.2), reverse=True)
    snare_ref = max(float(np.median(pure[:4])) if pure else 0.0, 0.35)
    snare_like = [r for r in inside if r[1] < 0.2 and math.sqrt(r[2] * r[3]) >= 0.6 * snare_ref]
    sb = float(np.median([r[2] for r in snare_like])) if snare_like else 1.0
    sc = float(np.median([r[3] for r in snare_like])) if snare_like else 1.0
    # A kick alone: what its shell and click add in those two bands.
    kicks = [r for r in inside if r[1] >= 0.5]
    kb = float(np.median([r[2] for r in kicks])) if kicks else 0.0
    kc = float(np.median([r[3] for r in kicks])) if kicks else 0.0

    events = []
    for t, low, body, crack, air in raw:
        kick = low if low >= 0.06 else 0.0
        if low < 0.2:
            snare = math.sqrt(crack * body) / snare_ref
            if snare >= 0.3:
                kick = 0.0
        elif snare_like:
            # Kick and snare together: more shell and wire than the kick has by itself.
            extra = max(0.0, body - 1.3 * kb) + max(0.0, crack - 1.3 * kc)
            snare = extra / (sb + sc)
            if snare < 0.5:
                snare = 0.0
        else:
            snare = 0.0
        snare = min(1.3, snare) if snare >= 0.08 else 0.0
        hat = air if air >= 0.06 else 0.0
        masked = bool(snare >= 0.3)
        if masked:
            hat = 0.0  # snare wires fill the top; decided later from the hat pattern
        events.append({"t": round(t, 4), "kick": round(kick, 3), "snare": round(snare, 3), "hat": round(hat, 3), "masked": masked,
                       "b": (round(low, 2), round(body, 2), round(crack, 2), round(air, 2))})
    return events


# ----------------------------------------------------------------------- grid

def _onset_curve(feat, lo, hi, n0=None, n1=None):
    total = np.zeros(hi - lo, dtype=np.float64)
    for name, w in (("low", 1.0), ("body", 0.6), ("crack", 1.0), ("air", 0.4)):
        seg = feat[name][lo:hi].astype(np.float64)
        top = np.percentile(seg[n0:n1], 99.5) + 1e-9
        total += w * np.minimum(seg / top, 1.5)
    kernel = sg.windows.gaussian(13, 2.2)
    return np.convolve(total, kernel / kernel.sum(), mode="same")


def _pulse(curve, period, n_phase=None):
    """Best phase (frames) and score for a pulse train of this period (frames)."""
    n = len(curve)
    phases = np.arange(0, period, 1.0)
    count = int((n - 1 - period) // period)
    if count < 2:
        return 0.0, 0.0
    pos = phases[:, None] + np.arange(count)[None, :] * period
    i0 = np.floor(pos).astype(int)
    frac = pos - i0
    i1 = np.minimum(i0 + 1, n - 1)
    vals = curve[i0] * (1 - frac) + curve[i1] * frac
    score = vals.mean(axis=1)
    best = int(np.argmax(score))
    return float(phases[best]), float(score[best])


def _near(events, key, t, tol):
    best = 0.0
    for e in events:
        if abs(e["t"] - t) <= tol and e[key] > best:
            best = e[key]
    return min(best, 1.2)


def _lsq(events, beat, phase, t_lo, t_hi):
    """Refine beat length and phase on hits that sit on 8th positions."""
    for _ in range(3):
        half = beat / 2
        ns, ts, ws = [], [], []
        for e in events:
            if not (t_lo <= e["t"] <= t_hi):
                continue
            w = max(e["kick"], e["snare"], 0.5 * e["hat"])
            if w < 0.25:
                continue
            k = round((e["t"] - phase) / half)
            if abs(e["t"] - (phase + k * half)) > 0.11 * beat:
                continue
            if k % 2:
                w *= 0.5
            ns.append(k)
            ts.append(e["t"])
            ws.append(w)
        if len(ns) < 6 or len(set(ns)) < 4:
            break
        ns, ts, ws = np.array(ns, float), np.array(ts), np.array(ws)
        slope, intercept = np.polyfit(ns, ts, 1, w=ws)
        if abs(slope * 2 / beat - 1) > 0.04:
            break
        beat, phase = slope * 2, intercept
    return beat, phase


def fit_grid(feat, a, b, meter="4/4", bars=None, bpm_hint=None, song_bpm=None):
    """Tempo, downbeat and bar count for a roughly marked region [a, b]."""
    m = METERS[meter]
    span = max(b - a, 2.0)
    pad = min(6.0, max(3.0, span * 0.5))
    w0, w1 = max(0.0, a - pad), b + pad
    events = detect(feat, w0, w1, norm=(a, b))
    lo = int(w0 / FRAME)
    hi = min(len(feat["all"]), int(w1 / FRAME))
    curve = _onset_curve(feat, lo, hi, int(a / FRAME) - lo, int(b / FRAME) - lo)

    bpm_lo, bpm_hi = m["bpm"]
    cands = set()
    if bpm_hint:
        cands.add(round(60.0 / bpm_hint / FRAME, 1))
    else:
        ac = sg.correlate(curve - curve.mean(), curve - curve.mean(), mode="full")[len(curve) - 1:]
        lag_lo, lag_hi = int(0.14 / FRAME), min(len(ac) - 2, int(2.6 / FRAME))
        seg = ac[lag_lo:lag_hi]
        idx = sg.argrelmax(seg)[0]
        idx = idx[np.argsort(-seg[idx])][:5] + lag_lo
        for lag in idx:
            for mult in (0.25, 1 / 3, 0.5, 2 / 3, 1.0, 1.5, 2.0, 3.0, 4.0):
                p = lag * mult
                if bpm_lo <= 60.0 / (p * FRAME) <= bpm_hi:
                    if not any(abs(p / q - 1) < 0.03 for q in cands):
                        cands.add(p)
        if song_bpm:
            for mult in (0.5, 1.0, 2.0):
                p = 60.0 / (song_bpm * mult) / FRAME
                if bpm_lo <= song_bpm * mult <= bpm_hi and not any(abs(p / q - 1) < 0.03 for q in cands):
                    cands.add(p)

    best = None
    for p0 in cands:
        # Fine tempo search around the candidate.
        steps = [p0] if bpm_hint else list(p0 * np.linspace(0.97, 1.03, 61))
        scored = [(_pulse(curve, p)[1], p) for p in steps]
        fit, period = max(scored)
        phase_f, _ = _pulse(curve, period)
        beat = period * FRAME
        phase = w0 + phase_f * FRAME
        if not bpm_hint:
            beat, phase = _lsq(events, beat, phase, w0, w1)
        tol = 0.09 * beat
        nb = m["beats"]
        # Which pulse is beat 1, and is the pulse on the beat or on the "&".
        for half_shift in (0.0, 0.5):
            for rot in range(nb):
                d0 = phase + (rot + half_shift) * beat
                d0 -= math.floor((d0 - w0) / (nb * beat)) * nb * beat
                total, count = 0.0, 0
                t = d0
                while t + nb * beat <= w1 + 1e-6:
                    for bi in range(nb):
                        bt = t + bi * beat
                        total += m["kick"][bi] * _near(events, "kick", bt, tol)
                        total += m["snare"][bi] * _near(events, "snare", bt, tol)
                    count += 1
                    t += nb * beat
                if not count:
                    continue
                bpm = 60.0 / beat
                prior = 0.4 * math.exp(-(math.log2(bpm / (105 if meter != "6/8" else 200)) ** 2) / 0.5)
                score = total / count + prior + 0.5 * fit - (0.3 if half_shift else 0.0)
                if best is None or score > best[0]:
                    best = (score, beat, d0)
    if best is None:
        beat = 60.0 / (bpm_hint or 100.0)
        best = (0.0, beat, a)
    _score, beat, d0 = best
    bar = m["beats"] * beat

    start = d0 + round((a - d0) / bar) * bar
    if bars is None:
        want = (b - a) / bar
        bars = min((1, 2, 4, 8), key=lambda x: abs(math.log(max(want, 0.25) / x)))
    # Refit on the chosen bars only, so the loop length matches this stretch of the take.
    if not bpm_hint:
        end = start + bars * bar
        beat2, phase2 = _lsq(events, beat, start, start - beat, end + beat)
        if abs(beat2 / beat - 1) < 0.02 and abs(phase2 - start) < 0.2 * beat:
            beat, start = beat2, phase2

    grid = {"bpm": round(float(60.0 / beat), 3), "t0": round(float(start), 4), "bars": int(bars), "meter": meter, "swing": "straight"}
    grid["swing"] = pick_swing(events, grid) if m["spb"] == 4 else "straight"
    return grid


def pick_swing(events, grid):
    beat = 60.0 / grid["bpm"]
    t0 = grid["t0"]
    end = t0 + grid["bars"] * METERS[grid["meter"]]["beats"] * beat
    fracs = []
    for e in events:
        if not (t0 - 0.1 * beat <= e["t"] <= end):
            continue
        if max(e["kick"], e["snare"], e["hat"]) < 0.25:
            continue
        fracs.append(((e["t"] - t0) / beat) % 1.0)
    off = [f for f in fracs if 0.12 < f < 0.88]
    if len(off) < 3:
        return "straight"
    scores = {}
    for name, pts in SWINGS.items():
        errs = [min(abs(f - p) for p in pts + (1.0,)) for f in fracs]
        scores[name] = sum(errs) / len(errs)
    best = min(scores, key=scores.get)
    if best != "straight" and scores[best] > scores["straight"] * 0.8:
        best = "straight"
    return best


# ------------------------------------------------------------------- quantize

def slot_positions(grid):
    """Beat position of every slot in one beat."""
    m = METERS[grid["meter"]]
    if m["spb"] == 4:
        return SWINGS.get(grid.get("swing", "straight"), SWINGS["straight"])
    return tuple(i / m["spb"] for i in range(m["spb"]))


def _velocity(drum, s):
    lo, hi = {"kick": (72, 118), "snare": (70, 118), "hat": (58, 100)}[drum]
    return int(round(lo + (hi - lo) * min(1.0, max(0.0, s)) ** 0.6))


def quantize(feat, grid, sens=None, norm=None):
    """Hits inside the grid, snapped to slots. Returns (notes, ghosts)."""
    sens = {"kick": 0.5, "snare": 0.5, "hat": 0.5, **(sens or {})}
    # Slider 0..1 to a strength threshold: 0.5 is the default cut.
    cut = {
        "kick": 0.62 * (1 - sens["kick"]) ** 1.2 + 0.03,
        "snare": 0.70 * (1 - sens["snare"]) ** 1.2 + 0.04,
        "hat": 0.56 * (1 - sens["hat"]) ** 1.2 + 0.03,
    }
    m = METERS[grid["meter"]]
    beat = 60.0 / grid["bpm"]
    spb = m["spb"]
    total = grid["bars"] * m["beats"] * spb
    pts = slot_positions(grid)
    t0 = grid["t0"]
    length = grid["bars"] * m["beats"] * beat
    # norm: the bars the loudness reference was taken from when the section was first read.
    # Keeping it fixed means sliding the grid re-snaps the same hits instead of re-judging them.
    events = detect(feat, max(0.0, t0 - 2 * beat), t0 + length + 2 * beat, norm=tuple(norm) if norm else (t0, t0 + length))

    def locate(t):
        pos = (t - t0) / beat
        whole = math.floor(pos)
        options = [(whole * spb + si, pos - (whole + p)) for si, p in enumerate(pts)]
        options.append(((whole + 1) * spb, pos - (whole + 1)))
        return min(options, key=lambda item: abs(item[1]))

    pitches = {"kick": KICK, "snare": SNARE, "hat": HAT}
    cells = {}
    masked = set()
    for e in events:
        slot, err = locate(e["t"])
        if slot == total and err < 0:
            slot, wrapped = 0, True  # the hit that lands on the loop point is beat 1
        else:
            wrapped = False
        if slot < 0 or slot >= total:
            continue
        if e["masked"]:
            masked.add(slot)
        for drum, pitch in pitches.items():
            s = e[drum]
            if s <= 0:
                continue
            key = (slot, pitch)
            prev = cells.get(key)
            if prev and (prev["s"] >= s or (wrapped and not prev["w"])):
                if not (prev["w"] and not wrapped):
                    continue
            cells[key] = {"s": s, "o": 0.0 if wrapped else err, "w": wrapped, "drum": drum}

    notes, ghosts = [], []
    for (slot, pitch), c in sorted(cells.items()):
        item = {"s": slot, "p": pitch, "v": _velocity(c["drum"], c["s"]), "o": round(max(-0.2, min(0.2, c["o"])), 4)}
        if c["s"] >= cut[c["drum"]]:
            notes.append(item)
        else:
            ghosts.append({"s": slot, "p": pitch, "k": round(c["s"], 2)})

    # Hats under a snare cannot be heard apart from the wires, and a soft one drops under
    # the cut. If the hat keeps a steady subdivision through most of the bars, it keeps it.
    hats = {n["s"] for n in notes if n["p"] == HAT}
    if hats:
        hat_vel = int(np.median([n["v"] for n in notes if n["p"] == HAT]))
        weak = {g["s"]: g for g in ghosts if g["p"] == HAT}
        for step in (spb, spb // 2, 1):
            if step < 1:
                continue
            lattice = list(range(0, total, step))
            free = [s for s in lattice if s not in masked]
            if len(free) >= 3 and sum(s in hats for s in free) / len(free) >= 0.7:
                for s in lattice:
                    if s not in hats and (s in masked or s in weak):
                        notes.append({"s": s, "p": HAT, "v": hat_vel - (0 if s in masked else 8), "o": 0.0})
                        hats.add(s)
        ghosts = [g for g in ghosts if not (g["p"] == HAT and g["s"] in hats)]
        # A bright tick that sits under a kick and off the hat's own subdivision is the beater.
        steady = [st for st in (spb, spb // 2) if st >= 1 and sum(x in hats for x in range(0, total, st)) >= 0.7 * len(range(0, total, st))]
        if steady:
            step = min(steady)
            kicks = {n["s"] for n in notes if n["p"] == KICK}
            drop = {x for x in hats if x % step and x in kicks}
            notes = [n for n in notes if not (n["p"] == HAT and n["s"] in drop)]
            ghosts += [{"s": x, "p": HAT, "k": 0.3} for x in sorted(drop)]
    notes.sort(key=lambda n: (n["s"], n["p"]))
    return notes, ghosts


def song_tempo(feat):
    """Rough whole-song beat list, used only to draw faint ticks before a section has its own grid."""
    try:
        import librosa

        curve = _onset_curve(feat, 0, len(feat["all"])).astype(np.float32)
        tempo, beats = librosa.beat.beat_track(onset_envelope=curve, sr=SR, hop_length=HOP, units="frames")
        return float(np.atleast_1d(tempo)[0]), [round(float(f) * FRAME, 3) for f in beats]
    except Exception:
        return 0.0, []
