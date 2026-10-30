import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../ffmpeg.ts";
import { runPython } from "../python.ts";

export interface Beat {
    t: number;
    /** 0..1, how hard the onset at this beat hits relative to the loudest in the track. */
    strength: number;
}

/** `<name>.beats.json` */
export interface Beats {
    tempo: number;
    beats: Beat[];
}

export function validateBeats(data: unknown): Beats {
    const b = data as Beats;
    if (!b || typeof b.tempo !== "number" || !Array.isArray(b.beats) || b.beats.some(x => typeof x?.t !== "number" || typeof x.strength !== "number"))
        throw new Error("not a beats file: expected {tempo, beats: [{t, strength}]}");
    return b;
}

/** Tracks beats with librosa and writes them to `outFile`. */
export async function detectBeats(video: string, outFile: string): Promise<Beats> {
    const dir = mkdtempSync(join(tmpdir(), "videoartifex-"));
    try {
        const wav = join(dir, "audio.wav");
        await run(["-y", "-i", video, "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", wav]);
        await runPython("librosa", "beats.py", [wav, outFile],
            "Beat detection needs librosa. Install uv (https://docs.astral.sh/uv/) or `pip install librosa`.");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    return validateBeats(JSON.parse(readFileSync(outFile, "utf8")));
}

/** The beat time nearest to `t`, or `t` itself when there are no beats. */
export function snapToBeat(beats: Beats, t: number): number {
    let best: number | undefined;
    for (const b of beats.beats) if (best === undefined || Math.abs(b.t - t) < Math.abs(best - t)) best = b.t;
    return best ?? t;
}
