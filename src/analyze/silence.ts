import { run } from "../ffmpeg.ts";
import type { Range } from "../spec.ts";

export interface SilenceOptions {
    /** Level below which audio counts as silent, in dB. Default -35. */
    noiseDb?: number;
    /** Shortest silence to report, seconds. Default 0.4. */
    minDuration?: number;
}

/** Silent ranges of the audio track, via ffmpeg's silencedetect. */
export async function detectSilences(file: string, duration: number, opts: SilenceOptions = {}): Promise<Range[]> {
    const noise = opts.noiseDb ?? -35;
    const d = opts.minDuration ?? 0.4;
    const log = await run(["-i", file, "-vn", "-sn", "-af", `silencedetect=noise=${noise}dB:d=${d}`, "-f", "null", "-"]);
    return parseSilences(log, duration);
}

export function parseSilences(log: string, duration: number): Range[] {
    const out: Range[] = [];
    let start: number | null = null;
    for (const line of log.split("\n")) {
        const s = /silence_start: (-?[\d.]+)/.exec(line);
        if (s) start = Math.max(0, Number(s[1]));
        const e = /silence_end: ([\d.]+)/.exec(line);
        if (e && start !== null) {
            out.push({ start, end: Number(e[1]) });
            start = null;
        }
    }
    // A silence still open at EOF runs to the end.
    if (start !== null && duration - start > 0) out.push({ start, end: duration });
    return out;
}

export interface CutOptions {
    /** Only silences at least this long are cut. Default 0.6 s. */
    minSilence?: number;
    /** Silence left on each side of a cut so speech isn't clipped. Default 0.15 s. */
    pad?: number;
    /** Kept pieces shorter than this are dropped (breaths, clicks). Default 0.25 s. */
    minKeep?: number;
}

/** Turns silences into the ranges to keep. */
export function keepFromSilences(silences: Range[], duration: number, opts: CutOptions = {}): Range[] {
    const minSilence = opts.minSilence ?? 0.6;
    const pad = opts.pad ?? 0.15;
    const minKeep = opts.minKeep ?? 0.25;

    const cuts: Range[] = [];
    for (const s of silences) {
        if (s.end - s.start < minSilence) continue;
        const start = s.start <= 0.01 ? 0 : s.start + pad;
        const end = s.end >= duration - 0.01 ? duration : s.end - pad;
        if (end - start > 0.05) cuts.push({ start, end });
    }

    const keep: Range[] = [];
    let cursor = 0;
    for (const c of cuts) {
        if (c.start - cursor >= minKeep) keep.push({ start: cursor, end: c.start });
        cursor = Math.max(cursor, c.end);
    }
    if (duration - cursor >= minKeep) keep.push({ start: cursor, end: duration });
    return keep.length ? keep : [{ start: 0, end: duration }];
}
