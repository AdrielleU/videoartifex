import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, sidecar } from "../analyze/index.ts";
import { assemble } from "../assemble.ts";
import { probe, runRaw } from "../ffmpeg.ts";
import { renderSequence, sequenceStem } from "../sequence.ts";
import { plan, type Analysis, type PlanOptions } from "../plan.ts";
import { render } from "../render.ts";
import { validateSequence, validateSpec, type SequenceSpec } from "../spec.ts";
import { loadTranscript } from "../analyze/transcribe.ts";

export const DEFAULT_PORT = 17211;

export interface UiOptions {
    dir: string;
    port?: number;
    host?: string;
    log?: (msg: string) => void;
}

const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const TYPES: Record<string, string> = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".png": "image/png", ".json": "application/json",
};
/** Pure modules the page imports, so its live preview uses the renderer's own math. */
const LIBS = new Set(["timeline", "zoom", "captions"]);
const SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const LIB_EXT = extname(fileURLToPath(import.meta.url));

const PAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), "page.html");

const isOutput = (name: string) => /\.(edited|preview)\.mp4$/.test(name);
const isSequenceFile = (name: string) => name.endsWith(".sequence.json");
const SCRIPT = new Set([".md", ".txt"]);
const stem = (name: string) => basename(name, extname(name));

interface Job {
    video: string;
    action: string;
    progress: number;
    log: string[];
    error?: string;
    done: boolean;
}

/**
 * Local web UI for one folder of videos. The edit files on disk stay the
 * source of truth: the page saves every change to `<name>.edit.json`, and
 * edits made elsewhere (by Claude Code, an editor, the CLI) show up in the
 * page as soon as the file changes.
 */
