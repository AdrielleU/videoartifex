import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startUi } from "../src/ui/server.ts";

test("ui lists videos, saves only valid edits, and stays inside its folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "videoartifex-ui-"));
    writeFileSync(join(dir, "a.mp4"), "not really a video");
    writeFileSync(join(dir, "a.edited.mp4"), "output");
    const ui = await startUi({ dir, port: 0 });
    try {
        const list = await (await fetch(`${ui.url}/api/videos`)).json() as { videos: { name: string; edited: boolean }[] };
        assert.deepEqual(list.videos.map(v => [v.name, v.edited]), [["a.mp4", true]]);

        const put = (body: unknown) => fetch(`${ui.url}/api/edit?v=a.mp4`, { method: "PUT", body: JSON.stringify(body) });
        const bad = await put({ version: 1, input: "a.mp4", zooms: [{ start: 0, end: 1, x: 2, y: 0, scale: 2 }] });
        assert.equal(bad.status, 400);
        assert.match(((await bad.json()) as { error: string }).error, /zooms\[0\]\.x/);
        assert.equal((await put({ version: 1, input: "a.mp4", keep: [{ start: 0, end: 1 }] })).status, 200);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, "a.edit.json"), "utf8")).keep, [{ start: 0, end: 1 }]);

        assert.equal((await fetch(`${ui.url}/file/..%2Fetc%2Fpasswd`)).status, 400);
        const ranged = await fetch(`${ui.url}/file/a.mp4`, { headers: { Range: "bytes=4-9" } });
        assert.equal(ranged.status, 206);
        assert.equal(await ranged.text(), "really");
        assert.match(await (await fetch(`${ui.url}/lib/zoom.ts`)).text(), /export function zoomAt/);
    } finally {
        ui.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ui uploads without overwriting and won't render another video's edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "videoartifex-ui-"));
    writeFileSync(join(dir, "a.mp4"), "source");
    const ui = await startUi({ dir, port: 0 });
    try {
        const up = (name: string) => fetch(`${ui.url}/api/upload?name=${encodeURIComponent(name)}`, { method: "PUT", body: "clip" });
        assert.equal(((await (await up("a.mp4")).json()) as { name: string }).name, "a-2.mp4");
        assert.equal(readFileSync(join(dir, "a.mp4"), "utf8"), "source");
        assert.equal(((await (await up("../b.mp4")).json()) as { name: string }).name, "b.mp4");
        assert.equal((await up("x.sh")).status, 400);
        assert.equal((await up("a.edited.mp4")).status, 400);

        // a-2.edit.json rendering a-2.mp4 from a.mp4 belongs to a.mp4's output, not to a-2.mp4.
        writeFileSync(join(dir, "a-2.edit.json"), JSON.stringify({ version: 1, input: "a.mp4", keep: [{ start: 9, end: 12 }] }));
        const run = await fetch(`${ui.url}/api/run?v=a-2.mp4&action=preview`, { method: "POST", body: "{}" });
        assert.equal(run.status, 409);
        assert.match(((await run.json()) as { error: string }).error, /edit for a\.mp4/);
    } finally {
        ui.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
