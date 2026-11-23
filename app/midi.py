"""Write one looping drum section as a format-0 MIDI file on channel 10."""
import struct

from analysis import METERS

PPQ = 480
SIGNATURE = {"4/4": (4, 2, 24), "3/4": (3, 2, 24), "6/8": (6, 3, 36)}


def _varlen(value):
    packed = [value & 0x7F]
    value >>= 7
    while value:
        packed.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(packed))


def build(notes, grid, name="groove"):
    """notes: [{beat, p, v}] with beat counted from the loop start in grid beats."""
    m = METERS[grid["meter"]]
    ticks = m["ticks"]
    total = grid["bars"] * m["beats"] * ticks
    quarter_bpm = grid["bpm"] * ticks / PPQ
    uspq = int(round(60_000_000 / quarter_bpm))
    num, den, clocks = SIGNATURE[grid["meter"]]

    placed = {}
    for n in notes:
        tick = max(0, min(total - 1, int(round(n["beat"] * ticks))))
        vel = max(1, min(127, int(n["v"])))
        key = (tick, int(n["p"]))
        placed[key] = max(vel, placed.get(key, 0))
    events = []
    for (tick, pitch), vel in placed.items():
        events.append((tick, 1, bytes((0x99, pitch, vel))))
        events.append((min(total, tick + 60), 0, bytes((0x89, pitch, 0))))
    events.sort()

    label = name.encode("ascii", "ignore")[:120]
    buf = bytearray()
    buf += _varlen(0) + bytes((0xFF, 0x03, len(label))) + label
    buf += _varlen(0) + bytes((0xFF, 0x51, 0x03)) + uspq.to_bytes(3, "big")
    buf += _varlen(0) + bytes((0xFF, 0x58, 0x04, num, den, clocks, 8))
    last = 0
    for tick, _order, data in events:
        buf += _varlen(tick - last) + data
        last = tick
    # End of track sits exactly on the last bar line, so the file loops on the bar.
    buf += _varlen(total - last) + bytes((0xFF, 0x2F, 0x00))
    return b"MThd" + struct.pack(">IHHH", 6, 0, 1, PPQ) + b"MTrk" + struct.pack(">I", len(buf)) + bytes(buf)
