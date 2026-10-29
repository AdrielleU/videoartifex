/**
 * The edit file (`*.edit.json`). Every time is in seconds of the SOURCE
 * video, so cuts can change without recomputing zoom or caption times; the
 * renderer maps everything onto the output timeline.
 */
export interface EditSpec {
    version: 1;
    /** Source video, relative to the edit file. */
    input: string;
    output?: OutputSpec;
    /** Source ranges to keep, in ascending order. Omit to keep everything. */
    keep?: Range[];
    zooms?: Zoom[];
    captions?: CaptionsSpec | false;
}

export interface Range {
    start: number;
    end: number;
}

export interface OutputSpec {
    /** Relative to the edit file. Default: `<input>.edited.mp4`. */
    path?: string;
    /** Output size. Default: source size. The video is fit inside and padded. */
    width?: number;
    height?: number;
    /** Integer frame rate. Default: source rate rounded, capped at 60. */
    fps?: number;
    /** x264 quality, lower is better. Default 20. */
    crf?: number;
}

export interface Zoom extends Range {
    /** Focus point as a fraction of the frame, 0..1 from the top left. */
    x: number;
    y: number;
    /** Magnification, 1..4. */
    scale: number;
    /** Seconds spent zooming in and out. Default 0.4. */
    ease?: number;
}

export interface CaptionsSpec {
    /** Transcript JSON, relative to the edit file. */
    transcript: string;
    /** Words per caption. Default 4. */
    maxWords?: number;
    /** Characters per caption. Default 28. */
    maxChars?: number;
    position?: "bottom" | "middle" | "top";
    /** Font size as a fraction of output height. Default 0.055. */
    size?: number;
    font?: string;
    color?: string;
    /** Color of the word being spoken. Set to the same as color to disable. */
    highlight?: string;
    uppercase?: boolean;
}

/** Word-level transcript, times in source seconds. */
export interface Transcript {
    language?: string;
    words: Word[];
}

export interface Word {
    start: number;
    end: number;
    text: string;
}

export class SpecError extends Error { }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;

function checkRange(r: unknown, where: string): asserts r is Range {
    if (!isObj(r) || !isNum(r.start) || !isNum(r.end)) throw new SpecError(`${where} needs numeric start and end`);
    if (r.start < 0 || r.end <= r.start) throw new SpecError(`${where}: need 0 <= start < end (got ${r.start}..${r.end})`);
}

/** Validates an edit file, throwing SpecError with the path of the first bad field. */
export function validateSpec(data: unknown): EditSpec {
    if (!isObj(data)) throw new SpecError("edit file must be a JSON object");
    if (data.version !== 1) throw new SpecError(`"version" must be 1`);
    if (typeof data.input !== "string" || !data.input) throw new SpecError(`"input" must be the source video path`);

    if (data.output !== undefined) {
        const o = data.output;
        if (!isObj(o)) throw new SpecError(`"output" must be an object`);
        if (o.path !== undefined && typeof o.path !== "string") throw new SpecError(`output.path must be a string`);
        for (const k of ["width", "height", "fps", "crf"] as const) {
            if (o[k] !== undefined && !(isNum(o[k]) && o[k] > 0)) throw new SpecError(`output.${k} must be a positive number`);
        }
        if ((o.width === undefined) !== (o.height === undefined)) throw new SpecError(`output.width and output.height go together`);
        if (o.fps !== undefined && (!Number.isInteger(o.fps) || (o.fps as number) > 120)) throw new SpecError(`output.fps must be an integer <= 120`);
    }

    if (data.keep !== undefined) {
        if (!Array.isArray(data.keep) || data.keep.length === 0) throw new SpecError(`"keep" must be a non-empty array (omit it to keep everything)`);
        data.keep.forEach((r, i) => {
            checkRange(r, `keep[${i}]`);
            const prev = (data.keep as Range[])[i - 1];
            if (prev && r.start < prev.end) throw new SpecError(`keep[${i}] starts before keep[${i - 1}] ends; ranges must be ascending and not overlap`);
        });
    }

    if (data.zooms !== undefined) {
        if (!Array.isArray(data.zooms)) throw new SpecError(`"zooms" must be an array`);
        const sorted: Zoom[] = [];
        data.zooms.forEach((z, i) => {
            checkRange(z, `zooms[${i}]`);
            const zz = z as unknown as Record<string, unknown>;
            for (const k of ["x", "y"] as const) {
                if (!isNum(zz[k]) || zz[k] < 0 || zz[k] > 1) throw new SpecError(`zooms[${i}].${k} must be 0..1 (fraction of the frame)`);
            }
            if (!isNum(zz.scale) || zz.scale < 1 || zz.scale > 4) throw new SpecError(`zooms[${i}].scale must be 1..4`);
            if (zz.ease !== undefined && !(isNum(zz.ease) && zz.ease >= 0)) throw new SpecError(`zooms[${i}].ease must be >= 0`);
            sorted.push(z as unknown as Zoom);
        });
        sorted.sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i]!.start < sorted[i - 1]!.end) {
                throw new SpecError(`zooms overlap at ${sorted[i]!.start}s; end one zoom before the next starts`);
            }
        }
    }

    if (data.captions !== undefined && data.captions !== false) {
        const c = data.captions;
        if (!isObj(c)) throw new SpecError(`"captions" must be an object or false`);
        if (typeof c.transcript !== "string") throw new SpecError(`captions.transcript must be the transcript JSON path`);
        for (const k of ["maxWords", "maxChars"] as const) {
            if (c[k] !== undefined && !(Number.isInteger(c[k]) && (c[k] as number) > 0)) throw new SpecError(`captions.${k} must be a positive integer`);
        }
        if (c.size !== undefined && !(isNum(c.size) && c.size > 0 && c.size < 0.5)) throw new SpecError(`captions.size must be a fraction of the height, e.g. 0.055`);
        if (c.position !== undefined && !["bottom", "middle", "top"].includes(c.position as string)) throw new SpecError(`captions.position must be bottom, middle or top`);
        for (const k of ["color", "highlight"] as const) {
            if (c[k] !== undefined && !(typeof c[k] === "string" && HEX.test(c[k] as string))) throw new SpecError(`captions.${k} must be a #RRGGBB color`);
        }
    }

    return data as unknown as EditSpec;
}

