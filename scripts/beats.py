"""Beat tracking with librosa.

Usage: uv run --with librosa python beats.py AUDIO.wav OUT.json

Writes {"tempo": bpm, "beats": [{"t", "strength"}]} with times in seconds and
strength from 0 to 1 (how hard the onset at that beat hits, relative to the
loudest onset in the track). Quiet beats are often a break or the gap before a
drop, which makes them useful places to start or end a clip.
"""
import argparse
import json
import sys


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("out")
    args = p.parse_args()

    import wave

    import librosa
    import numpy as np

    # The caller hands us 22.05 kHz mono 16-bit WAV; reading it here keeps
    # librosa off its optional audio decoders.
    with wave.open(args.audio, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            sys.exit("expected mono 16-bit WAV")
        sr = w.getframerate()
        y = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0

    env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=sr)
    peak = float(env.max()) or 1.0
    beats = []
    for f in frames:
        # The onset can land a frame or two either side of the tracked beat.
        s = float(env[max(0, f - 2) : f + 3].max()) / peak
        beats.append({"t": round(float(librosa.frames_to_time(f, sr=sr)), 3), "strength": round(s, 3)})

    with open(args.out, "w") as fh:
        json.dump({"tempo": round(float(np.atleast_1d(tempo)[0]), 2), "beats": beats}, fh, indent=1)


if __name__ == "__main__":
    main()
