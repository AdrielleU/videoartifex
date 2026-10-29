import type { Range } from "./spec.ts";

/** A kept source range and where it lands on the output timeline. */
export interface Segment {
    start: number;
    end: number;
    outStart: number;
}

/**
 * Builds the output timeline from `keep` ranges. Boundaries snap to the
 * output frame grid so every segment is a whole number of frames; audio is cut
 * on the same grid, which keeps sound and picture in sync however many cuts
 * there are.
 */
export function buildTimeline(keep: Range[] | undefined, duration: number, fps: number): Segment[] {
    const snap = (t: number) => Math.round(t * fps) / fps;
    const ranges = keep ?? [{ start: 0, end: duration }];
    const segments: Segment[] = [];
    let out = 0;
    for (const r of ranges) {
        const start = snap(Math.max(0, r.start));
        const end = snap(Math.min(duration, r.end));
        if (end - start < 1 / fps) continue;
        const prev = segments[segments.length - 1];
        if (prev && start <= prev.end) {
            // Touching ranges merge into one segment.
            out += end - prev.end;
            prev.end = end;
            continue;
        }
        segments.push({ start, end, outStart: out });
        out += end - start;
    }
    return segments;
}

export function outputDuration(segments: Segment[]): number {
    const last = segments[segments.length - 1];
    return last ? last.outStart + (last.end - last.start) : 0;
}

/** Output time of a source time, or null if that moment was cut. */
export function toOutput(segments: Segment[], t: number): number | null {
    for (const s of segments) {
        if (t >= s.start && t < s.end) return s.outStart + (t - s.start);
    }
    return null;
}

/**
 * Maps a source range onto the output timeline. Pieces that end up adjacent
 * (because only a cut separated them) are merged, so a zoom spanning a
 * removed pause stays one continuous zoom.
 */
export function rangeToOutput(segments: Segment[], r: Range): Range[] {
    const pieces: Range[] = [];
    for (const s of segments) {
        const start = Math.max(r.start, s.start);
        const end = Math.min(r.end, s.end);
        if (end <= start) continue;
        const piece = { start: s.outStart + (start - s.start), end: s.outStart + (end - s.start) };
        const prev = pieces[pieces.length - 1];
        if (prev && Math.abs(prev.end - piece.start) < 1e-6) prev.end = piece.end;
        else pieces.push(piece);
    }
    return pieces;
}

/** ffmpeg expression that is true for source times inside a kept segment. */
export function selectExpr(segments: Segment[], fps: number): string {
    // Half a frame of slack keeps float timestamps on the right side of each edge.
    const eps = 0.5 / fps;
    return segments.map(s => `between(t,${(s.start - eps).toFixed(4)},${(s.end - eps).toFixed(4)})`).join("+");
}
