# Groove Workbench: instructions for coding agents

This file tells an AI coding agent (Claude Code, Cursor, Codex and the like) how to install,
configure and run this project for the person in front of it.

## What this is

A local web app that turns a section of a song into a short, loopable General MIDI drum
pattern, for drum pedals such as the BeatBuddy. The person drops in a song, marks a section,
and the app separates the drums, finds the tempo and bar lines, reads kick, snare and hats,
and shows the result in a drum-grid editor on the same time axis as the audio. They fix
anything that is wrong, optionally humanize it, and export `.mid` files.

Everything runs on their own machine. The repo ships no songs, no drum samples and no groove
data. The person supplies those, and your job is to wire them up.

## Set it up

1. Check the prerequisites: `ffmpeg` on the PATH, and Python 3.11 or newer (3.12 is what the
   pinned packages were tested with). The system `python3` on a Mac is 3.9 and is too old.
   Install ffmpeg with the system package manager if it is missing (ask before installing).
2. Ask the person for three things. All are optional; skip any they do not have.
   - **Songs folder**: where their audio files are (mp3, m4a, wav, flac).
   - **Drum kit folder**: samples to audition the MIDI with. See "Kit folder layout" below.
   - **MIDI groove library**: one or more folders of drum-groove `.mid` files to learn feel from
     (for example the MIDI grooves bundled with a drum plugin they own).
3. Copy `config.example.json` to `config.json` and fill in the paths they gave you. The app
   also runs with no `config.json` and writes one when settings are changed in the app. Leave a
   value as `""` to use the default. Relative paths are relative to the repo root.
   - `songs_dir`: default is the repo root. Picking a folder in the app also sets this.
   - `kit_dir`: default is none; the app then plays simple built-in synth drums.
   - `feel_dir`: default `feel`. This is where learned feel is read from.
   - `exports_dir`: default `exports`. MIDI files are written to `<exports_dir>/<Song>/`.
4. Ask how they want new sections to start out, and write it under `defaults` in
   `config.json` (see "Defaults" below). If they have no preference, leave it out.
5. If they have a MIDI groove library, learn its feel (see below).
6. Start the app: `app/run.sh`. The first run creates `app/.venv` and installs the packages in
   `app/requirements.txt`. That is a download of about 1 GB on a Mac and several GB on Linux
   with an NVIDIA card (PyTorch), so tell the person first. If the install fails partway, running
   `app/run.sh` again starts it over.
   Then open `http://127.0.0.1:5177`.
7. The first song they open triggers a one-time download of the Demucs `htdemucs` model
   weights (about 80 MB) from Hugging Face. Tell them this is expected. A warning about
   `HF_TOKEN` in the server output is harmless.

## Settings screen

Everything in `config.json` can also be changed by the person in the app: the Settings button
opens the folders, the defaults for new sections, the layers, and a "Learn" button that runs
`tools/learn_feel.py` on a folder they choose. You can set things up by editing `config.json`
or by pointing them at that screen.

## Defaults

With no `defaults` the app is neutral: the backbeat is a snare, hats are hi-hats, nothing is
added, and each section exports as one file. Everything here is optional, and the app writes
this block itself when the person changes these things in the editor.

```json
"defaults": {
  "backbeat": "rim",
  "hats": "hihat",
  "tambourine": "2and4",
  "layers": [
    { "name": "Kick", "rows": [36] },
    { "name": "Kick + Rim", "rows": [36, 37, 38] },
    { "name": "Kick + Rim + Tamb", "rows": [36, 37, 38, 54] }
  ]
}
```

- `backbeat`: `"snare"` or `"rim"`. Which drum plays the snare hits read from the record.
- `hats`: `"hihat"` or `"shaker"`. Which drum plays the hi-hat hits read from the record.
- `tambourine`: `"none"` or `"2and4"`. Whether a new section gets a tambourine on the backbeat.
- `layers`: stripped-down versions of the full groove, for pedals where each song part is its
  own file. Each layer is a name and the drum rows it keeps, as MIDI note numbers. With layers
  set, export writes one file per layer plus the full groove; with none, one file per section.
- Drum rows: 36 kick, 37 side stick, 38 snare, 42 closed hat, 46 open hat, 54 tambourine,
  82 shaker, 43/47/50 toms, 49 crash, 51 ride.

A good question to ask: "Do you want simpler versions of each groove as well, for example
kick only, then kick and snare, building up to the full pattern?"

## Learn feel from their MIDI grooves

```
python3 tools/learn_feel.py "/path/to/their/midi grooves" ["/another/library"] --out feel
```

- Needs only the Python standard library. It walks the folders recursively.
- It writes `index.jsonl`, `templates.json` and `summary.json` into the output folder. These
  hold timing offsets and velocities only. The MIDI files themselves are never copied.
- Make sure `feel_dir` in `config.json` points at that output folder, then restart the app.
- It prints a summary. If it reports zero templates, the library was too small or too tightly
  quantized to average (a template needs at least 8 similar grooves with human timing); single
  grooves are still offered in the app.
- Drums are recognised by General MIDI note numbers: kick 35/36, snare 38/40, hats 42/44/46,
  ride 51/53/59, shaker and tambourine 54/69/70/82/83. A library with a different note map
  needs those sets at the top of `tools/learn_feel.py` adjusted.

## Kit folder layout

One sub-folder per drum, named with the MIDI note number first, for example:

```
My Kit/
  36 Kick/kick.wav
  37 Cross Stick/stick V01.wav ... stick V15.wav
  54 Tambourine/tamb V01.wav ...
  82 Shaker/shaker.wav
```

A folder with one file is played at a level set by note velocity. A folder with several files
is treated as a quiet-to-loud set, sorted by file name, and velocity picks the file. Drums
with no folder use the built-in synth.

## Verify it works

- `curl -s http://127.0.0.1:5177/api/settings` shows each folder and what was found in it.
- `curl -s http://127.0.0.1:5177/api/library` lists the songs in `songs_dir`.
- `curl -s http://127.0.0.1:5177/api/kit` lists the kit samples that were found.
- `curl -s "http://127.0.0.1:5177/api/feels?swing=straight&bpm=100"` returns templates and
  grooves if feel was learned.
- In the browser: open a song, wait for "Drums separated", drag across four bars of a section
  with drums, press Extract, press Space to loop.

## Where things are

- `app/server.py`: local Flask server and all API routes.
- `app/analysis.py`: decoding, drum separation, hit detection, grid fitting, quantizing.
- `app/midi.py`: MIDI file writer.
- `app/static/`: the browser UI (`app.js`, `audio.js`, `index.html`, `style.css`). No build step.
- `tools/learn_feel.py`: the feel learner.
- `app/.work/`: per-song cache (decoded audio, drum stem, saved sections). Safe to delete.

## Rules

- Never commit `config.json`, audio, MIDI, kit samples, the `feel/` folder, `exports/` or
  `app/.work/`. `.gitignore` already covers them; do not weaken it.
- The server binds to 127.0.0.1 and can open any audio file path on the machine. It is a
  single-user local tool. Do not expose it to a network or deploy it publicly as it is.
- Restart the server after changing any `.py` file. Browser files reload on refresh.
