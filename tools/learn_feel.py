#!/usr/bin/env python3
"""Learn drum feel from a library of MIDI grooves.

    python3 tools/learn_feel.py "/path/to/midi grooves" ["/another/library" ...] [--out feel]

Walks every folder given, reads each .mid drum groove, and measures how far each hit
sits from the grid and how hard it is played. It writes timing and accent shapes only
(index.jsonl, templates.json, summary.json) into the output folder; the MIDI files are
never copied. The workbench reads that folder as its humanize options.

Drums are recognised by General MIDI note numbers (kick 35/36, snare 38/40, hats
42/44/46, ride 51/53/59, shaker and tambourine 54/69/70/82/83). Needs only Python 3.
"""
import argparse
import json
import os
import re
import struct
from collections import defaultdict
from pathlib import Path

KICK = {35, 36}
SNARE = {38, 40}
HAT = {42, 44, 46}
RIDE = {51, 53, 59}
SHAKER = {54, 69, 70, 82, 83}
GRIDS = {
    "straight": (0.0, 0.25, 0.5, 0.75),
    "swing8": (0.0, 2.0 / 3.0),
    "shuffle16": (0.0, 1.0 / 3.0, 0.5, 5.0 / 6.0),
}
BPM_RE = re.compile(r"(\d{2,3})\s*bpm", re.I)


def median(values):
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


def family(note):
    if note in KICK:
        return "kick"
    if note in SNARE:
        return "snare"
    if note in HAT:
        return "hat"
    if note in RIDE:
        return "ride"
    if note in SHAKER:
        return "shaker"
    return None


def parse(path):
    data = path.read_bytes()
    if len(data) < 14 or data[:4] != b"MThd":
        return None
    _hlen, _fmt, tracks, div = struct.unpack(">IHHH", data[4:14])
    if div & 0x8000 or div == 0:
        return None
    pos = 14
    notes = []
    tempos = []
    meters = []
    for _track in range(tracks):
        if data[pos : pos + 4] != b"MTrk":
            return None
        length = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + length]
        pos += 8 + length
        cursor = 0
        tick = 0
        running = None
        while cursor < len(body):
            value = 0
            while cursor < len(body):
                byte = body[cursor]
                cursor += 1
                value = (value << 7) | (byte & 0x7F)
                if not byte & 0x80:
                    break
            tick += value
            if cursor >= len(body):
                break
            if body[cursor] & 0x80:
                running = body[cursor]
                cursor += 1
            status = running
            if status is None or cursor >= len(body):
                break
            if status == 0xFF:
                meta = body[cursor]
                cursor += 1
                if cursor >= len(body):
                    break
                mlen = body[cursor]
                cursor += 1
                payload = body[cursor : cursor + mlen]
                cursor += mlen
                if meta == 0x51 and mlen == 3:
                    tempos.append(60_000_000 / int.from_bytes(payload, "big"))
                elif meta == 0x58 and mlen >= 2:
                    meters.append(f"{payload[0]}/{2 ** payload[1]}")
                continue
            if status in (0xF0, 0xF7):
                break
            size = 1 if (status >> 4) in (0xC, 0xD) else 2
            payload = body[cursor : cursor + size]
            cursor += size
            if (status >> 4) == 9 and len(payload) == 2 and payload[1] > 0:
                notes.append((tick, payload[0], payload[1]))
    return div, tempos, meters, notes


def nearest(frac, points):
    best_point = points[0]
    best_err = 9.0
    for point in points:
        for err in (frac - point, frac - point - 1.0, frac - point + 1.0):
            if abs(err) < abs(best_err):
                best_point = point
                best_err = err
    return best_point, best_err


def sub_index(point, swing):
    points = GRIDS[swing]
    index = min(range(len(points)), key=lambda i: abs(points[i] - point))
    if swing == "swing8":
        return 0 if index == 0 else 2
    return index


def bpm_from_path(path):
    for part in path.parts:
        found = BPM_RE.search(part)
        if found:
            bpm = int(found.group(1))
            if 40 <= bpm <= 240:
                return bpm
    return None


