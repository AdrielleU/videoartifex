import type { ActivityEvent } from "./analyze/activity.ts";
import { keepFromSilences, type CutOptions } from "./analyze/silence.ts";
import type { MediaInfo } from "./ffmpeg.ts";
import type { EditSpec, Range, Zoom } from "./spec.ts";

/** Output of `vidartifax analyze`, saved next to the video. */
export interface Analysis {
    version: 1;
    input: string;
    media: MediaInfo;
    silences: Range[];
    activity: ActivityEvent[];
    /** Transcript JSON, relative to the analysis file. */
    transcript?: string;
}

export interface PlanOptions extends CutOptions {
    cutSilences?: boolean;
    zooms?: boolean;
    captions?: boolean;
    /** Upper bound on zoom magnification. Default 2.2. */
    maxScale?: number;
}

/** Seconds of a range that survive the cuts. */
function keptSeconds(r: Range, keep: Range[] | undefined): number {
    if (!keep) return r.end - r.start;
    return keep.reduce((n, k) => n + Math.max(0, Math.min(r.end, k.end) - Math.max(r.start, k.start)), 0);
}

/**
 * Auto-zoom heuristics for screen recordings. With `keep`, zooms that would
 * mostly land in cut footage are skipped, so they aren't wasted on pauses.
 */
export function zoomsFromActivity(events: ActivityEvent[], duration: number, maxScale = 2.2, keep?: Range[]): Zoom[] {
    const candidates: { zoom: Zoom; energy: number }[] = [];
    for (const e of events) {
        const bw = e.box.x1 - e.box.x0;
        const bh = e.box.y1 - e.box.y0;
        // Leave margin around the changed area; skip changes too big to be worth zooming.
        const scale = Math.min(maxScale, 0.7 / Math.max(bw, bh));
        if (scale < 1.3 || e.energy < 40) continue;
        const start = Math.max(0, e.start - 0.4);
        const end = Math.min(duration, Math.max(e.end + 1.2, start + 2.2));
        if (keptSeconds({ start, end }, keep) < 1.2) continue;
        candidates.push({
            energy: e.energy,
            zoom: {
                start: round(start),
                end: round(end),
                x: round((e.box.x0 + e.box.x1) / 2, 3),
                y: round((e.box.y0 + e.box.y1) / 2, 3),
                scale: round(scale, 2),
            },
        });
    }

    // Keep the most active events first, with breathing room between zooms.
    candidates.sort((a, b) => b.energy - a.energy);
    const chosen: Zoom[] = [];
    for (const { zoom } of candidates) {
        if (chosen.some(z => zoom.start < z.end + 1.0 && z.start < zoom.end + 1.0)) continue;
        chosen.push(zoom);
    }
    return chosen.sort((a, b) => a.start - b.start);
}

export function plan(analysis: Analysis, opts: PlanOptions = {}): EditSpec {
    const { duration } = analysis.media;
    const spec: EditSpec = { version: 1, input: analysis.input };
    if (opts.cutSilences !== false && analysis.silences.length) {
        spec.keep = keepFromSilences(analysis.silences, duration, opts).map(r => ({ start: round(r.start), end: round(r.end) }));
    }
    if (opts.zooms !== false) {
        const zooms = zoomsFromActivity(analysis.activity, duration, opts.maxScale, spec.keep);
        if (zooms.length) spec.zooms = zooms;
    }
    if (opts.captions !== false && analysis.transcript) {
        spec.captions = { transcript: analysis.transcript };
    }
    return spec;
}

function round(v: number, digits = 2): number {
    const f = 10 ** digits;
    return Math.round(v * f) / f;
}
