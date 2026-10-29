import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sidecar } from "./analyze/index.ts";
import { probe, run } from "./ffmpeg.ts";
import { pickFps, render } from "./render.ts";
import { SpecError, validateSequence, type EditSpec, type SequenceSpec } from "./spec.ts";

export interface SequenceRenderOptions {
    preview?: boolean;
    output?: string;
    onProgress?: (fraction: number) => void;
}

export interface SequenceRenderResult {
    output: string;
    duration: number;
    items: number;
    seconds: number;
}

export function loadSequence(file: string): SequenceSpec {
    let data: unknown;
    try {
        data = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        throw new SpecError(`${file}: ${(e as Error).message}`);
    }
    return validateSequence(data);
}

/** `tutorial.sequence.json` -> `tutorial`. */
export function sequenceStem(file: string): string {
    return basename(file).replace(/\.sequence\.json$/, "").replace(/\.json$/, "");
}

export function sequenceOutputPath(file: string, preview: boolean): string {
    return join(dirname(resolve(file)), `${sequenceStem(file)}.${preview ? "preview" : "edited"}.mp4`);
}

/** The edit file for one item, with absolute paths so it renders from anywhere. */
export function itemEdit(seq: SequenceSpec, index: number, base: string, size: { width: number; height: number; fps: number }): EditSpec {
    const item = seq.items[index]!;
    const input = resolve(base, item.input);
    const transcript = sidecar(input, "transcript.json");
    return {
        version: 1,
        input,
        ...(item.keep ? { keep: item.keep } : {}),
        ...(item.zooms ? { zooms: item.zooms } : {}),
        captions: seq.captions && existsSync(transcript) ? { ...seq.captions, transcript } : false,
        output: { ...size, ...(seq.output?.crf ? { crf: seq.output.crf } : {}) },
    };
}

/**
 * Renders each item on its own (same size, frame rate and audio format),
 * then joins them. Video is copied at the join; audio stays PCM until the
 * end and is encoded once, so there are no gaps between items.
 */
export async function renderSequence(file: string, opts: SequenceRenderOptions = {}): Promise<SequenceRenderResult> {
    const began = Date.now();
    const seq = loadSequence(file);
    const base = dirname(resolve(file));
    const preview = !!opts.preview;
    const output = resolve(opts.output ?? (seq.output?.path && !preview ? resolve(base, seq.output.path) : sequenceOutputPath(file, preview)));
    const inputs = seq.items.map(i => resolve(base, i.input));
    if (inputs.includes(output)) throw new SpecError("output would overwrite one of the inputs");
    for (const i of inputs) if (!existsSync(i)) throw new SpecError(`${i} not found`);

    // Every item renders at the first item's size unless the sequence sets one.
    const first = probe(inputs[0]!);
    const size = {
        width: seq.output?.width ?? first.width,
        height: seq.output?.height ?? first.height,
        fps: pickFps(seq.output?.fps, first.fps, preview),
    };

    const tmp = mkdtempSync(join(tmpdir(), "videoartifex-seq-"));
    try {
        const parts: string[] = [];
        let duration = 0;
        for (let i = 0; i < seq.items.length; i++) {
            const editFile = join(tmp, `${i}.edit.json`);
            writeFileSync(editFile, JSON.stringify(itemEdit(seq, i, base, size)));
            const part = join(tmp, `${i}.mkv`);
            const r = await render(editFile, {
                preview,
                output: part,
                intermediate: true,
                onProgress: f => opts.onProgress?.((i + f) / (seq.items.length + 0.2)),
            });
            parts.push(part);
            duration += r.duration;
        }

        const list = join(tmp, "parts.txt");
        writeFileSync(list, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
        await run([
            "-y", "-f", "concat", "-safe", "0", "-i", list,
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", output,
        ], { duration, onProgress: f => opts.onProgress?.((seq.items.length + f * 0.2) / (seq.items.length + 0.2)) });

        return { output, duration, items: seq.items.length, seconds: (Date.now() - began) / 1000 };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
