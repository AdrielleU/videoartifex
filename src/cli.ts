#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze, sidecar } from "./analyze/index.ts";
import { checkFfmpeg, ffmpegMajor } from "./ffmpeg.ts";
import { snapshot } from "./frames.ts";
import { plan, type Analysis, type PlanOptions } from "./plan.ts";
import { loadSpec, render, type RenderResult } from "./render.ts";
import { DEFAULT_PORT, startUi } from "./ui/server.ts";

const HELP = `VidArtifax: edit videos with native ffmpeg, made for Claude Code

Usage:
  vidartifax auto <video> [--preview]       analyze + plan + render in one go
  vidartifax analyze <video>                silences, on-screen activity, transcript
  vidartifax plan <video>                   write <name>.edit.json from the analysis
  vidartifax render <edit.json> [--preview] render the edit to MP4
  vidartifax frames <video> --at 3,7.5      PNG snapshots (--grid to read focus points, --width px)
  vidartifax validate <edit.json>           check an edit file
  vidartifax ui [folder]                    web editor at http://localhost:17211 (--port, --host)
  vidartifax doctor                         check ffmpeg and transcription setup

Analyze options:
  --transcript <file>   use an existing transcript (JSON, SRT, VTT)
  --no-transcript       skip captions
  --model <name>        whisper model: tiny, base (default), small, medium, large-v3
  --language <code>     e.g. en; detected if omitted
  --noise <dB>          silence threshold, default -35

Plan options:
  --no-cut --no-zoom --no-captions   turn a step off
  --min-silence <s>     shortest pause to cut, default 0.6
  --pad <s>             silence kept around each cut, default 0.15
  --max-zoom <x>        largest auto-zoom, default 2.2

Render options:
  --preview             fast 540p draft (<name>.preview.mp4)
  -o, --output <file>   output path

Edit file format: https://github.com/AdrielleU/vidartifax/blob/main/skills/vidartifax/edit-format.md
`;

const opts = {
    help: { type: "boolean", short: "h" },
    preview: { type: "boolean" },
    output: { type: "string", short: "o" },
    transcript: { type: "string" },
    "no-transcript": { type: "boolean" },
    force: { type: "boolean" },
    model: { type: "string" },
    language: { type: "string" },
    noise: { type: "string" },
    "no-cut": { type: "boolean" },
    "no-zoom": { type: "boolean" },
    "no-captions": { type: "boolean" },
    "min-silence": { type: "string" },
    pad: { type: "string" },
    "max-zoom": { type: "string" },
    at: { type: "string" },
    grid: { type: "boolean" },
    width: { type: "string" },
    json: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof opts; allowPositionals: true }>>["values"];

const log = (msg: string) => process.stderr.write(msg + "\n");

function num(v: string | undefined, name: string): number | undefined {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
}

function need(arg: string | undefined, what: string): string {
    if (!arg) throw new Error(`missing ${what}. Run vidartifax --help.`);
    if (!existsSync(arg)) throw new Error(`${arg} not found`);
    return arg;
}

function planOptions(v: Values): PlanOptions {
    return {
        cutSilences: !v["no-cut"],
        zooms: !v["no-zoom"],
        captions: !v["no-captions"],
        minSilence: num(v["min-silence"], "min-silence"),
        pad: num(v.pad, "pad"),
        maxScale: num(v["max-zoom"], "max-zoom"),
    };
}

async function doAnalyze(video: string, v: Values) {
    return analyze(video, {
        noTranscript: v["no-transcript"] || v["no-captions"],
        transcript: v.transcript,
        force: v.force,
        model: v.model,
        language: v.language,
        noiseDb: num(v.noise, "noise"),
        log,
    });
}

function doPlan(analysisFile: string, analysis: Analysis, v: Values, out?: string): string {
    const spec = plan(analysis, planOptions(v));
    const file = out ?? sidecar(resolve(dirname(analysisFile), analysis.input), "edit.json");
    writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
    const kept = spec.keep?.reduce((n, r) => n + r.end - r.start, 0) ?? analysis.media.duration;
    log(`plan: keep ${kept.toFixed(1)} of ${analysis.media.duration.toFixed(1)} s, ${spec.zooms?.length ?? 0} zooms, captions ${spec.captions ? "on" : "off"}`);
    log(`wrote ${file}`);
    return file;
}

function progress() {
    let last = -1;
    return (f: number) => {
        const pct = Math.floor(f * 100);
        if (pct !== last && process.stderr.isTTY) process.stderr.write(`\rrendering ${pct}%`);
        last = pct;
    };
}