export function startUi(opts: UiOptions): Promise<{ url: string; close: () => void }> {
    const dir = resolve(opts.dir);
    const log = opts.log ?? (() => { });
    const clients = new Set<ServerResponse>();
    let job: Job | null = null;

    const send = (data: unknown) => {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        for (const c of clients) c.write(msg);
    };

    // Coalesce bursts of fs events (editors write files in several steps).
    let pending = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const watcher = watch(dir, (_event, name) => {
        if (!name || name.startsWith(".")) return;
        // Outputs being written fire constantly during a render; the job's end announces them.
        if (job && !job.done && isOutput(name)) return;
        pending.add(name);
        timer ??= setTimeout(() => {
            send({ type: "files", names: [...pending] });
            pending = new Set();
            timer = null;
        }, 150);
    });

    /** Resolves a bare file name inside the folder; rejects anything else. */
    const file = (name: string | null): string => {
        if (!name) throw new HttpError(400, "bad file name");
        const p = resolve(dir, name);
        // Sequences may point into subfolders, but never outside this folder or at hidden files.
        if (!p.startsWith(dir + sep) || relative(dir, p).split(sep).some(part => part.startsWith("."))) throw new HttpError(400, "bad file name");
        if (!existsSync(p)) throw new HttpError(404, `${name} not found`);
        return p;
    };

    const readJson = (p: string): unknown => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined);

    function listVideos() {
        return readdirSync(dir)
            .filter(n => VIDEO.has(extname(n).toLowerCase()) && !isOutput(n) && !n.startsWith("."))
            .sort()
            .map(name => {
                const s = stem(name);
                const has = (suffix: string) => existsSync(join(dir, `${s}.${suffix}`));
                return {
                    name,
                    analyzed: has("analysis.json"),
                    edit: has("edit.json"),
                    edited: has("edited.mp4"),
                    preview: has("preview.mp4"),
                };
            });
    }

    function listSequences() {
        return readdirSync(dir).filter(n => isSequenceFile(n) && !n.startsWith(".")).sort().map(name => ({
            name,
            edited: existsSync(join(dir, `${sequenceStem(name)}.edited.mp4`)),
        }));
    }

    const listScripts = () => readdirSync(dir).filter(n => SCRIPT.has(extname(n).toLowerCase()) && !n.startsWith(".")).sort();

    const outputs = (outStem: string) => {
        const mtime = (kind: string) => {
            const p = join(dir, `${outStem}.${kind}.mp4`);
            return existsSync(p) ? statSync(p).mtimeMs : null;
        };
        return { edited: mtime("edited"), preview: mtime("preview") };
    };

    /** What the page needs to preview one clip: probe, analysis and transcript. */
    function clipInfo(video: string) {
        const analysis = readJson(sidecar(video, "analysis.json")) as Analysis | undefined;
        const transcript = analysis?.transcript ? join(dirname(video), analysis.transcript) : sidecar(video, "transcript.json");
        let words: unknown[] = [];
        if (existsSync(transcript)) {
            try {
                words = loadTranscript(transcript).words;
            } catch { /* shown as no captions */ }
        }
        return {
            media: analysis?.media ?? probe(video),
            silences: analysis?.silences ?? [],
            activity: analysis?.activity ?? [],
            analyzed: !!analysis,
            words,
        };
    }

    function sequence(name: string) {
        const p = file(name);
        const text = readFileSync(p, "utf8");
        let seq: SequenceSpec | null = null;
        let error: string | null = null;
        try {
            seq = validateSequence(JSON.parse(text));
        } catch (e) {
            error = (e as Error).message;
        }
        // Sequence paths are relative to the sequence file, which sits in the folder.
        const items = (seq?.items ?? []).map(item => {
            try {
                return { ...clipInfo(file(item.input)), error: null };
            } catch (e) {
                return { error: (e as Error).message };
            }
        });
        let script: string | null = null;
        if (seq?.script) {
            try {
                script = readFileSync(file(seq.script), "utf8");
            } catch { /* missing script is fine */ }
        }
        const outStem = sequenceStem(name);
        return { name, seq, text, error, items, script, outStem, outputs: outputs(outStem), scripts: listScripts() };
    }

    function saveSequence(name: string, body: string) {
        if (!isSequenceFile(name) || name !== basename(name)) throw new HttpError(400, "sequence files are named <name>.sequence.json");
        let data: unknown;
        try {
            data = JSON.parse(body);
            validateSequence(data);
        } catch (e) {
            throw new HttpError(400, (e as Error).message);
        }
        writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + "\n");
    }

    const thumbs = new Map<string, Buffer>();
    async function thumb(res: ServerResponse, name: string, t: number) {
        const p = file(name);
        const key = `${p}@${t.toFixed(2)}@${statSync(p).mtimeMs}`;
        let img = thumbs.get(key);
        if (!img) {
            const chunks: Buffer[] = [];
            await runRaw(["-ss", String(Math.max(0, t)), "-i", p, "-frames:v", "1", "-vf", "scale=320:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1"], c => chunks.push(c));
            img = Buffer.concat(chunks);
            if (thumbs.size > 500) thumbs.clear();
            thumbs.set(key, img);
        }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
        res.end(img);
    }

    function project(name: string) {
        const video = file(name);
        const s = stem(name);
        const analysis = readJson(sidecar(video, "analysis.json")) as Analysis | undefined;
        const media = analysis?.media ?? probe(video);

        const editPath = sidecar(video, "edit.json");
        let edit: unknown;
        let editText: string | undefined;
        let editError: string | undefined;
        if (existsSync(editPath)) {
            editText = readFileSync(editPath, "utf8");
            try {
                edit = validateSpec(JSON.parse(editText));
            } catch (e) {
                editError = (e as Error).message;
            }
        }

        const spec = edit as { captions?: { transcript?: string } | false } | undefined;
        const transcriptRef = (spec?.captions && spec.captions.transcript) || analysis?.transcript;
        let words: unknown[] = [];
        if (transcriptRef && existsSync(join(dir, transcriptRef))) {
            try {
                words = loadTranscript(join(dir, transcriptRef)).words;
            } catch { /* shown as no captions */ }
        }
        return {
            name,
            media,
            silences: analysis?.silences ?? [],
            activity: analysis?.activity ?? [],
            analyzed: !!analysis,
            edit: edit ?? null,
            editText: editText ?? null,
            editError: editError ?? null,
            words,
            outStem: s,
            outputs: outputs(s),
        };
    }

    function saveEdit(name: string, body: string) {
        const video = file(name);
        let data: unknown;
        try {
            data = JSON.parse(body);
        } catch (e) {
            throw new HttpError(400, `not JSON: ${(e as Error).message}`);
        }
        try {
            validateSpec(data);
        } catch (e) {
            throw new HttpError(400, (e as Error).message);
        }
        writeFileSync(sidecar(video, "edit.json"), JSON.stringify(data, null, 2) + "\n");
    }

    interface JobBody extends PlanOptions {
        videos?: string[];
        script?: string | null;
        name?: string;
    }

    function startJob(name: string, action: string, planOpts: JobBody) {
        if (job && !job.done) throw new HttpError(409, `busy: ${job.action} ${job.video}`);
        if (action === "assemble") {
            if (!isSequenceFile(name) || name !== basename(name)) throw new HttpError(400, "name must end in .sequence.json");
            if (!planOpts.videos?.length) throw new HttpError(400, "pick at least one video");
            planOpts.videos.forEach(file);
            if (planOpts.script) file(planOpts.script);
        } else if (isSequenceFile(name)) {
            file(name);
            if (action !== "preview" && action !== "render") throw new HttpError(400, `can't ${action} a sequence`);
        }
        const video = action === "assemble" ? join(dir, name) : file(name);
        const j: Job = { video: name, action, progress: 0, log: [], done: false };
        job = j;
        const say = (msg: string) => {
            j.log.push(msg);
            log(`[${name}] ${msg}`);
            send({ type: "job", job: j });
        };
        const onProgress = (f: number) => {
            if (Math.floor(f * 100) === Math.floor(j.progress * 100)) return;
            j.progress = f;
            send({ type: "job", job: j });
        };

        const writePlan = (analysis: Analysis) => {
            const spec = plan(analysis, planOpts);
            writeFileSync(sidecar(video, "edit.json"), JSON.stringify(spec, null, 2) + "\n");
            say(`planned: ${spec.keep?.length ?? 1} kept ranges, ${spec.zooms?.length ?? 0} zooms, captions ${spec.captions ? "on" : "off"}`);
        };
        const doRender = async (preview: boolean) => {
            const r = await render(sidecar(video, "edit.json"), { preview, onProgress });
            say(`rendered ${basename(r.output)}: ${r.sourceDuration.toFixed(1)} s -> ${r.duration.toFixed(1)} s in ${r.seconds.toFixed(1)} s`);
        };

        (async () => {
            say(`${action} started`);
            if (action === "assemble") {
                const { sequence: seq } = await assemble({
                    ...planOpts,
                    videos: planOpts.videos!.map(v => join(dir, v)),
                    script: planOpts.script ? join(dir, planOpts.script) : undefined,
                    out: video,
                    log: say,
                });
                writeFileSync(video, JSON.stringify(seq, null, 2) + "\n");
                say(`planned ${seq.items.length} clips${seq.unmatched?.length ? `, ${seq.unmatched.length} script lines not found` : ""}`);
                return;
            }
            if (isSequenceFile(name)) {
                const r = await renderSequence(video, { preview: action === "preview", onProgress });
                say(`rendered ${basename(r.output)}: ${r.items} clips, ${r.duration.toFixed(1)} s in ${r.seconds.toFixed(1)} s`);
                return;
            }
            switch (action) {
                case "analyze":
                    await analyze(video, { log: say, noTranscript: planOpts.captions === false });
                    break;
                case "plan": {
                    const a = readJson(sidecar(video, "analysis.json")) as Analysis | undefined;
                    writePlan(a ?? (await analyze(video, { log: say })).analysis);
                    break;
                }
                case "auto":
                    writePlan((await analyze(video, { log: say, noTranscript: planOpts.captions === false })).analysis);
                    await doRender(false);
                    break;
                case "preview":
                case "render":
                    await doRender(action === "preview");
                    break;
                default:
                    throw new Error(`unknown action ${action}`);
            }
        })()
            .catch((e: Error) => {
                j.error = e.message;
                say(`error: ${e.message}`);
            })
            .finally(() => {
                j.done = true;
                j.progress = 1;
                send({ type: "job", job: j });
                send({ type: "files", names: [name] });
            });
    }

    function serveFile(req: IncomingMessage, res: ServerResponse, p: string) {
        const size = statSync(p).size;
        const type = TYPES[extname(p).toLowerCase()] ?? "application/octet-stream";
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
        if (!range) {
            res.writeHead(200, { ...headers, "Content-Length": size });
            createReadStream(p).pipe(res);
            return;
        }
        // Video elements seek with byte ranges.
        let start = range[1] ? Number(range[1]) : size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : size - 1;
        start = Math.max(0, start);
        end = Math.min(end, size - 1);
        if (start > end) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            res.end();
            return;
        }
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        createReadStream(p, { start, end }).pipe(res);
    }

    async function lib(res: ServerResponse, name: string) {
        if (!LIBS.has(name)) throw new HttpError(404, "not found");
        let code = readFileSync(join(SRC_DIR, name + LIB_EXT), "utf8");
        if (LIB_EXT === ".ts") {
            // Running from source (npm run dev): strip types so the browser can load it.
            const { stripTypeScriptTypes } = await import("node:module") as unknown as { stripTypeScriptTypes: (s: string) => string };
            code = stripTypeScriptTypes(code);
        }
        res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
        res.end(code);
    }

    async function handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const v = url.searchParams.get("v");
        const json = (data: unknown, status = 200) => {
            res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
            res.end(JSON.stringify(data));
        };

        if (req.method === "GET" && path === "/") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(readFileSync(PAGE_FILE, "utf8").replaceAll("__LIB_EXT__", LIB_EXT));
        } else if (req.method === "GET" && path.startsWith("/lib/")) {
            await lib(res, basename(path, LIB_EXT));
        } else if (req.method === "GET" && path === "/api/videos") {
            json({ dir, videos: listVideos(), sequences: listSequences(), scripts: listScripts(), job });
        } else if (req.method === "GET" && path === "/api/project") {
            json(project(v ?? ""));
        } else if (req.method === "GET" && path === "/api/sequence") {
            json(sequence(url.searchParams.get("s") ?? ""));
        } else if (req.method === "PUT" && path === "/api/sequence") {
            saveSequence(url.searchParams.get("s") ?? "", await body(req));
            json({ ok: true });
        } else if (req.method === "GET" && path === "/api/thumb") {
            await thumb(res, url.searchParams.get("f") ?? "", Number(url.searchParams.get("t") ?? 0) || 0);
        } else if (req.method === "PUT" && path === "/api/edit") {
            saveEdit(v ?? "", await body(req));
            json({ ok: true });
        } else if (req.method === "POST" && path === "/api/run") {
            const o = JSON.parse((await body(req)) || "{}") as JobBody;
            startJob(v ?? "", url.searchParams.get("action") ?? "", o);
            json({ ok: true });
        } else if (req.method === "GET" && path === "/api/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            res.write(`data: ${JSON.stringify({ type: "hello", job })}\n\n`);
            clients.add(res);
            req.on("close", () => clients.delete(res));
        } else if (req.method === "GET" && path.startsWith("/file/")) {
            serveFile(req, res, file(decodeURIComponent(path.slice(6))));
        } else {
            throw new HttpError(404, "not found");
        }
    }

    const server = createServer((req, res) => {
        handle(req, res).catch((e: Error) => {
            const status = e instanceof HttpError ? e.status : 500;
            if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
        });
    });
    // Keep SSE connections alive through proxies and idle timeouts.
    const ping = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25000);

    const port = opts.port ?? DEFAULT_PORT;
    const host = opts.host ?? "127.0.0.1";
    return new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => {
            const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
            const actual = (server.address() as { port: number }).port;
            ok({
                url: `http://${shown}:${actual}`,
                close: () => {
                    clearInterval(ping);
                    watcher.close();
                    for (const c of clients) c.end();
                    server.close();
                },
            });
        });
    });
}

class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function body(req: IncomingMessage): Promise<string> {
    return new Promise((ok, fail) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 5 * 1024 * 1024) {
                fail(new HttpError(413, "request too large"));
                req.destroy();
            }
            chunks.push(c);
        });
        req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
        req.on("error", fail);
    });
}