export function validateTranscript(data: unknown): Transcript {
    if (!isObj(data) || !Array.isArray(data.words)) throw new SpecError(`transcript must be {"words": [{start, end, text}]}`);
    data.words.forEach((w, i) => {
        if (!isObj(w) || !isNum(w.start) || !isNum(w.end) || typeof w.text !== "string") {
            throw new SpecError(`transcript.words[${i}] needs start, end and text`);
        }
    });
    return data as unknown as Transcript;
}

/**
 * A sequence file (`*.sequence.json`) stitches several source videos into
 * one, in order. Each item is cut and zoomed like an edit file; captions and
 * output settings apply to the whole video.
 */
export interface SequenceSpec {
    version: 1;
    kind: "sequence";
    /** The script the order was planned from, relative to this file. Informational. */
    script?: string;
    output?: OutputSpec;
    /** Caption style for every item. Each item uses `<input>.transcript.json` when present. */
    captions?: Omit<CaptionsSpec, "transcript"> | false;
    items: SequenceItem[];
    /** Script lines no clip covered, left by the planner for review. */
    unmatched?: string[];
}

export interface SequenceItem {
    /** Source video, relative to the sequence file. */
    input: string;
    /** Source ranges to keep, ascending. Omit to keep the whole clip. */
    keep?: Range[];
    zooms?: Zoom[];
    /** Label shown in the UI, e.g. the script section. */
    title?: string;
    /** Script text this item covers. */
    script?: string;
    /** How well the transcript matched the script, 0..1. */
    match?: number;
}

export function isSequence(data: unknown): boolean {
    return isObj(data) && data.kind === "sequence";
}

/** Validates a sequence file, reusing the edit-file rules for each item. */
export function validateSequence(data: unknown): SequenceSpec {
    if (!isObj(data)) throw new SpecError("sequence file must be a JSON object");
    if (data.version !== 1) throw new SpecError(`"version" must be 1`);
    if (data.kind !== "sequence") throw new SpecError(`"kind" must be "sequence"`);
    if (!Array.isArray(data.items) || data.items.length === 0) throw new SpecError(`"items" must be a non-empty array`);
    if (data.script !== undefined && typeof data.script !== "string") throw new SpecError(`"script" must be a path`);
    if (data.unmatched !== undefined && !(Array.isArray(data.unmatched) && data.unmatched.every(s => typeof s === "string"))) {
        throw new SpecError(`"unmatched" must be an array of strings`);
    }
    const captions = data.captions === undefined || data.captions === false ? data.captions : { ...(data.captions as object), transcript: "-" };
    // Output and captions are checked through the edit-file rules.
    validateSpec({ version: 1, input: "-", output: data.output, captions });
    data.items.forEach((item, i) => {
        if (!isObj(item)) throw new SpecError(`items[${i}] must be an object`);
        for (const k of ["title", "script"] as const) {
            if (item[k] !== undefined && typeof item[k] !== "string") throw new SpecError(`items[${i}].${k} must be a string`);
        }
        if (item.match !== undefined && !(isNum(item.match) && item.match >= 0 && item.match <= 1)) throw new SpecError(`items[${i}].match must be 0..1`);
        try {
            validateSpec({ version: 1, input: item.input, keep: item.keep, zooms: item.zooms });
        } catch (e) {
            throw new SpecError(`items[${i}]: ${(e as Error).message}`);
        }
    });
    return data as unknown as SequenceSpec;
}
