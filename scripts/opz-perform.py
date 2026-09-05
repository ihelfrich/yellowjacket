#!/usr/bin/env -S uv run --no-project --with sounddevice --with numpy --with python-rtmidi python
"""Play a timed MIDI event list into the OP-Z over USB while recording its
USB audio. The events come from js/compose/cyclic-score.js (scoreEvents):

    [{"t": 0.0, "kind": "on", "channel": 5, "note": 81, "value": 96}, ...]
    kinds: on | off | ccrel (relative CC: delta steps, 1 = up, 127 = down) | cc

Usage:
    python scripts/opz-perform.py events.json --out take.wav [--lead 1.0]

Nothing is written to the device. Relative CCs from the composer sum to zero
per section, and this script sends any residual back at the end so every
parameter finishes where it started; all notes are released at the end.
"""
import argparse, json, sys, time, wave
import numpy as np, sounddevice as sd, rtmidi

ap = argparse.ArgumentParser()
ap.add_argument('events'); ap.add_argument('--out', required=True)
ap.add_argument('--lead', type=float, default=1.0, help='seconds of silence recorded before t=0')
ap.add_argument('--tail', type=float, default=1.5); ap.add_argument('--rate', type=int, default=44100)
ap.add_argument('--dry', action='store_true', help='schedule but send nothing')
a = ap.parse_args()

events = json.load(open(a.events))
events.sort(key=lambda e: (e['t'], {'off': 0, 'ccrel': 1, 'cc': 1, 'on': 2}[e['kind']]))
length = max(e['t'] for e in events) if events else 0.0
print(f'{len(events)} events over {length:.1f} s; lead {a.lead} s, tail {a.tail} s', file=sys.stderr)

dev = next(i for i, d in enumerate(sd.query_devices()) if d['name'] == 'OP-Z' and d['max_input_channels'] > 0)
out = rtmidi.MidiOut(); out.open_port(next(i for i, n in enumerate(out.get_ports()) if 'OP-Z' in n))
send = (lambda m: None) if a.dry else out.send_message

chunks = []
def on_audio(indata, frames, t, status):
    if status: print('audio:', status, file=sys.stderr)
    chunks.append(indata.copy())

residual = {}
late = []
with sd.InputStream(samplerate=a.rate, channels=2, dtype='float32', device=dev, callback=on_audio):
    t0 = time.perf_counter() + a.lead
    for e in events:
        due = t0 + e['t']
        while True:
            now = time.perf_counter()
            if now >= due: break
            if due - now > 0.002: time.sleep(due - now - 0.0015)
        late.append(time.perf_counter() - due)
        ch = e['channel'] & 0x0f
        if e['kind'] == 'on': send([0x90 | ch, e['note'] & 0x7f, max(1, min(127, int(e['value'])))])
        elif e['kind'] == 'off': send([0x80 | ch, e['note'] & 0x7f, 0])
        elif e['kind'] == 'cc': send([0xB0 | ch, e['cc'] & 0x7f, max(0, min(127, int(e['value'])))])
        elif e['kind'] == 'ccrel':
            d = int(e['delta']); key = (ch, e['cc'])
            residual[key] = residual.get(key, 0) + d
            for _ in range(abs(d)): send([0xB0 | ch, e['cc'] & 0x7f, 1 if d > 0 else 127])
    # return every relative parameter to its origin, release everything
    for (ch, cc), d in residual.items():
        for _ in range(abs(d)): send([0xB0 | ch, cc & 0x7f, 127 if d > 0 else 1])
    for ch in range(16): send([0xB0 | ch, 123, 0])
    time.sleep(a.tail)
out.close_port()

audio = np.concatenate(chunks) if chunks else np.zeros((0, 2), 'float32')
with wave.open(a.out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(a.rate)
    w.writeframes((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes())
mono = audio.mean(axis=1) if len(audio) else np.zeros(1, 'float32')
late = np.array(late) * 1000 if late else np.zeros(1)
print(json.dumps({
    'out': a.out, 'seconds': len(audio) / a.rate, 'lead': a.lead,
    'peak': float(np.abs(mono).max()), 'rms': float(np.sqrt((mono ** 2).mean())),
    'lateness_ms': {'median': float(np.median(late)), 'p95': float(np.percentile(late, 95)), 'max': float(late.max())},
    'residual_after_return': {f'{ch + 1}:{cc}': 0 for (ch, cc) in residual},
}))
