import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, outputDuration, rangeToOutput, selectExpr, toOutput } from "../src/timeline.ts";
import { keepFromSilences, parseSilences } from "../src/analyze/silence.ts";
import { buildAss, groupCues, wordsToOutput } from "../src/captions.ts";
import { validateSpec, SpecError } from "../src/spec.ts";
import { zoomAt, zoomFilter, zoomsToOutput } from "../src/zoom.ts";
import { findEvents } from "../src/analyze/activity.ts";
import { subtitlesToWords } from "../src/analyze/transcribe.ts";
import { zoomsFromActivity } from "../src/plan.ts";
import { buildGraph, pickFps } from "../src/render.ts";
import { snapToBeat } from "../src/analyze/beats.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("timeline snaps to frames and maps times", () => {
    const segs = buildTimeline([{ start: 1.01, end: 2 }, { start: 3, end: 4.49 }], 10, 10);
    assert.deepEqual(segs.map(s => [s.start, s.end, s.outStart]), [[1, 2, 0], [3, 4.5, 1]]);
    close(outputDuration(segs), 2.5);
    close(toOutput(segs, 3.25)!, 1.25);
    assert.equal(toOutput(segs, 2.5), null);
});

test("timeline merges touching ranges and clamps to duration", () => {
    const segs = buildTimeline([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 9, end: 20 }], 10, 30);
    assert.deepEqual(segs.map(s => [s.start, s.end, s.outStart]), [[0, 2, 0], [9, 10, 2]]);
});

test("a range spanning a cut maps to one continuous output range", () => {
    const segs = buildTimeline([{ start: 0, end: 2 }, { start: 5, end: 8 }], 10, 10);
    assert.deepEqual(rangeToOutput(segs, { start: 1, end: 6 }), [{ start: 1, end: 3 }]);
    assert.deepEqual(rangeToOutput(segs, { start: 2.5, end: 4 }), []);
});

test("select expression keeps exactly the frames of each segment", () => {
    const fps = 30;
    const segs = buildTimeline([{ start: 1, end: 2 }, { start: 4, end: 4.5 }], 10, fps);
    const expr = selectExpr(segs, fps);
    const ranges = [...expr.matchAll(/between\(t,([\d.]+),([\d.]+)\)/g)].map(m => [Number(m[1]), Number(m[2])] as const);
    let kept = 0;
    for (let k = 0; k < 10 * fps; k++) {
        const t = k / fps;
        if (ranges.some(([a, b]) => t >= a && t <= b)) kept++;
    }
    assert.equal(kept, Math.round(outputDuration(segs) * fps));
});

test("silencedetect output parses, including a silence open at EOF", () => {
    const log = [
        "[silencedetect @ 0x1] silence_start: 1.5",
        "[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75",
        "[silencedetect @ 0x1] silence_start: 9.1",
    ].join("\n");
    assert.deepEqual(parseSilences(log, 10), [{ start: 1.5, end: 3.25 }, { start: 9.1, end: 10 }]);
});

test("keep ranges leave padding and drop short silences", () => {
    const keep = keepFromSilences([{ start: 0, end: 1 }, { start: 3, end: 3.3 }, { start: 5, end: 7 }, { start: 9, end: 10 }], 10, { pad: 0.2 });
    assert.deepEqual(keep, [{ start: 0.8, end: 5.2 }, { start: 6.8, end: 9.2 }]);
});

test("words map through cuts and group into cues", () => {
    const segs = buildTimeline([{ start: 0, end: 2 }, { start: 4, end: 6 }], 6, 10);
    const words = wordsToOutput([
        { start: 0.1, end: 0.4, text: "Hello" },
        { start: 0.5, end: 0.9, text: "world." },
        { start: 2.5, end: 3, text: "cut" },
        { start: 4.1, end: 4.5, text: "Next" },
        { start: 4.6, end: 5, text: "part" },
    ], segs);
    assert.deepEqual(words.map(w => w.text), ["Hello", "world.", "Next", "part"]);
    close(words[2]!.start, 2.1);
    const cues = groupCues(words, 4, 28);
    assert.deepEqual(cues.map(c => c.words.map(w => w.text).join(" ")), ["Hello world.", "Next part"]);
});

test("ASS output highlights one word per event and escapes markup", () => {
    const cues = groupCues([{ start: 0, end: 0.5, text: "a{b}" }, { start: 0.5, end: 1, text: "c" }], 4, 28);
    const ass = buildAss(cues, { transcript: "x", highlight: "#FF0000" }, 1920, 1080);
    const events = ass.split("\n").filter(l => l.startsWith("Dialogue:"));
    assert.equal(events.length, 2);
    assert.match(events[0]!, /\{\\c&H000000FF&\}ab\{\\r\} c$/);
    assert.match(ass, /PlayResY: 1080/);
});

test("spec validation names the bad field", () => {
    const ok = { version: 1, input: "a.mp4" };
    assert.doesNotThrow(() => validateSpec(ok));
    const bad: [unknown, RegExp][] = [
        [{ ...ok, keep: [{ start: 2, end: 1 }] }, /keep\[0\]/],
        [{ ...ok, keep: [{ start: 0, end: 2 }, { start: 1, end: 3 }] }, /ascending/],
        [{ ...ok, zooms: [{ start: 0, end: 1, x: 2, y: 0.5, scale: 2 }] }, /zooms\[0\]\.x/],
        [{ ...ok, zooms: [{ start: 0, end: 2, x: 0.5, y: 0.5, scale: 2 }, { start: 1, end: 3, x: 0.5, y: 0.5, scale: 2 }] }, /overlap/],
        [{ ...ok, captions: { transcript: "t.json", color: "white" } }, /captions\.color/],
        [{ ...ok, output: { width: 100 } }, /go together/],
    ];
    for (const [spec, re] of bad) assert.throws(() => validateSpec(spec), (e: Error) => e instanceof SpecError && re.test(e.message));
});

