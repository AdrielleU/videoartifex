import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { analyze, sidecar, type AnalyzeOptions } from "./analyze/index.ts";
import { keepFromSilences } from "./analyze/silence.ts";
import { loadTranscript } from "./analyze/transcribe.ts";
import { plan, zoomsFromActivity, type Analysis, type PlanOptions } from "./plan.ts";
import type { Range, SequenceItem, SequenceSpec, Word } from "./spec.ts";

/** One analyzed clip, as the planner sees it. */
export interface Clip {
    /** Path written into the sequence file (relative to it). */
    input: string;
    analysis: Analysis;
    words: Word[];
    /** For ordering clips when there's no script: recording time, else file time. */
    time: number;
}

export interface ScriptLine {
    section: string;
    text: string;
    tokens: string[];
}

export interface LineMatch extends Alignment {
    line: ScriptLine;
    clip: number;
}

export interface AssemblePlan {
    sequence: SequenceSpec;
    matches: LineMatch[];
}

export interface AssembleOptions extends PlanOptions {
    /** Script lines matching worse than this are reported as unmatched. Default 0.5. */
    minMatch?: number;
}

const NUMBERS: Record<string, string> = {
    zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

/** Lowercase words without punctuation, with small numbers as digits (whisper writes both). */
export function tokens(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/['’]/g, "")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map(t => NUMBERS[t] ?? t);
}

/**
 * Splits a script into spoken lines. Markdown headings start sections;
 * bracketed notes like `[show the settings page]` are directions, not speech.
 */
export function parseScript(text: string): ScriptLine[] {
    const lines: ScriptLine[] = [];
    let section = "";
    let paragraph: string[] = [];
    const flush = () => {
        const body = paragraph.join(" ").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
        paragraph = [];
        for (const sentence of body.split(/(?<=[.!?])\s+/)) {
            const t = tokens(sentence);
            if (t.length) lines.push({ section, text: sentence.trim(), tokens: t });
        }
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
            flush();
            section = heading[1]!.replace(/[*_`]/g, "").trim();
        } else if (!line) {
            flush();
        } else {
            paragraph.push(line.replace(/^([-*+>]|\d+[.)])\s+/, "").replace(/[*_`]/g, ""));
        }
    }
    flush();
    return lines;
}

/**
 * Best local alignment of a script line inside a transcript
 * (Smith-Waterman on words), so retakes, filler and misheard words still
 * match. Ties go to the later position: the last take is usually the keeper.
 */
export interface Alignment {
    /** Matched word indexes in the transcript, inclusive. */
    first: number;
    last: number;
    score: number;
    /** Script words left over before and after the match (often misheard ones). */
    before: number;
    after: number;
}

