import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { buildAss, groupCues, wordsToOutput } from "./captions.ts";
import { loadTranscript } from "./analyze/transcribe.ts";
import { checkFfmpeg, ffmpegMajor, probe, run } from "./ffmpeg.ts";
import { SpecError, validateSpec, type EditSpec } from "./spec.ts";
import { buildTimeline, outputDuration, selectExpr, type Segment } from "./timeline.ts";
import { zoomFilter, zoomsToOutput } from "./zoom.ts";

const AUDIO_RATE = 48000;

export interface RenderOptions {
    /** Fast 540p draft for checking an edit. */
    preview?: boolean;
    output?: string;
    onProgress?: (fraction: number) => void;
}

export interface RenderResult {
    output: string;
    duration: number;
    sourceDuration: number;
    /** Seconds removed by cuts. */
    removed: number;
    zooms: number;
    captions: number;
    seconds: number;
}

export function loadSpec(file: string): EditSpec {
    let data: unknown;
    try {
        data = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        throw new SpecError(`${file}: ${(e as Error).message}`);
    }
    return validateSpec(data);
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Frame rate that divides 48 kHz evenly, so audio cuts land exactly on frame edges. */
export function pickFps(requested: number | undefined, source: number, preview: boolean): number {
    if (requested !== undefined) {
        if (AUDIO_RATE % requested !== 0) throw new SpecError(`output.fps ${requested} isn't supported; use 24, 25, 30, 50 or 60`);
        return requested;
    }
    const fps = [24, 25, 30, 50, 60].reduce((best, f) => (Math.abs(f - source) < Math.abs(best - source) ? f : best), 30);
    return preview ? Math.min(fps, 30) : fps;
}

export function defaultOutputPath(input: string, preview: boolean): string {
    const ext = extname(input);
    return join(dirname(input), `${basename(input, ext)}.${preview ? "preview" : "edited"}.mp4`);
}

export async function render(specFile: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const began = Date.now();
    const spec = loadSpec(specFile);
    const base = dirname(resolve(specFile));
    const input = resolve(base, spec.input);
    const preview = !!opts.preview;
    const output = resolve(opts.output ?? (spec.output?.path && !preview ? resolve(base, spec.output.path) : defaultOutputPath(input, preview)));
    if (output === input) throw new SpecError("output would overwrite the input video");

    const { version } = checkFfmpeg();
    const media = probe(input);
    const fps = pickFps(spec.output?.fps, media.fps, preview);
    const segments = buildTimeline(spec.keep, media.duration, fps);
    if (segments.length === 0) throw new SpecError("nothing left to render: every kept range is empty or past the end of the video");
    const duration = outputDuration(segments);

    // Output frame: the requested size, else the source size; previews are 540p.
    let width = spec.output?.width ?? media.width;
    let height = spec.output?.height ?? media.height;
    if (preview) {
        const k = Math.min(1, 540 / Math.min(width, height));
        width *= k;
        height *= k;
    }
    width = even(width);
    height = even(height);
    // The video is fit inside the frame; zoom and captions apply to that fitted picture.
    const fit = Math.min(width / media.width, height / media.height);
    const vw = even(media.width * fit);
    const vh = even(media.height * fit);

    const zooms = zoomsToOutput(spec.zooms ?? [], segments);
    const tmp = mkdtempSync(join(tmpdir(), "vidartifax-"));
    try {
        let captionCount = 0;
        let assFile: string | null = null;
        if (spec.captions) {
            const transcript = loadTranscript(resolve(base, spec.captions.transcript));
            const cues = groupCues(
                wordsToOutput(transcript.words, segments),
                spec.captions.maxWords ?? 4,
                spec.captions.maxChars ?? 28,
            );
            captionCount = cues.length;
            assFile = "captions.ass";
            writeFileSync(join(tmp, assFile), buildAss(cues, spec.captions, width, height));
        }

        const graph = buildGraph({ segments, fps, vw, vh, width, height, zoom: zoomFilter(zooms, fps), assFile, hasAudio: media.hasAudio });
        const graphFile = join(tmp, "graph.txt");
        writeFileSync(graphFile, graph);
        const graphArgs = ffmpegMajor(version) >= 7 || ffmpegMajor(version) === 0
            ? ["-/filter_complex", graphFile]
            : ["-filter_complex_script", graphFile];

        const args = [
            "-y", "-i", input,
            ...graphArgs,
            "-map", "[v]",
            ...(media.hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : []),
            "-c:v", "libx264",
            "-preset", preview ? "ultrafast" : "veryfast",
            "-crf", String(preview ? 28 : spec.output?.crf ?? 20),
            "-pix_fmt", "yuv420p",
            "-r", String(fps),
            "-movflags", "+faststart",
            output,
        ];
        // Subtitles are referenced relative to the temp dir, which avoids
        // escaping drive letters and colons inside the filter graph.
        await run(args, { duration, onProgress: opts.onProgress, cwd: tmp });

        return {
            output,
            duration,
            sourceDuration: media.duration,
            removed: media.duration - duration,
            zooms: zooms.length,
            captions: captionCount,
            seconds: (Date.now() - began) / 1000,
        };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

export interface GraphInput {
    segments: Segment[];
    fps: number;
    /** Size of the fitted picture. */
    vw: number;
    vh: number;
    /** Size of the output frame. */
    width: number;
    height: number;
    zoom: string | null;
    assFile: string | null;
    hasAudio: boolean;
}

/**
 * One pass, no per-segment branches: `select` keeps frames inside kept
 * segments and the timestamps are rebuilt from the frame count, so memory
 * stays flat however many cuts there are. Audio is chopped into blocks of
 * exactly one frame so `aselect` cuts on the same edges as the video.
 */
export function buildGraph(g: GraphInput): string {
    const sel = selectExpr(g.segments, g.fps);
    const video = [
        "setpts=PTS-STARTPTS",
        `fps=${g.fps}`,
        `select='${sel}'`,
        `setpts=N/${g.fps}/TB`,
        `scale=${g.vw}:${g.vh}:flags=bicubic`,
        "setsar=1",
        ...(g.zoom ? [g.zoom] : []),
        ...(g.vw !== g.width || g.vh !== g.height ? [`pad=${g.width}:${g.height}:(ow-iw)/2:(oh-ih)/2:color=black`] : []),
        ...(g.assFile ? [`subtitles=filename=${g.assFile}`] : []),
        "format=yuv420p",
    ];
    const chains = [`[0:v]${video.join(",")}[v]`];
    if (g.hasAudio) {
        const audio = [
            "asetpts=PTS-STARTPTS",
            `aresample=${AUDIO_RATE}:async=1:first_pts=0`,
            `asetnsamples=n=${AUDIO_RATE / g.fps}:p=0`,
            `aselect='${sel}'`,
            "asetpts=N/SR/TB",
        ];
        chains.push(`[0:a]${audio.join(",")}[a]`);
    }
    return chains.join(";\n");
}
