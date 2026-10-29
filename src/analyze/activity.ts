import { runRaw } from "../ffmpeg.ts";

/** A burst of on-screen change confined to part of the frame. */
export interface ActivityEvent {
    start: number;
    end: number;
    /** Bounding box of the change, fractions of the frame. */
    box: { x0: number; y0: number; x1: number; y1: number };
    /** Sum of per-cell change; bigger means more happened. */
    energy: number;
}

const W = 192;
const H = 108;
const CELL = 12; // 16 x 9 grid
const COLS = W / CELL;
const ROWS = H / CELL;
const SAMPLE_FPS = 5;

export interface ActivityOptions {
    /** Mean per-pixel change (0..255) for a cell to count as active. Default 6. */
    threshold?: number;
    /** Frames where more than this fraction of cells change are scene changes or scrolls, not activity. Default 0.35. */
    maxArea?: number;
}

/** Streams a 192x108 grayscale copy of the video and finds localized change. */
export async function detectActivity(file: string, opts: ActivityOptions = {}): Promise<ActivityEvent[]> {
    const frameSize = W * H;
    const frames: { t: number; cells: Float32Array }[] = [];
    let buf = Buffer.alloc(0);
    let prev: Buffer | null = null;
    let index = 0;

    await runRaw([
        "-i", file, "-an", "-sn",
        "-vf", `fps=${SAMPLE_FPS},scale=${W}:${H}:flags=area,format=gray`,
        "-f", "rawvideo", "pipe:1",
    ], chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= frameSize) {
            const frame = buf.subarray(0, frameSize);
            buf = buf.subarray(frameSize);
            if (prev) frames.push({ t: index / SAMPLE_FPS, cells: cellDiff(prev, frame) });
            prev = Buffer.from(frame);
            index++;
        }
    });

    return findEvents(frames, opts);
}

function cellDiff(a: Buffer, b: Buffer): Float32Array {
    const cells = new Float32Array(COLS * ROWS);
    for (let y = 0; y < H; y++) {
        const row = Math.floor(y / CELL) * COLS;
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            cells[row + Math.floor(x / CELL)]! += Math.abs(a[i]! - b[i]!);
        }
    }
    for (let i = 0; i < cells.length; i++) cells[i]! /= CELL * CELL;
    return cells;
}

export function findEvents(frames: { t: number; cells: Float32Array }[], opts: ActivityOptions = {}): ActivityEvent[] {
    const threshold = opts.threshold ?? 6;
    const maxArea = opts.maxArea ?? 0.35;
    const events: ActivityEvent[] = [];
    let cur: ActivityEvent | null = null;

    for (const { t, cells } of frames) {
        let count = 0;
        let energy = 0;
        let x0 = COLS, y0 = ROWS, x1 = -1, y1 = -1;
        cells.forEach((v, i) => {
            if (v < threshold) return;
            count++;
            energy += v;
            const cx = i % COLS;
            const cy = Math.floor(i / COLS);
            x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
            y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
        });
        const local = count > 0 && count / cells.length <= maxArea;
        const t0 = t - 1 / SAMPLE_FPS;

        if (local) {
            const box = { x0: x0 / COLS, y0: y0 / ROWS, x1: (x1 + 1) / COLS, y1: (y1 + 1) / ROWS };
            if (cur && t0 - cur.end <= 1.0) {
                cur.end = t;
                cur.energy += energy;
                cur.box = {
                    x0: Math.min(cur.box.x0, box.x0), y0: Math.min(cur.box.y0, box.y0),
                    x1: Math.max(cur.box.x1, box.x1), y1: Math.max(cur.box.y1, box.y1),
                };
            } else {
                if (cur) events.push(cur);
                cur = { start: t0, end: t, box, energy };
            }
        } else if (count > 0 && cur) {
            // A full-screen change ends the current event (new page, scroll).
            events.push(cur);
            cur = null;
        }
    }
    if (cur) events.push(cur);
    return events.map(e => ({ ...e, start: Math.max(0, e.start), energy: Math.round(e.energy) }));
}
