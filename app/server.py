#!/usr/bin/env python3
"""Local server for the groove workbench. Run with ./run.sh, then open http://127.0.0.1:5177"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

import numpy as np
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

import analysis
import midi

APP = Path(__file__).resolve().parent
ROOT = APP.parent
WORK = APP / ".work"

# Personal paths live in config.json at the repo root (not committed). See config.example.json.
DEFAULT_PATHS = {"songs_dir": str(ROOT), "kit_dir": "", "feel_dir": str(ROOT / "feel"), "exports_dir": str(ROOT / "exports")}


def user_config():
    try:
        data = json.loads((ROOT / "config.json").read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_user_config(data):
    tmp = ROOT / "config.json.tmp"
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(ROOT / "config.json")


def place(key):
    """One of the user's folders: songs_dir, kit_dir, feel_dir, exports_dir."""
    value = user_config().get(key) or DEFAULT_PATHS[key]
    if not value:
        return None
    path = Path(os.path.expanduser(value))
    return path if path.is_absolute() else ROOT / path

AUDIO_EXT = {".mp3", ".m4a", ".mp4", ".aac", ".wav", ".flac", ".aif", ".aiff", ".ogg", ".opus", ".wma"}

WORK.mkdir(exist_ok=True)
app = Flask(__name__, static_folder=str(APP / "static"), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024

_feat = {}
_jobs = {}
_sep_lock = threading.Lock()


def clean(name):
    name = re.sub(r'[\\/:*?"<>|]+', " ", name)
    return re.sub(r"\s+", " ", name).strip() or "untitled"


def song_dir(sid):
    if not re.fullmatch(r"[0-9a-f]{16}", sid):
        abort(404)
    d = WORK / sid
    if not d.exists():
        abort(404)
    return d


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def write_json(path, data):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def feat_of(sid):
    if sid not in _feat:
        path = song_dir(sid) / "feat.npz"
        if not path.exists():
            abort(409, "drums are not separated yet")
        _feat[sid] = dict(np.load(path))
    return _feat[sid]


def prepare(sid):
    """Background: drum stem, attack curves, rough song tempo."""
    d = WORK / sid
    job = _jobs[sid]
    try:
        if not (d / "drums.wav").exists():
            job["stage"] = "separating"
            with _sep_lock:
                analysis.separate_drums(str(d / "song.wav"), str(d / "drums.tmp.wav"))
            (d / "drums.tmp.wav").replace(d / "drums.wav")
        job["stage"] = "analyzing"
        feat = analysis.features(str(d / "drums.wav"))
        np.savez(d / "feat.npz", **feat)
        _feat[sid] = feat
        bpm, beats = analysis.song_tempo(feat)
        meta = read_json(d / "meta.json", {})
        meta.update({"bpm": bpm, "beats": beats})
        write_json(d / "meta.json", meta)
        job["stage"] = "ready"
    except Exception as exc:
        traceback.print_exc()
        job.update({"stage": "error", "error": str(exc)})


def open_song(path, name=None):
    path = Path(path)
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        digest.update(handle.read(4 * 1024 * 1024))
    digest.update(str(path.stat().st_size).encode())
    sid = digest.hexdigest()[:16]
    d = WORK / sid
    d.mkdir(exist_ok=True)
    if not (d / "song.wav").exists():
        analysis.decode(str(path), str(d / "song.tmp.wav"))
        (d / "song.tmp.wav").replace(d / "song.wav")
    import soundfile as sf

    info = sf.info(str(d / "song.wav"))
    meta = read_json(d / "meta.json", {}) or {}
    meta.update({"id": sid, "name": clean(name or path.stem), "path": str(path), "duration": info.frames / info.samplerate})
    write_json(d / "meta.json", meta)
    ready = (d / "feat.npz").exists() and "beats" in meta
    job = _jobs.get(sid)
    if ready:
        _jobs[sid] = {"stage": "ready", "since": time.time()}
    elif not job or job["stage"] == "error":
        _jobs[sid] = {"stage": "queued", "since": time.time()}
        threading.Thread(target=prepare, args=(sid,), daemon=True).start()
    return {**meta, "beats": None, "project": read_json(d / "project.json")}


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.after_request
def no_cache(resp):
    if request.path.endswith((".js", ".css", ".html")) or request.path == "/":
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/library")
def library():
    chosen = request.args.get("dir")
    folder = os.path.expanduser(chosen) if chosen else str(place("songs_dir"))
    if not os.path.isdir(folder):
        return jsonify({"dir": folder, "error": "That folder does not exist.", "songs": []})
    if chosen and Path(folder).resolve() != place("songs_dir").resolve():
        # The folder picked in the app becomes the songs folder in config.json.
        cfg = user_config()
        cfg["songs_dir"] = folder
        save_user_config(cfg)
    songs = []
    for entry in sorted(os.scandir(folder), key=lambda e: e.name.lower()):
        if entry.is_file() and Path(entry.name).suffix.lower() in AUDIO_EXT and not entry.name.startswith("."):
            stem = clean(Path(entry.name).stem)
            out = place("exports_dir") / stem
            done = len(list(out.glob("*.mid"))) if out.exists() else 0
            songs.append({"name": stem, "path": entry.path, "exported": done})
    return jsonify({"dir": folder, "songs": songs})


@app.post("/api/pick-folder")
def pick_folder():
    """Open the system's own folder chooser on this machine and return the folder picked."""
    body = request.get_json(silent=True) or {}
    start = os.path.expanduser(str(body.get("start") or ""))
    if not os.path.isdir(start):
        start = str(place("songs_dir"))
    while not os.path.isdir(start):
        # The chooser fails outright if asked to start in a folder that is not there.
        parent = os.path.dirname(start.rstrip("/"))
        start = parent if parent and parent != start else os.path.expanduser("~")
    title = str(body.get("title") or "Choose your song folder")[:80]
    if sys.platform == "darwin":
        script = [
            "on run argv",
            "tell current application to activate",
            "POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))",
            "end run",
        ]
        cmd = ["osascript"] + [x for line in script for x in ("-e", line)] + [title, start]
    elif shutil.which("zenity"):
        cmd = ["zenity", "--file-selection", "--directory", "--title", title, "--filename", start.rstrip("/") + "/"]
    elif shutil.which("kdialog"):
        cmd = ["kdialog", "--title", title, "--getexistingdirectory", start]
    elif os.name == "nt":
        ps = ("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
              "$d.Description = $args[0]; $d.SelectedPath = $args[1]; "
              "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }")
        cmd = ["powershell", "-NoProfile", "-STA", "-Command", ps, title, start]
    else:
        return jsonify({"error": "No folder chooser is available here. Type the folder path instead."})
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        return jsonify({"error": "The folder chooser could not be opened. Type the folder path instead."})
    picked = done.stdout.strip()
    if done.returncode != 0 or not picked:
        # osascript reports Cancel as error -128; zenity, kdialog and PowerShell exit 1 silently.
        if done.stderr.strip() and "-128" not in done.stderr:
            print("pick-folder failed:", done.stderr.strip(), flush=True)
            return jsonify({"error": "The folder chooser could not be opened. Type the folder path instead."})
        return jsonify({"cancelled": True})
    return jsonify({"dir": picked if len(picked) <= 3 else picked.rstrip("/")})


def kit_dir():
    return place("kit_dir")


@app.get("/api/kit")
def kit():
    """Sample folders named "<MIDI note> <name>", each holding one WAV or a quiet-to-loud set."""
    root = kit_dir()
    drums = {}
    if root and root.is_dir():
        for folder in sorted(root.iterdir()):
            match = re.match(r"(\d+)\b", folder.name)
            if not folder.is_dir() or not match:
                continue
            files = sorted(f.name for f in folder.iterdir() if f.suffix.lower() in (".wav", ".aif", ".aiff", ".flac") and not f.name.startswith("."))
            if files:
                drums[match.group(1)] = [f"{folder.name}/{name}" for name in files]
    return jsonify({"dir": str(root or ""), "drums": drums})


@app.get("/api/kit/file")
def kit_file():
    if not kit_dir():
        abort(404)
    root = kit_dir().resolve()
    path = (root / request.args.get("f", "")).resolve()
    if root not in path.parents or not path.is_file():
        abort(404)
    return send_file(path, conditional=True)


# How a new section starts out. Everything personal lives under "defaults" in config.json;
# with no config the app is neutral: snare as snare, hats as hats, no tambourine, no layers.
@app.get("/api/config")
def get_config():
    d = user_config().get("defaults") or {}
    layers = [l for l in d.get("layers") or [] if isinstance(l, dict) and l.get("name") and isinstance(l.get("rows"), list)]
    return jsonify({
        "layers": layers,
        "prefs": {"rim": d.get("backbeat") == "rim", "shaker": d.get("hats") == "shaker", "tamb": d.get("tambourine") == "2and4"},
    })


@app.put("/api/config")
def put_config():
    body = request.get_json() or {}
    cfg = user_config()
    d = dict(cfg.get("defaults") or {})
    if "layers" in body:
        d["layers"] = [{"name": str(l["name"]), "rows": [int(p) for p in l["rows"]]} for l in body["layers"]]
    prefs = body.get("prefs") or {}
    if "rim" in prefs:
        d["backbeat"] = "rim" if prefs["rim"] else "snare"
    if "shaker" in prefs:
        d["hats"] = "shaker" if prefs["shaker"] else "hihat"
    if "tamb" in prefs:
        d["tambourine"] = "2and4" if prefs["tamb"] else "none"
    cfg["defaults"] = d
    save_user_config(cfg)
    return jsonify({"ok": True})


def folder_status():
    """What the app can see in each configured folder, in plain words."""
    out = {}
    songs = place("songs_dir")
    if songs.is_dir():
        n = sum(1 for e in os.scandir(songs) if e.is_file() and Path(e.name).suffix.lower() in AUDIO_EXT and not e.name.startswith("."))
        out["songs_dir"] = f"{n} song{'' if n == 1 else 's'} in this folder" if n else "No songs in this folder"
    else:
        out["songs_dir"] = "This folder does not exist"
    kit = place("kit_dir")
    if not kit:
        out["kit_dir"] = 'No kit chosen, so built-in synth drums play. A kit is a folder with one sub-folder per drum, such as "36 Kick".'
    elif not kit.is_dir():
        out["kit_dir"] = "This folder does not exist"
    else:
        n = sum(1 for f in kit.iterdir() if f.is_dir() and re.match(r"\d+\b", f.name))
        out["kit_dir"] = f"Samples found for {n} drum{'' if n == 1 else 's'}" if n else 'No drum folders found. Each needs a name that starts with its MIDI note, such as "36 Kick".'
    feel = place("feel_dir")
    summary = read_json(feel / "summary.json")
    if summary:
        out["feel_dir"] = f"{summary.get('templates', 0)} feels learned from {summary.get('files_kept', 0):,} grooves"
    else:
        out["feel_dir"] = "Nothing learned yet. Use the section below."
    exports = place("exports_dir")
    out["exports_dir"] = "MIDI files are saved here, in a folder per song"
    return out


@app.get("/api/settings")
def get_settings():
    cfg = user_config()
    return jsonify({
        "paths": {k: cfg.get(k) or "" for k in DEFAULT_PATHS},
        "placeholders": {k: DEFAULT_PATHS[k] or "none" for k in DEFAULT_PATHS},
        "status": folder_status(),
    })


@app.put("/api/settings")
def put_settings():
    paths = (request.get_json() or {}).get("paths") or {}
    names = {"songs_dir": "songs", "kit_dir": "drum kit"}
    for key, label in names.items():
        value = str(paths.get(key) or "").strip()
        if value:
            full = Path(os.path.expanduser(value))
            full = full if full.is_absolute() else ROOT / full
            if not full.is_dir():
                return jsonify({"error": f"The {label} folder does not exist: {value}"}), 400
    cfg = user_config()
    for key in DEFAULT_PATHS:
        if key in paths:
            cfg[key] = str(paths[key] or "").strip()
    save_user_config(cfg)
    return jsonify({"ok": True, "status": folder_status()})


@app.post("/api/learn")
def learn():
    """Run the feel learner on a folder of MIDI grooves, into the configured feel folder."""
    folder = os.path.expanduser(str((request.get_json() or {}).get("folder") or "").strip())
    if not os.path.isdir(folder):
        return jsonify({"error": "That folder does not exist."}), 400
    out = place("feel_dir")
    try:
        done = subprocess.run([sys.executable, str(ROOT / "tools" / "learn_feel.py"), folder, "--out", str(out)],
                              capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Learning took too long and was stopped."}), 500
    if done.returncode != 0:
        lines = (done.stderr or done.stdout).strip().splitlines()
        return jsonify({"error": lines[-1] if lines else "The learner failed."}), 400
    _feel_cache.clear()
    return jsonify({"ok": True, "status": folder_status()})


@app.post("/api/open")
def api_open():
    path = (request.get_json() or {}).get("path", "")
    if not os.path.isfile(path):
        abort(404)
    return jsonify(open_song(path))


@app.post("/api/upload")
def api_upload():
    file = request.files.get("file")
    if not file:
        abort(400)
    up = WORK / "uploads"
    up.mkdir(exist_ok=True)
    dest = up / clean(file.filename or "song")
    file.save(dest)
    return jsonify(open_song(dest, Path(file.filename).stem))


@app.get("/api/song/<sid>/status")
def status(sid):
    d = song_dir(sid)
    job = _jobs.get(sid) or {"stage": "ready" if (d / "feat.npz").exists() else "error", "since": time.time()}
    out = {"stage": job["stage"], "elapsed": round(time.time() - job["since"], 1), "error": job.get("error")}
    if job["stage"] == "ready":
        meta = read_json(d / "meta.json", {})
        out.update({"bpm": meta.get("bpm"), "beats": meta.get("beats", [])})
    return jsonify(out)


@app.get("/api/song/<sid>/<which>.wav")
def audio(sid, which):
    if which not in ("song", "drums"):
        abort(404)
    path = song_dir(sid) / f"{which}.wav"
    if not path.exists():
        abort(404)
    return send_file(path, mimetype="audio/wav", conditional=True)


@app.post("/api/song/<sid>/extract")
def extract(sid):
    body = request.get_json() or {}
    feat = feat_of(sid)
    meta = read_json(song_dir(sid) / "meta.json", {})
    grid = analysis.fit_grid(
        feat,
        float(body["start"]),
        float(body["end"]),
        meter=body.get("meter", "4/4"),
        bars=body.get("bars"),
        bpm_hint=body.get("bpm"),
        song_bpm=meta.get("bpm") or None,
    )
    notes, ghosts = analysis.quantize(feat, grid, body.get("sens"))
    return jsonify({"grid": grid, "notes": notes, "ghosts": ghosts})


@app.post("/api/song/<sid>/quantize")
def quantize(sid):
    body = request.get_json() or {}
    notes, ghosts = analysis.quantize(feat_of(sid), body["grid"], body.get("sens"), body.get("norm"))
    return jsonify({"notes": notes, "ghosts": ghosts})


@app.put("/api/song/<sid>/project")
def save_project(sid):
    write_json(song_dir(sid) / "project.json", request.get_json())
    return jsonify({"ok": True})


@app.post("/api/song/<sid>/export")
def export(sid):
    body = request.get_json() or {}
    meta = read_json(song_dir(sid) / "meta.json", {})
    song = clean(meta.get("name", "song"))
    label = clean(body.get("label") or "Section")
    out_dir = place("exports_dir") / song
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{song} - {label}.mid"
    path.write_bytes(midi.build(body["notes"], body["grid"], f"{song} - {label}"))
    return jsonify({"path": str(path), "rel": str(path.relative_to(ROOT)) if ROOT in path.parents else str(path), "notes": len(body["notes"])})


# ----------------------------------------------------------------- NI feel

_feel_cache = {}
PART_LABEL = {"none": "no hats", "quarter": "quarter hats", "eighth": "8th hats", "sixteenth": "16th hats"}
SWING_LABEL = {"straight": "Straight", "swing8": "Swing 8ths", "shuffle16": "Shuffle 16ths"}


def feel_data():
    FEEL = place("feel_dir")
    if _feel_cache.get("dir") != str(FEEL):
        _feel_cache.clear()
        _feel_cache["dir"] = str(FEEL)
        templates = read_json(FEEL / "templates.json", {}) or {}
        rows = []
        index = FEEL / "index.jsonl"
        if index.exists():
            with index.open() as handle:
                for line in handle:
                    row = json.loads(line)
                    if row.get("kind") != "groove" or row.get("swing") == "other":
                        continue
                    if row.get("loose", 0) < 0.15 and row.get("human_ms", 0) < 6:
                        continue
                    rows.append(row)
        _feel_cache.update({"templates": templates, "rows": rows})
    return _feel_cache


@app.get("/api/feels")
def feels():
    data = feel_data()
    swing = request.args.get("swing", "straight")
    bpm = float(request.args.get("bpm", 100))
    out = []
    for key, tpl in data["templates"].items():
        parts = {
            name: {slot: [v["beat"], v["vel"]] for slot, v in slots.items()}
            for name, slots in tpl["parts"].items()
        }
        out.append({
            "id": "t:" + key,
            "key": key,
            "swing": tpl["swing"],
            "label": f"{SWING_LABEL[tpl['swing']]} · {PART_LABEL.get(tpl['density'], tpl['density'])} · {tpl['tempo']} ({tpl['files']} grooves)",
            "parts": parts,
        })
    grooves = []
    near = sorted((r for r in data["rows"] if r["swing"] == swing), key=lambda r: abs(r["bpm"] - bpm))[:80]
    for row in near:
        beat_ms = 60000.0 / row["bpm"]
        parts = {}
        for name in ("kick", "snare", "hat", "ride", "shaker"):
            if name in row:
                parts[name] = {str(slot): [round(ms / beat_ms, 4), vel] for slot, ms, vel, _n in row[name]}
        bits = row["rel"].replace(".mid", "").split("/")
        grooves.append({
            "id": "g:" + row["lib"] + "/" + row["rel"],
            "swing": row["swing"],
            "label": f"{row['lib']} · {' / '.join(bits[-2:])} · {round(row['bpm'])} bpm",
            "parts": parts,
        })
    return jsonify({"templates": out, "grooves": grooves})


if __name__ == "__main__":
    import socket
    port = int(os.environ.get("PORT", 5177))
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            sys.exit(f"Port {port} is already in use. Groove Workbench may already be running: try http://127.0.0.1:{port}\n"
                     f"To start it on another port: PORT={port + 1} app/run.sh")
    print(f"Groove Workbench is running. Open http://127.0.0.1:{port} in your browser. Press Ctrl+C here to stop it.", flush=True)
    app.run(host="127.0.0.1", port=port, threaded=True)
