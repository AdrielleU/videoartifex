"""Word-level transcription with faster-whisper.

Usage: uv run --with faster-whisper python transcribe.py AUDIO OUT.json [--model base] [--language en]

Writes {"language": "...", "words": [{"start", "end", "text"}]} with times in seconds.
"""
import argparse
import json
import sys


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("out")
    p.add_argument("--model", default="base")
    p.add_argument("--language", default=None)
    p.add_argument("--device", default="auto")
    args = p.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type="int8")
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()})
        print(f"\r{seg.end:.0f}s transcribed", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "words": words}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