function report(r: RenderResult) {
    if (process.stderr.isTTY) process.stderr.write("\r");
    log(`rendered ${r.output}`);
    log(`  ${r.sourceDuration.toFixed(1)} s -> ${r.duration.toFixed(1)} s (cut ${r.removed.toFixed(1)} s), ${r.zooms} zooms, ${r.captions} captions, took ${r.seconds.toFixed(1)} s`);
}

async function main() {
    const { values: v, positionals } = parseArgs({ options: opts, allowPositionals: true, strict: true });
    const [cmd, arg] = positionals;
    if (v.help || !cmd) {
        process.stdout.write(HELP);
        return;
    }

    switch (cmd) {
        case "analyze": {
            const { file, analysis } = await doAnalyze(need(arg, "video"), v);
            log(`wrote ${file}`);
            if (v.json) process.stdout.write(JSON.stringify(analysis, null, 1) + "\n");
            break;
        }
        case "plan": {
            const input = need(arg, "video or analysis file");
            const analysisFile = input.endsWith(".analysis.json") ? input : sidecar(input, "analysis.json");
            const analysis = existsSync(analysisFile)
                ? (JSON.parse(readFileSync(analysisFile, "utf8")) as Analysis)
                : (await doAnalyze(input, v)).analysis;
            doPlan(analysisFile, analysis, v, v.output);
            break;
        }
        case "render": {
            const r = await render(need(arg, "edit file"), { preview: v.preview, output: v.output, onProgress: progress() });
            report(r);
            if (v.json) process.stdout.write(JSON.stringify(r) + "\n");
            break;
        }
        case "auto": {
            const video = need(arg, "video");
            const { file, analysis } = await doAnalyze(video, v);
            const editFile = doPlan(file, analysis, v);
            const r = await render(editFile, { preview: v.preview, output: v.output, onProgress: progress() });
            report(r);
            break;
        }
        case "frames": {
            if (!v.at) throw new Error("--at is required, e.g. --at 3,7.5");
            const at = v.at.split(",").map(s => num(s.trim(), "at")!);
            const files = await snapshot(need(arg, "video"), { at, grid: v.grid, outDir: v.output, width: num(v.width, "width") });
            for (const f of files) process.stdout.write(f + "\n");
            break;
        }
        case "validate": {
            const spec = loadSpec(need(arg, "edit file"));
            log(`${basename(arg!)} is valid: ${spec.keep?.length ?? "all"} kept ranges, ${spec.zooms?.length ?? 0} zooms, captions ${spec.captions ? "on" : "off"}`);
            break;
        }
        case "ui": {
            const dir = arg ?? ".";
            if (!existsSync(dir)) throw new Error(`${dir} not found`);
            checkFfmpeg();
            const port = num(v.port, "port") ?? DEFAULT_PORT;
            const { url } = await startUi({ dir, port, host: v.host, log }).catch((e: NodeJS.ErrnoException) => {
                throw e.code === "EADDRINUSE" ? new Error(`port ${port} is in use; pick another with --port`) : e;
            });
            log(`VidArtifax UI for ${resolve(dir)}`);
            log(`open ${url}  (Ctrl+C to stop)`);
            break;
        }
        case "doctor": {
            const { version, filters } = checkFfmpeg();
            log(`ffmpeg: ${version}`);
            const needed = ["perspective", "subtitles", "silencedetect", "drawgrid", "asetnsamples"];
            const missing = needed.filter(f => !filters.has(f));
            log(missing.length ? `  missing filters: ${missing.join(", ")} (install a full ffmpeg build)` : "  filters: ok");
            if (ffmpegMajor(version) > 0 && ffmpegMajor(version) < 6) log("  ffmpeg 6 or newer is recommended");
            const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
            const py = spawnSync("python3", ["-c", "import faster_whisper"], { stdio: "ignore" });
            log(`transcription: ${!uv.error && uv.status === 0 ? `uv (${uv.stdout.trim()}), faster-whisper installs on first use` : py.status === 0 ? "python3 with faster-whisper" : "unavailable: install uv or `pip install faster-whisper`, or pass --transcript"}`);
            break;
        }
        default:
            throw new Error(`unknown command "${cmd}". Run vidartifax --help.`);
    }
}

main().catch((e: Error) => {
    if (process.stderr.isTTY) process.stderr.write("\n");
    log(`error: ${e.message}`);
    process.exit(1);
});