def tempo_band(bpm):
    if bpm < 85:
        return "slow"
    if bpm < 120:
        return "mid"
    if bpm < 160:
        return "fast"
    return "brisk"


def density_of(slots):
    occupied = [slot for slot, hits in slots.items() if hits]
    if not occupied:
        return "none"
    sixteenths = sum(1 for slot in occupied if slot % 2 == 1)
    ands = sum(1 for slot in occupied if slot % 4 == 2)
    if sixteenths >= 2 and sixteenths >= ands:
        return "sixteenth"
    if ands >= 2:
        return "eighth"
    return "quarter"


def analyze(path, root):
    parsed = parse(path)
    if not parsed:
        return None
    ppq, tempos, meters, notes = parsed
    bpm = tempos[0] if tempos else bpm_from_path(path)
    if not bpm:
        return None
    drum_notes = [(tick, note, vel) for tick, note, vel in notes if family(note)]
    if len(drum_notes) < 6:
        return None
    scores = {}
    fracs = [(tick / ppq) % 1.0 for tick, _note, _vel in drum_notes]
    for name, points in GRIDS.items():
        errs = [abs(nearest(frac, points)[1]) for frac in fracs]
        scores[name] = sum(errs) / len(errs)
    swing = min(scores, key=scores.get)
    if swing != "straight" and scores[swing] > scores["straight"] * 0.85:
        swing = "straight"
    meter = meters[0] if meters else "4/4"
    folded = str(path).lower()
    if meter != "4/4" or any(word in folded for word in ("triplet", "sixeight", "6/8", "3/4", "waltz")):
        swing = "other"
    grid_name = "straight" if swing == "other" else swing
    points = GRIDS[grid_name]
    buckets = {name: defaultdict(list) for name in ("kick", "snare", "hat", "ride", "shaker")}
    residuals_ticks = []
    for tick, note, vel in drum_notes:
        name = family(note)
        beats = tick / ppq
        beat_in_bar = beats % 4.0
        beat_i = int(beat_in_bar)
        if beat_i > 3:
            beat_i = 3
        frac = beat_in_bar - beat_i
        point, err = nearest(frac, points)
        if abs(err) > 0.18:
            continue
        if frac - point > 0.5:
            # A hit played just ahead of the next beat belongs to that beat, not this one.
            beat_i = (beat_i + 1) % 4
        slot = beat_i * 4 + sub_index(point, grid_name)
        buckets[name][slot].append((err, vel))
        residuals_ticks.append(abs(err) * ppq)
    if len(residuals_ticks) < 6:
        return None
    beat_ms = 60000.0 / bpm
    tick_ms = beat_ms / ppq
    abs_ms = [ticks * tick_ms for ticks in residuals_ticks]
    loose = sum(1 for ticks in residuals_ticks if ticks >= 2.0)
    exact = sum(1 for ticks in residuals_ticks if ticks < 0.51)
    parts = {}
    for name, slots in buckets.items():
        kept = []
        for slot, hits in sorted(slots.items()):
            if not hits:
                continue
            offset_ms = median([err * beat_ms for err, _vel in hits])
            vel = int(round(median([vel for _err, vel in hits])))
            kept.append([slot, round(offset_ms, 1), vel, len(hits)])
        if kept:
            parts[name] = kept
    keeper = "hat" if "hat" in parts else ("ride" if "ride" in parts else "snare")
    density = density_of({slot: True for slot, _ms, _vel, _n in parts.get(keeper, [])})
    inside = path.relative_to(root)
    # The first folder under the root names the library the groove came from.
    lib = inside.parts[0] if len(inside.parts) > 1 else root.name
    rel = str(Path(*inside.parts[1:])) if len(inside.parts) > 1 else inside.name
    kind = "fill" if "fill" in path.name.lower() else "groove"
    return {
        "lib": lib.replace(" Library", "").replace(" Drummer", ""),
        "rel": rel,
        "bpm": round(bpm, 1),
        "ppq": ppq,
        "meter": meter,
        "swing": swing,
        "density": density,
        "kind": kind,
        "notes": len(drum_notes),
        "human_ms": round(median(abs_ms), 1),
        "loose": round(loose / len(residuals_ticks), 3),
        "exact": round(exact / len(residuals_ticks), 3),
        **parts,
    }


