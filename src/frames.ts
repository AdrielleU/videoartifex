import { mkdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { run } from "./ffmpeg.ts";

export interface FramesOptions {
    /** Source times in seconds. */
    at: number[];
    /** Overlay a 10x10 grid so focus points can be read off as fractions. */
    grid?: boolean;
    outDir?: string;
    /** Snapshot width in pixels. Default 1280. */
    width?: number;
}

/** Saves PNG snapshots so Claude (or you) can see where to zoom. */
export async function snapshot(video: string, opts: FramesOptions): Promise<string[]> {
    const input = resolve(video);
    const dir = resolve(opts.outDir ?? join(input, "..", `${basename(input, extname(input))}.frames`));
    mkdirSync(dir, { recursive: true });
    const filters = [`scale=${opts.width ?? 1280}:-2`];
    if (opts.grid) filters.push("drawgrid=w=iw/10:h=ih/10:t=2:c=red@0.55");

    const files: string[] = [];
    for (const t of opts.at) {
        const file = join(dir, `t${t.toFixed(2).replace(".", "_")}.png`);
        await run(["-y", "-v", "error", "-ss", String(t), "-i", input, "-frames:v", "1", "-vf", filters.join(","), file]);
        files.push(file);
    }
    return files;
}
