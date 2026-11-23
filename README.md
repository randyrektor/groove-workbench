# Groove Workbench

Turn a section of a song into a short, loopable MIDI drum pattern for a drum pedal such as
the BeatBuddy.

Drop in a song, mark a section, and the app separates the drums, finds the tempo and bar
lines, and reads the kick, snare and hats into a drum-grid editor that sits on the same time
axis as the audio. Fix what is wrong, humanize it, and export `.mid` files, including
stripped-down layers (kick only, kick and rim, and so on) cut from the same groove.

It runs entirely on your own computer. You bring your own songs, and optionally your own drum
samples and MIDI groove library. None of that is included here.

## Install

The easy way: open this folder in a coding agent (Claude Code, Cursor, Codex) and say
"set this up for me". `AGENTS.md` tells it what to ask you and what to do.

By hand:

1. Install [ffmpeg](https://ffmpeg.org) and Python 3.11 or newer
   (on a Mac: `brew install ffmpeg python@3.12`).
2. Run `app/run.sh` and open `http://127.0.0.1:5177`.
3. Pick your song folder with Browse, or drop a song onto the page. Folders, drum samples and
   defaults for new grooves are under Settings.

The first run downloads about 1 GB of Python packages (several GB on Linux with an NVIDIA
card) and takes a few minutes. The first song you open downloads the drum-separation model,
about 80 MB, from Hugging Face. After that a song takes well under a minute to separate on an
Apple Silicon Mac, and nothing leaves your computer.

Settings are kept in `config.json`, which the app writes for you. `config.example.json` shows
what can go in it.

To humanize with the feel of MIDI grooves you own:

```
python3 tools/learn_feel.py "/path/to/your/midi grooves"
```

Developed and tested on macOS (Apple Silicon) with Python 3.12. Linux should work but is
untested. Windows has no launcher yet; use WSL. Intel Macs cannot install the pinned PyTorch.

## License

MIT. See `LICENSE`.