test("zoom curve eases in, holds, and clamps the crop inside the frame", () => {
    const zooms = [{ start: 1, end: 3, x: 0.95, y: 0.5, scale: 2, ease: 0.5 }];
    assert.equal(zoomAt(zooms, 0.5).scale, 1);
    close(zoomAt(zooms, 1.25).scale, 1.5);
    const hold = zoomAt(zooms, 2);
    close(hold.scale, 2);
    close(hold.left, 0.5); // focus near the right edge: crop pinned to the edge
    close(hold.top, 0.25);
    const f = zoomFilter(zooms, 30)!;
    assert.match(f, /^perspective=x0='/);
    assert.equal((f.match(/st\(9,in\/30\)/g) ?? []).length, 8);
});

test("zooms spanning a cut follow the output timeline", () => {
    const segs = buildTimeline([{ start: 0, end: 2 }, { start: 5, end: 8 }], 10, 10);
    const z = zoomsToOutput([{ start: 1, end: 6, x: 0.5, y: 0.5, scale: 2 }], segs);
    assert.deepEqual(z.map(x => [x.start, x.end]), [[1, 3]]);
});

test("activity: local bursts become events, full-screen changes don't", () => {
    const cells = (active: number[]) => {
        const c = new Float32Array(144);
        for (const i of active) c[i] = 20;
        return c;
    };
    const frames = [
        { t: 0.2, cells: cells([17, 18]) },
        { t: 0.4, cells: cells([18, 34]) },
        { t: 0.6, cells: cells(Array.from({ length: 100 }, (_, i) => i)) },
        { t: 3.0, cells: cells([140]) },
    ];
    const ev = findEvents(frames);
    assert.equal(ev.length, 2);
    assert.deepEqual(ev[0]!.box, { x0: 1 / 16, y0: 1 / 9, x1: 3 / 16, y1: 3 / 9 });
    close(ev[0]!.start, 0);
    close(ev[0]!.end, 0.4);
});

test("auto-zoom picks the strongest events and spaces them out", () => {
    const box = { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 };
    const zooms = zoomsFromActivity([
        { start: 1, end: 1.5, box, energy: 100 },
        { start: 2, end: 2.5, box, energy: 500 },
        { start: 10, end: 11, box: { x0: 0, y0: 0, x1: 0.9, y1: 0.9 }, energy: 900 },
    ], 20);
    assert.equal(zooms.length, 1);
    close(zooms[0]!.start, 1.6);
    close(zooms[0]!.scale, 2.2);
});

test("auto-zoom skips events that land in cut footage", () => {
    const box = { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };
    const events = [{ start: 3, end: 4, box, energy: 500 }, { start: 10, end: 11, box, energy: 100 }];
    const keep = [{ start: 0, end: 2 }, { start: 9, end: 15 }];
    assert.deepEqual(zoomsFromActivity(events, 20, 2.2, keep).map(z => z.start), [9.6]);
});

test("SRT import spreads words across each cue", () => {
    const words = subtitlesToWords("1\n00:00:01,000 --> 00:00:02,000\nab cd\n\n2\n00:00:03.000 --> 00:00:04.000\n<i>x</i>\n");
    assert.deepEqual(words.map(w => [w.text, w.start, w.end]), [["ab", 1, 1.5], ["cd", 1.5, 2], ["x", 3, 4]]);
});

test("fps choice keeps audio blocks a whole number of samples", () => {
    assert.equal(pickFps(undefined, 29.97, false), 30);
    assert.equal(pickFps(undefined, 59.94, true), 30);
    assert.equal(pickFps(undefined, 23.976, false), 24);
    assert.throws(() => pickFps(29, 30, false));
});

test("graph wires cuts, zoom, padding and captions in order", () => {
    const segments = buildTimeline([{ start: 1, end: 2 }], 5, 30);
    const g = buildGraph({ segments, fps: 30, vw: 1280, vh: 720, width: 1080, height: 1920, zoom: "perspective=X", assFile: "captions.ass", hasAudio: true });
    const v = g.split(";\n")[0]!;
    assert.ok(v.indexOf("select=") < v.indexOf("perspective=X"));
    assert.ok(v.indexOf("perspective=X") < v.indexOf("pad=1080:1920"));
    assert.ok(v.indexOf("pad=") < v.indexOf("subtitles=filename=captions.ass"));
    assert.match(g, /asetnsamples=n=1600:p=0/);
});

test("snapToBeat picks the nearest beat", () => {
    const b = { tempo: 161.5, beats: [{ t: 9.381, strength: 0.2 }, { t: 9.752, strength: 0 }, { t: 12.376, strength: 0.2 }, { t: 12.748, strength: 0 }] };
    assert.equal(snapToBeat(b, 9.5), 9.381);
    assert.equal(snapToBeat(b, 12.8), 12.748);
    assert.equal(snapToBeat({ tempo: 0, beats: [] }, 3), 3);
});
