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
