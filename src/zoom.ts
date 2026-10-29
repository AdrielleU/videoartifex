import type { Zoom } from "./spec.ts";
import { rangeToOutput, type Segment } from "./timeline.ts";

export const DEFAULT_EASE = 0.4;

/** A zoom placed on the output timeline. */
export interface OutputZoom {
    start: number;
    end: number;
    x: number;
    y: number;
    scale: number;
    ease: number;
}

/** Maps source-time zooms onto the output timeline, dropping cut parts. */
export function zoomsToOutput(zooms: Zoom[], segments: Segment[]): OutputZoom[] {
    const out: OutputZoom[] = [];
    for (const z of zooms) {
        for (const r of rangeToOutput(segments, z)) {
            if (r.end - r.start < 0.2) continue;
            out.push({ ...r, x: z.x, y: z.y, scale: z.scale, ease: z.ease ?? DEFAULT_EASE });
        }
    }
    return out.sort((a, b) => a.start - b.start);
}

const n = (v: number) => Number(v.toFixed(4)).toString();

/**
 * Zoom amount 0..1 for one zoom: eases in over `ease` seconds, holds, eases
 * out, using smoothstep. Register 9 holds the output time.
 */
function envelope(z: OutputZoom): string {
    const e = Math.max(0.01, Math.min(z.ease, (z.end - z.start) / 2));
    const u = `clip(min(ld(9)-${n(z.start)},${n(z.end)}-ld(9))/${n(e)},0,1)`;
    // `;` sequences the store before the loads; operand order of `*` is unspecified.
    return `between(ld(9),${n(z.start)},${n(z.end)})*(st(8,${u});ld(8)*ld(8)*(3-2*ld(8)))`;
}

/**
 * Builds a `perspective` filter that crops a moving sub-pixel rectangle and
 * stretches it to the full frame. Unlike `zoompan` (integer crop offsets),
 * this stays smooth during slow zooms. `in` is the output frame number, so
 * the filter must come after the frame-rate is fixed at `fps`.
 */
export function zoomFilter(zooms: OutputZoom[], fps: number): string | null {
    if (zooms.length === 0) return null;
    const scale = zooms.map(z => `${n(z.scale - 1)}*(${envelope(z)})`).join("+");
    // Focus only matters while a zoom is active; at scale 1 the crop clamps to the full frame.
    const fx = zooms.map(z => `${n(z.x)}*between(ld(9),${n(z.start)},${n(z.end)})`).join("+");
    const fy = zooms.map(z => `${n(z.y)}*between(ld(9),${n(z.start)},${n(z.end)})`).join("+");

    // Registers: 9 time, 0 zoom factor, 1 left, 2 top, 3 crop width, 4 crop height.
    const pre = [
        `st(9,in/${fps})`,
        `st(0,1+${scale})`,
        `st(3,W/ld(0))`,
        `st(4,H/ld(0))`,
        `st(1,clip((${fx})*W-ld(3)/2,0,W-ld(3)))`,
        `st(2,clip((${fy})*H-ld(4)/2,0,H-ld(4)))`,
    ].join(";");
    const corner = (x: string, y: string) => [`${pre};${x}`, `${pre};${y}`];
    const [x0, y0] = corner("ld(1)", "ld(2)");
    const [x1, y1] = corner("ld(1)+ld(3)", "ld(2)");
    const [x2, y2] = corner("ld(1)", "ld(2)+ld(4)");
    const [x3, y3] = corner("ld(1)+ld(3)", "ld(2)+ld(4)");
    const q = (s: string | undefined) => `'${s}'`;
    return `perspective=x0=${q(x0)}:y0=${q(y0)}:x1=${q(x1)}:y1=${q(y1)}:x2=${q(x2)}:y2=${q(y2)}:x3=${q(x3)}:y3=${q(y3)}:interpolation=linear:sense=source:eval=frame`;
}

/** Plain-JS version of the zoom curve, for tests and previews. */
export function zoomAt(zooms: OutputZoom[], t: number): { scale: number; left: number; top: number } {
    let scale = 1;
    let fx = 0;
    let fy = 0;
    for (const z of zooms) {
        if (t < z.start || t > z.end) continue;
        const e = Math.max(0.01, Math.min(z.ease, (z.end - z.start) / 2));
        const u = Math.min(1, Math.max(0, Math.min(t - z.start, z.end - t) / e));
        scale += (z.scale - 1) * u * u * (3 - 2 * u);
        fx += z.x;
        fy += z.y;
    }
    const w = 1 / scale;
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
    return { scale, left: clamp(fx - w / 2, 1 - w), top: clamp(fy - w / 2, 1 - w) };
}
