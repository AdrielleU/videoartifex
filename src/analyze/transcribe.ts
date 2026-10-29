import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../ffmpeg.ts";
import { validateTranscript, type Transcript, type Word } from "../spec.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "transcribe.py");

export interface TranscribeOptions {
    /** Whisper model: tiny, base, small, medium, large-v3. Default base. */
    model?: string;
    language?: string;
}

function hasCommand(cmd: string, args: string[]): boolean {
    const r = spawnSync(cmd, args, { stdio: "ignore" });
    return !r.error && r.status === 0;
}

/**
 * Transcribes with faster-whisper. Uses a python3 that already has it (e.g.
 * the Docker image), otherwise `uv`, which installs it in an isolated cache on
 * first use.
 */
export async function transcribe(video: string, outFile: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    let cmd: string;
    let pre: string[];
    if (hasCommand("python3", ["-c", "import faster_whisper"])) {
        cmd = "python3";
        pre = [SCRIPT];
    } else if (hasCommand("uv", ["--version"])) {
        cmd = "uv";
        pre = ["run", "--quiet", "--no-project", "--with", "faster-whisper", "python", SCRIPT];
    } else {
        throw new Error(
            "Transcription needs faster-whisper. Install uv (https://docs.astral.sh/uv/) " +
            "or `pip install faster-whisper`, or pass an existing transcript with --transcript (JSON, SRT or VTT).",
        );
    }

    const dir = mkdtempSync(join(tmpdir(), "videoartifex-"));
    try {
        const wav = join(dir, "audio.wav");
        await run(["-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
        const args = [...pre, wav, outFile, "--model", opts.model ?? "base"];
        if (opts.language) args.push("--language", opts.language);
        await new Promise<void>((resolve, reject) => {
            const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
            p.on("error", reject);
            p.on("close", code => (code === 0 ? resolve() : reject(new Error(`transcription failed (exit ${code})`))));
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    return validateTranscript(JSON.parse(readFileSync(outFile, "utf8")));
}

/** Loads a transcript from our JSON format, SRT or WebVTT. */
export function loadTranscript(file: string): Transcript {
    const text = readFileSync(file, "utf8");
    const ext = extname(file).toLowerCase();
    if (ext === ".srt" || ext === ".vtt") return { words: subtitlesToWords(text) };
    return validateTranscript(JSON.parse(text));
}

function parseTimestamp(s: string): number {
    const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(s);
    if (!m) return NaN;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}

/**
 * Subtitle files only have per-cue timing, so words are spread across each
 * cue in proportion to their length. Good enough for captions; word
 * highlighting will be approximate.
 */
export function subtitlesToWords(text: string): Word[] {
    const words: Word[] = [];
    for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        const ti = lines.findIndex(l => l.includes("-->"));
        if (ti < 0) continue;
        const [a, b] = lines[ti]!.split("-->");
        const start = parseTimestamp(a ?? "");
        const end = parseTimestamp(b ?? "");
        if (!(end > start)) continue;
        const tokens = lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean);
        const total = tokens.reduce((n, t) => n + t.length, 0) || 1;
        let t = start;
        for (const tok of tokens) {
            const d = ((end - start) * tok.length) / total;
            words.push({ start: t, end: t + d, text: tok });
            t += d;
        }
    }
    return words;
}
