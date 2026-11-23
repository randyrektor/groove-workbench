#!/bin/sh
# Start the groove workbench, then open http://127.0.0.1:5177
# First run creates app/.venv and installs the Python packages (about 1 GB on a Mac, mostly PyTorch).
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not installed. macOS: brew install ffmpeg   Debian/Ubuntu: sudo apt install ffmpeg" >&2; exit 1; }
# .venv/.installed is written only after every package went in, so a failed install is retried.
if [ ! -f .venv/.installed ]; then
  PY=""
  for c in python3.12 python3.13 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info[:2] < (3, 11))' 2>/dev/null; then PY="$c"; break; fi
  done
  [ -n "$PY" ] || { echo "Python 3.11 or newer is needed, and this machine has $(python3 --version 2>&1 || echo none). macOS: brew install python@3.12   Debian/Ubuntu: sudo apt install python3.12 python3.12-venv" >&2; exit 1; }
  echo "First run: installing Python packages into app/.venv with $("$PY" --version)."
  echo "This downloads about 1 GB (several GB on Linux with an NVIDIA card) and takes a few minutes."
  rm -rf .venv
  "$PY" -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -r requirements.txt && touch .venv/.installed \
    || { echo "The install did not finish. Fix the error above and run app/run.sh again." >&2; exit 1; }
fi
exec .venv/bin/python server.py
