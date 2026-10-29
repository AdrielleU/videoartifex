import { spawn, spawnSync } from "node:child_process";

export const FFMPEG = process.env.VIDEOARTIFEX_FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.VIDEOARTIFEX_FFPROBE ?? "ffprobe";

export class FfmpegError extends Error { }

export interface MediaInfo {
    duration: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
    /** Recording time from the file's metadata, when present (ISO 8601). */
    created?: string;
}

/** Fails with install instructions if ffmpeg is missing or lacks what we need. */
export function checkFfmpeg(): { version: string; filters: Set<string> } {
    const v = spawnSync(FFMPEG, ["-hide_banner", "-version"], { encoding: "utf8" });
    if (v.error || v.status !== 0) {
        throw new FfmpegError(
            "ffmpeg not found. Install it (macOS: `brew install ffmpeg`, Ubuntu/Debian: `sudo apt install ffmpeg`, " +
            "Windows: `winget install ffmpeg`) or set VIDEOARTIFEX_FFMPEG to its path.",
        );
    }
    const f = spawnSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf8" });
    const filters = new Set(
        f.stdout.split("\n").map(l => l.trim().split(/\s+/)[1]).filter((x): x is string => !!x),
    );
    return { version: v.stdout.split("\n")[0] ?? "", filters };
}

export function requireFilters(names: string[]) {
    const { filters } = checkFfmpeg();
    const missing = names.filter(n => !filters.has(n));
    if (missing.length) {
        throw new FfmpegError(`Your ffmpeg build lacks: ${missing.join(", ")}. Install a full build (e.g. from ffmpeg.org/download.html).`);
    }
}

export function probe(file: string): MediaInfo {
    const r = spawnSync(FFPROBE, [
        "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new FfmpegError(`ffprobe not found (set VIDEOARTIFEX_FFPROBE): ${r.error.message}`);
    if (r.status !== 0) throw new FfmpegError(`ffprobe failed on ${file}: ${r.stderr.trim()}`);
    const data = JSON.parse(r.stdout) as {
        format?: { duration?: string; tags?: { creation_time?: string } };
        streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }[];
    };
    const video = data.streams?.find(s => s.codec_type === "video");
    if (!video?.width || !video.height) throw new FfmpegError(`${file} has no video stream`);
    const rate = (s?: string) => {
        const [a, b] = (s ?? "").split("/").map(Number);
        return a && b ? a / b : 0;
    };
    const fps = rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 30;
    const duration = Number(data.format?.duration ?? video.duration ?? 0);
    if (!(duration > 0)) throw new FfmpegError(`Couldn't read the duration of ${file}`);
    return {
        duration,
        width: video.width,
        height: video.height,
        fps,
        hasAudio: !!data.streams?.some(s => s.codec_type === "audio"),
        ...(data.format?.tags?.creation_time ? { created: data.format.tags.creation_time } : {}),
    };
}

export interface RunOptions {
    /** Output duration in seconds, to report progress. */
    duration?: number;
    onProgress?: (fraction: number) => void;
    /** Working directory for ffmpeg; relative paths in filter graphs resolve here. */
    cwd?: string;
}

/** Runs ffmpeg, resolving with stderr. Rejects with the last stderr lines on failure. */
export function run(args: string[], opts: RunOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const full = ["-hide_banner", "-nostdin", ...(opts.onProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args];
        const p = spawn(FFMPEG, full, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
        let stderr = "";
        p.stderr.on("data", d => {
            stderr += d;
            if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
        });
        p.stdout.on("data", (d: Buffer) => {
            if (!opts.onProgress || !opts.duration) return;
            const m = /out_time_us=(\d+)/g;
            let last: RegExpExecArray | null = null;
            for (let x = m.exec(d.toString()); x; x = m.exec(d.toString())) last = x;
            if (last) opts.onProgress(Math.min(1, Number(last[1]) / 1e6 / opts.duration));
        });
        p.on("error", e => reject(new FfmpegError(`couldn't start ffmpeg: ${e.message}`)));
        p.on("close", code => {
            if (code === 0) resolve(stderr);
            else reject(new FfmpegError(`ffmpeg exited with ${code}:\n${stderr.trim().split("\n").slice(-15).join("\n")}`));
        });
    });
}

/** Runs ffmpeg and streams raw stdout chunks to `onData`. */
export function runRaw(args: string[], onData: (chunk: Buffer) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-v", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        p.stderr.on("data", d => (stderr += d));
        p.stdout.on("data", onData);
        p.on("error", e => reject(new FfmpegError(`couldn't start ffmpeg: ${e.message}`)));
        p.on("close", code => (code === 0 ? resolve() : reject(new FfmpegError(`ffmpeg exited with ${code}: ${stderr.trim()}`))));
    });
}

/** Major version number, or 0 if unknown. */
export function ffmpegMajor(versionLine: string): number {
    const m = /version n?(\d+)\./.exec(versionLine);
    return m ? Number(m[1]) : 0;
}
