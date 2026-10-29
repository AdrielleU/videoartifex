import { createReadStream, existsSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, sidecar } from "../analyze/index.ts";
import { probe } from "../ffmpeg.ts";
import { plan, type Analysis, type PlanOptions } from "../plan.ts";
import { render } from "../render.ts";
import { validateSpec } from "../spec.ts";
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
        if (!name || name !== basename(name) || name.startsWith(".")) throw new HttpError(400, "bad file name");
        const p = join(dir, name);
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
        const mtime = (suffix: string) => {
            const p = join(dir, `${s}.${suffix}`);
            return existsSync(p) ? statSync(p).mtimeMs : null;
        };
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
            outputs: { edited: mtime("edited.mp4"), preview: mtime("preview.mp4") },
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

    function startJob(name: string, action: string, planOpts: PlanOptions) {
        if (job && !job.done) throw new HttpError(409, `busy: ${job.action} ${job.video}`);
        const video = file(name);
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
            json({ dir, videos: listVideos(), job });
        } else if (req.method === "GET" && path === "/api/project") {
            json(project(v ?? ""));
        } else if (req.method === "PUT" && path === "/api/edit") {
            saveEdit(v ?? "", await body(req));
            json({ ok: true });
        } else if (req.method === "POST" && path === "/api/run") {
            const o = JSON.parse((await body(req)) || "{}") as PlanOptions;
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
