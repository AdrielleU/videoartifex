import assert from "node:assert/strict";
import { test } from "node:test";
import { alignLine, parseScript, planSequence, tokens, type Clip } from "../src/assemble.ts";
import type { Analysis } from "../src/plan.ts";
import { SpecError, validateSequence } from "../src/spec.ts";

const clip = (input: string, text: string, opts: { start?: number; gap?: number; time?: number } = {}): Clip => {
    let t = opts.start ?? 0.5;
    const words = text.split(" ").map(w => {
        const word = { start: t, end: t + 0.3, text: w };
        t += 0.3 + (opts.gap ?? 0.1);
        return word;
    });
    const analysis: Analysis = {
        version: 1,
        input,
        media: { duration: t + 0.5, width: 1280, height: 720, fps: 30, hasAudio: true },
        silences: [],
        activity: [],
        transcript: input.replace(".mp4", ".transcript.json"),
    };
    return { input, analysis, words, time: opts.time ?? 0 };
};

test("script parsing: headings are sections, directions are dropped, sentences split", () => {
    const lines = parseScript("# Intro\nHi there. I'm **Sam**!\n\n## Setup\n[show terminal]\n- Run npm install.\n");
    assert.deepEqual(lines.map(l => [l.section, l.text]), [["Intro", "Hi there."], ["Intro", "I'm Sam!"], ["Setup", "Run npm install."]]);
    assert.deepEqual(tokens("Don't stop, run TWO apps"), ["dont", "stop", "run", "2", "apps"]);
});

test("alignment finds a line inside a transcript despite filler and misheard words", () => {
    const words = tokens("um so today we will uh build a small video tool okay");
    const a = alignLine(tokens("Today we will build a small video app."), words)!;
    assert.deepEqual([words[a.first], words[a.last], a.before, a.after], ["today", "video", 0, 1]);
    assert.ok(a.score > 0.6 && a.score < 1, String(a.score));
});

test("a misheard last word is still kept in the clip", () => {
    const c = clip("a.mp4", "so today we build a video tool and then");
    const { sequence } = planSequence([c], parseScript("Today we build a video app."), { cutSilences: false });
    const tool = c.words[6]!;
    assert.ok(sequence.items[0]!.keep![0]!.end >= tool.end, JSON.stringify(sequence.items[0]!.keep));
    assert.ok(sequence.items[0]!.keep![0]!.end < c.words[7]!.start + 0.2);
});

test("script plan picks the last good take and keeps script order", () => {
    const takes = clip("b.mp4", "to install it run the wrong thing let me try that again to install it run npm install", { time: 2 });
    const intro = clip("a.mp4", "hello and welcome to the demo", { time: 1 });
    const script = parseScript("# Intro\nHello and welcome to the demo.\n# Install\nTo install it, run npm install.\nNow subscribe.");
    const { sequence } = planSequence([takes, intro], script);
    assert.deepEqual(sequence.items.map(i => [i.input, i.title]), [["a.mp4", "Intro"], ["b.mp4", "Install"]]);
    const install = sequence.items[1]!;
    const second = takes.words.findIndex((w, i) => i > 2 && w.text === "to");
    assert.ok(install.keep![0]!.start >= takes.words[second]!.start - 0.2, JSON.stringify(install.keep));
    assert.deepEqual(sequence.unmatched, ["Install: Now subscribe."]);
    assert.deepEqual(sequence.captions, {});
    validateSequence(sequence);
});

test("without a script, clips follow recording time then name", () => {
    const { sequence } = planSequence([clip("b.mp4", "two", { time: 5 }), clip("c.mp4", "three", { time: 9 }), clip("a.mp4", "one", { time: 5 })], null);
    assert.deepEqual(sequence.items.map(i => i.input), ["a.mp4", "b.mp4", "c.mp4"]);
});

test("sequence validation reports the item that's wrong", () => {
    assert.throws(() => validateSequence({ version: 1, kind: "sequence", items: [] }), SpecError);
    assert.throws(
        () => validateSequence({ version: 1, kind: "sequence", items: [{ input: "a.mp4" }, { input: "b.mp4", keep: [{ start: 3, end: 1 }] }] }),
        /items\[1\]: keep\[0\]/,
    );
    assert.throws(() => validateSequence({ version: 1, kind: "sequence", captions: { color: "red" }, items: [{ input: "a.mp4" }] }), /captions.color/);
});