export function alignLine(line: string[], words: string[]): Alignment | null {
    const m = line.length;
    const n = words.length;
    if (!m || !n) return null;
    let prev = new Float64Array(n + 1);
    let prevStart = new Int32Array(n + 1);
    let prevRow = new Int32Array(n + 1);
    let cur = new Float64Array(n + 1);
    let curStart = new Int32Array(n + 1);
    let curRow = new Int32Array(n + 1);
    let best = 0;
    let bestEnd = -1;
    let bestStart = -1;
    let bestRow = 0;
    let bestStartRow = 0;
    for (let i = 1; i <= m; i++) {
        cur[0] = 0;
        for (let j = 1; j <= n; j++) {
            const diag = prev[j - 1]! + (line[i - 1] === words[j - 1] ? 2 : -1);
            const up = prev[j]! - 1;
            const left = cur[j - 1]! - 1;
            let h = 0;
            let s = j - 1;
            let r = i;
            if (diag > h) {
                h = diag;
                if (prev[j - 1]! > 0) { s = prevStart[j - 1]!; r = prevRow[j - 1]!; }
            }
            if (up > h) { h = up; s = prevStart[j]!; r = prevRow[j]!; }
            if (left > h) { h = left; s = curStart[j - 1]!; r = curRow[j - 1]!; }
            cur[j] = h;
            curStart[j] = s;
            curRow[j] = r;
            if (h > 0 && h >= best) {
                best = h;
                bestEnd = j - 1;
                bestStart = s;
                bestRow = i;
                bestStartRow = r;
            }
        }
        [prev, cur] = [cur, prev];
        [prevStart, curStart] = [curStart, prevStart];
        [prevRow, curRow] = [curRow, prevRow];
    }
    if (bestEnd < 0) return null;
    return { first: bestStart, last: bestEnd, score: Math.min(1, best / (2 * m)), before: bestStartRow - 1, after: m - bestRow };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Intersection of two sorted range lists. */
function intersect(a: Range[], b: Range[]): Range[] {
    const out: Range[] = [];
    for (const x of a) {
        for (const y of b) {
            const start = Math.max(x.start, y.start);
            const end = Math.min(x.end, y.end);
            if (end - start > 0.05) out.push({ start, end });
        }
    }
    return out;
}

/**
 * Script words missing at either end of a match were usually misheard. Take
 * that many neighbouring words too, as long as they run on without a pause,
 * so the clip doesn't cut off the start or end of the line.
 */
function widen(m: LineMatch, words: Word[]): LineMatch {
    let { first, last } = m;
    for (let k = 0; k < m.before && first > 0 && words[first]!.start - words[first - 1]!.end < 0.5; k++) first--;
    for (let k = 0; k < m.after && last < words.length - 1 && words[last + 1]!.start - words[last]!.end < 0.5; k++) last++;
    return { ...m, first, last };
}

/** Plans a sequence: in script order when a script is given, else in recording order. */
export function planSequence(clips: Clip[], script: ScriptLine[] | null, opts: AssembleOptions = {}): AssemblePlan {
    const captions = opts.captions !== false && clips.some(c => c.words.length) ? {} : false;
    if (!script) {
        const ordered = [...clips].sort((a, b) => a.time - b.time || a.input.localeCompare(b.input, undefined, { numeric: true }));
        const items = ordered.map((c): SequenceItem => {
            const e = plan(c.analysis, opts);
            return {
                input: c.input,
                title: basename(c.input, extname(c.input)),
                ...(e.keep ? { keep: e.keep } : {}),
                ...(e.zooms ? { zooms: e.zooms } : {}),
            };
        });
        return { sequence: { version: 1, kind: "sequence", captions, items }, matches: [] };
    }

    const minMatch = opts.minMatch ?? 0.5;
    const pad = opts.pad ?? 0.15;
    const clipTokens = clips.map(c => c.words.map(w => tokens(w.text).join(" ")));
    const matches: LineMatch[] = [];
    const unmatched: string[] = [];
    for (const line of script) {
        let found: LineMatch | null = null;
        clips.forEach((_, ci) => {
            const a = alignLine(line.tokens, clipTokens[ci]!);
            // Later clips win near-ties: retakes are usually recorded after the first try.
            if (a && (!found || a.score >= found.score - 0.05)) found = { line, clip: ci, ...a };
        });
        const f = found as LineMatch | null;
        if (f && f.score >= minMatch) matches.push(widen(f, clips[f.clip]!.words));
        else unmatched.push(line.section ? `${line.section}: ${line.text}` : line.text);
    }

    // Consecutive lines from the same section and clip, moving forward in it, form one item.
    const items: SequenceItem[] = [];
    let group: LineMatch[] = [];
    const flush = () => {
        if (!group.length) return;
        const clip = clips[group[0]!.clip]!;
        const { duration } = clip.analysis.media;
        const spoken = group.map(g => ({
            start: Math.max(0, clip.words[g.first]!.start - pad),
            end: Math.min(duration, clip.words[g.last]!.end + pad),
        }));
        // Merge overlaps, then drop long pauses inside the lines.
        const merged: Range[] = [];
        for (const r of spoken.sort((a, b) => a.start - b.start)) {
            const last = merged[merged.length - 1];
            if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
            else merged.push({ ...r });
        }
        const keep = opts.cutSilences === false
            ? merged
            : intersect(merged, keepFromSilences(clip.analysis.silences, duration, opts));
        const final = (keep.length ? keep : merged).map(r => ({ start: r2(r.start), end: r2(r.end) }));
        const zooms = opts.zooms === false ? [] : zoomsFromActivity(clip.analysis.activity, duration, opts.maxScale, final);
        items.push({
            input: clip.input,
            ...(group[0]!.line.section ? { title: group[0]!.line.section } : {}),
            script: group.map(g => g.line.text).join(" "),
            match: r2(group.reduce((n, g) => n + g.score, 0) / group.length),
            keep: final,
            ...(zooms.length ? { zooms } : {}),
        });
        group = [];
    };
    for (const m of matches) {
        const prev = group[group.length - 1];
        if (prev && (prev.clip !== m.clip || prev.line.section !== m.line.section || m.first <= prev.last)) flush();
        group.push(m);
    }
    flush();

    const sequence: SequenceSpec = { version: 1, kind: "sequence", captions, items };
    if (unmatched.length) sequence.unmatched = unmatched;
    return { sequence, matches };
}

export interface AssembleInput extends AssembleOptions, AnalyzeOptions {
    /** Video files, in any order. */
    videos: string[];
    /** Script file (Markdown or plain text). */
    script?: string;
    /** Where the sequence file will be written; paths in it are relative to this. */
    out: string;
}

/** Analyzes every clip (reusing earlier analysis) and plans the sequence. */
export async function assemble(input: AssembleInput): Promise<AssemblePlan> {
    const outDir = dirname(resolve(input.out));
    const clips: Clip[] = [];
    for (const v of input.videos) {
        const file = resolve(v);
        const existing = sidecar(file, "analysis.json");
        const needWords = !!input.script || input.captions !== false;
        let analysis: Analysis | undefined;
        if (existsSync(existing) && !input.force) {
            analysis = JSON.parse(readFileSync(existing, "utf8")) as Analysis;
            if (needWords && !analysis.transcript && analysis.media.hasAudio && !input.noTranscript) analysis = undefined;
            else input.log?.(`${basename(file)}: reusing analysis`);
        }
        analysis ??= (await analyze(file, input)).analysis;
        const transcript = analysis.transcript ? join(dirname(file), analysis.transcript) : null;
        const words = transcript && existsSync(transcript) ? loadTranscript(transcript).words : [];
        const created = analysis.media.created ? Date.parse(analysis.media.created) : NaN;
        clips.push({
            input: relative(outDir, file),
            analysis,
            words,
            time: Number.isFinite(created) ? created : statSync(file).mtimeMs,
        });
    }
    const script = input.script ? parseScript(readFileSync(input.script, "utf8")) : null;
    if (script && !script.length) throw new Error(`${input.script} has no spoken lines`);
    const result = planSequence(clips, script, input);
    if (input.script) result.sequence.script = relative(outDir, resolve(input.script));
    return result;
}
