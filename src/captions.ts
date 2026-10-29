import type { CaptionsSpec, Word } from "./spec.ts";
import { toOutput, type Segment } from "./timeline.ts";

export interface Cue {
    start: number;
    end: number;
    words: Word[];
}

/**
 * Moves words onto the output timeline. A word is kept if its midpoint
 * survived the cuts; its edges are clamped to the segment it lands in.
 */
export function wordsToOutput(words: Word[], segments: Segment[]): Word[] {
    const out: Word[] = [];
    for (const w of words) {
        const text = w.text.trim();
        if (!text) continue;
        const mid = (w.start + w.end) / 2;
        const seg = segments.find(s => mid >= s.start && mid < s.end);
        if (!seg) continue;
        const start = toOutput(segments, Math.max(w.start, seg.start))!;
        const end = seg.outStart + (Math.min(w.end, seg.end) - seg.start);
        out.push({ start, end: Math.max(end, start + 0.05), text });
    }
    return out;
}

/** Groups words into short on-screen phrases. */
export function groupCues(words: Word[], maxWords: number, maxChars: number): Cue[] {
    const cues: Cue[] = [];
    let cur: Word[] = [];
    const flush = () => {
        if (cur.length) cues.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, words: cur });
        cur = [];
    };
    for (const w of words) {
        const prev = cur[cur.length - 1];
        const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
        if (prev && (cur.length >= maxWords || chars > maxChars || w.start - prev.end > 0.6)) flush();
        cur.push(w);
        if (/[.!?]["')\]]?$/.test(w.text)) flush();
    }
    flush();
    // Hold each caption until the next one if the gap is short, to avoid flicker.
    for (let i = 0; i < cues.length - 1; i++) {
        const gap = cues[i + 1]!.start - cues[i]!.end;
        if (gap > 0 && gap < 0.3) cues[i]!.end = cues[i + 1]!.start;
    }
    return cues;
}

/** #RRGGBB to ASS &HBBGGRR& */
function assColor(hex: string): string {
    const h = hex.replace("#", "");
    return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function assTime(t: number): string {
    const cs = Math.max(0, Math.round(t * 100));
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Strips characters ASS treats as markup. */
function assText(s: string): string {
    return s.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\s+/g, " ");
}

/**
 * Builds an ASS subtitle file. Each caption is emitted once per word, with
 * that word in the highlight color, which gives the "follow along" style
 * without relying on karaoke timing tags.
 */
export function buildAss(cues: Cue[], spec: CaptionsSpec, width: number, height: number): string {
    const size = Math.round(height * (spec.size ?? 0.055));
    const color = spec.color ?? "#FFFFFF";
    const highlight = spec.highlight ?? "#FFD400";
    const alignment = { bottom: 2, middle: 5, top: 8 }[spec.position ?? "bottom"];
    const margin = Math.round(height * 0.08);
    const outline = Math.max(2, Math.round(size / 12));
    const font = spec.font ?? "Arial";
    const fmt = (w: Word) => assText(spec.uppercase ? w.text.toUpperCase() : w.text);

    const lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        `Style: Default,${font},${size},${assColor(color)},${assColor(color)},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,${alignment},${margin},${margin},${margin},1`,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];

    const hl = assColor(highlight);
    for (const cue of cues) {
        cue.words.forEach((w, i) => {
            const start = i === 0 ? cue.start : w.start;
            const end = i === cue.words.length - 1 ? cue.end : cue.words[i + 1]!.start;
            if (end <= start) return;
            const text = cue.words.map((x, j) => (j === i ? `{\\c${hl}&}${fmt(x)}{\\r}` : fmt(x))).join(" ");
            lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
        });
    }
    return lines.join("\n") + "\n";
}
