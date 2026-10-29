import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { probe } from "../ffmpeg.ts";
import type { Analysis } from "../plan.ts";
import { detectActivity } from "./activity.ts";
import { detectSilences } from "./silence.ts";
import { loadTranscript, transcribe, type TranscribeOptions } from "./transcribe.ts";

export interface AnalyzeOptions extends TranscribeOptions {
    /** Skip transcription. */
    noTranscript?: boolean;
    /** Use this transcript (JSON, SRT or VTT) instead of transcribing. */
    transcript?: string;
    /** Re-transcribe even if `<name>.transcript.json` exists. */
    force?: boolean;
    noiseDb?: number;
    log?: (msg: string) => void;
}

export function sidecar(video: string, suffix: string): string {
    const v = resolve(video);
    return join(dirname(v), `${basename(v, extname(v))}.${suffix}`);
}

/** Probes, finds silences and activity, transcribes, and writes `<name>.analysis.json`. */
export async function analyze(video: string, opts: AnalyzeOptions = {}): Promise<{ file: string; analysis: Analysis }> {
    const log = opts.log ?? (() => { });
    const input = resolve(video);
    const out = sidecar(input, "analysis.json");
    const dir = dirname(out);

    const media = probe(input);
    log(`${basename(input)}: ${media.width}x${media.height}, ${media.fps.toFixed(2)} fps, ${media.duration.toFixed(1)} s${media.hasAudio ? "" : ", no audio"}`);

    const silencesP = media.hasAudio
        ? detectSilences(input, media.duration, { noiseDb: opts.noiseDb })
        : Promise.resolve([]);
    const activityP = detectActivity(input);
    const [silences, activity] = await Promise.all([silencesP, activityP]);
    log(`silences: ${silences.length} (${silences.reduce((n, s) => n + s.end - s.start, 0).toFixed(1)} s), activity events: ${activity.length}`);

    let transcript: string | undefined;
    if (opts.transcript) {
        const src = resolve(opts.transcript);
        const words = loadTranscript(src).words;
        // Normalize SRT/VTT into our JSON so the edit file always points at one format.
        const target = sidecar(input, "transcript.json");
        if (src !== target) writeFileSync(target, JSON.stringify({ words }, null, 1));
        transcript = relative(dir, target);
        log(`transcript: ${words.length} words from ${basename(src)}`);
    } else if (!opts.noTranscript && media.hasAudio) {
        const target = sidecar(input, "transcript.json");
        if (existsSync(target) && !opts.force) {
            log(`transcript: reusing ${basename(target)}`);
        } else {
            log(`transcribing with whisper (${opts.model ?? "base"})...`);
            const t = await transcribe(input, target, opts);
            log(`transcript: ${t.words.length} words`);
        }
        transcript = relative(dir, target);
    }

    const analysis: Analysis = {
        version: 1,
        input: relative(dir, input),
        media,
        silences: silences.map(s => ({ start: r3(s.start), end: r3(s.end) })),
        activity: activity.map(a => ({
            ...a,
            start: r3(a.start),
            end: r3(a.end),
            box: { x0: r3(a.box.x0), y0: r3(a.box.y0), x1: r3(a.box.x1), y1: r3(a.box.y1) },
        })),
        ...(transcript ? { transcript } : {}),
    };
    writeFileSync(out, JSON.stringify(analysis, null, 1));
    return { file: out, analysis };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