def template_key(row):
    return f"{row['swing']}|{row['density']}|{tempo_band(row['bpm'])}"


def build_templates(rows):
    grouped = defaultdict(list)
    for row in rows:
        if row["kind"] != "groove" or row["swing"] == "other":
            continue
        if row["loose"] < 0.15 and row["human_ms"] < 6:
            continue
        grouped[template_key(row)].append(row)
    templates = {}
    for key, members in sorted(grouped.items()):
        if len(members) < 8:
            continue
        swing, density, band = key.split("|")
        shape = {}
        for name in ("kick", "snare", "hat", "ride", "shaker"):
            slot_offsets = defaultdict(list)
            slot_vels = defaultdict(list)
            for row in members:
                for slot, offset_ms, vel, _count in row.get(name, []):
                    slot_offsets[slot].append(offset_ms / (60000.0 / row["bpm"]))
                    slot_vels[slot].append(vel)
            slots = {}
            for slot, offsets in slot_offsets.items():
                if len(offsets) < max(6, len(members) // 8):
                    continue
                beat = median(offsets)
                if abs(beat) > 0.04:
                    continue
                vel = median(slot_vels[slot])
                slots[str(slot)] = {
                    "beat": round(beat, 4),
                    "ms_at_100": round(beat * 600.0, 1),
                    "vel": int(round(vel)),
                    "files": len(offsets),
                }
            if slots:
                shape[name] = slots
        if not shape:
            continue
        templates[key] = {
            "swing": swing,
            "density": density,
            "tempo": band,
            "files": len(members),
            "bpm_median": round(median([row["bpm"] for row in members]), 1),
            "human_ms_median": round(median([row["human_ms"] for row in members]), 1),
            "parts": shape,
        }
    return templates


def main():
    parser = argparse.ArgumentParser(description="Learn drum feel from folders of MIDI grooves.")
    parser.add_argument("folders", nargs="+", help="folders that contain .mid drum grooves (searched recursively)")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "feel"), help="where to write the learned feel (default: feel/ in the repo)")
    args = parser.parse_args()
    OUT = Path(args.out).expanduser()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    skipped = 0
    seen = 0
    for folder in args.folders:
        root = Path(folder).expanduser().resolve()
        if not root.is_dir():
            print("missing", root)
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if not name.lower().endswith((".mid", ".midi")) or name.startswith("."):
                    continue
                seen += 1
                path = Path(dirpath) / name
                try:
                    row = analyze(path, root)
                except Exception:
                    skipped += 1
                    continue
                if row is None:
                    skipped += 1
                    continue
                rows.append(row)
                if seen % 2000 == 0:
                    print(f"  {seen} files, kept {len(rows)}", flush=True)
    if not rows:
        raise SystemExit(f"No usable drum grooves found ({seen} MIDI files seen). Nothing written.")
    out_index = OUT / "index.jsonl"
    with out_index.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    templates = build_templates(rows)
    (OUT / "templates.json").write_text(json.dumps(templates, indent=2))
    by_swing = defaultdict(int)
    by_lib = defaultdict(int)
    loose = 0
    fills = 0
    for row in rows:
        by_swing[row["swing"]] += 1
        by_lib[row["lib"]] += 1
        fills += row["kind"] == "fill"
        loose += row["loose"] >= 0.15 or row["human_ms"] >= 6
    summary = {
        "files_seen": seen,
        "files_kept": len(rows),
        "files_skipped": skipped,
        "fills": fills,
        "with_feel": loose,
        "by_swing": dict(by_swing),
        "by_library": dict(by_lib),
        "templates": len(templates),
        "human_ms_median": round(median([row["human_ms"] for row in rows]), 1) if rows else 0,
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    print("templates", ", ".join(f"{key} ({item['files']})" for key, item in templates.items()))


if __name__ == "__main__":
    main()
