---
name: videoartifex
description: Edit a video file with videoartifex (native ffmpeg) - cut silences and dead air, auto-zoom on on-screen activity, burn in word-highlighted captions, make vertical versions. Use when the user asks to edit, trim, tighten, caption, zoom or reformat a screen recording, demo, tutorial or talking-head video file.
allowed-tools: Bash(videoartifex *) Bash(npx -y videoartifex *)
---

# Editing videos with videoartifex

videoartifex works in three steps, each a CLI call: **analyze** the video, **plan**
an edit (`<name>.edit.json`), **render** it. You do the judgment in between:
read the analysis, adjust the edit file, check frames, render.

Run it as `videoartifex` if it's on PATH, otherwise `npx -y videoartifex`. Run
`videoartifex doctor` first if anything fails; ffmpeg is required.

## Workflow

1. **Analyze** (slow part: transcription runs at roughly real-time on CPU):
   ```bash
   videoartifex analyze "<video>"            # add --no-transcript if no captions wanted
   ```
   This writes `<name>.analysis.json` and `<name>.transcript.json` next to the video.

2. **Plan** a first draft:
   ```bash
   videoartifex plan "<video>"               # --no-cut / --no-zoom / --no-captions as asked
   ```

3. **Review and adjust `<name>.edit.json`** against what the user asked for.
   Read [edit-format.md](edit-format.md) next to this skill for every field. Key rules:
   - All times are **source** seconds. `keep` ranges are ascending and don't overlap.
   - Read the transcript to place cuts at sentence boundaries, remove retakes
     ("let me try that again"), filler, or off-topic parts when asked.
   - Zooms: `x`/`y` are 0..1 fractions of the frame, `scale` 1.5–2.2 is
     typical, zooms must not overlap. Auto-zoom is a heuristic; drop zooms on
     unimportant moments and add zooms where the narration points at something
     ("click Settings", "this button").
   - To check a zoom target, snapshot frames with a grid and look at them:
     ```bash
     videoartifex frames "<video>" --at 12.5,30 --grid
     ```
     Each grid line is 0.1 of the frame, so read `x`/`y` straight off it.
   - Vertical (Shorts/Reels/TikTok): `"output": { "width": 1080, "height": 1920 }`
     and captions `"position": "middle"` or a larger `size` usually look better.
   - Fix misheard words directly in `<name>.transcript.json`.

4. **Validate, preview, render**:
   ```bash
   videoartifex validate "<name>.edit.json"
   videoartifex render "<name>.edit.json" --preview   # fast 540p draft
   videoartifex render "<name>.edit.json"             # final
   ```
   After the preview, snapshot a few output moments with
   `videoartifex frames "<name>.preview.mp4" --at ...` to confirm zooms and
   captions look right before the final render.

5. **Report** the output path, old and new length, number of cuts, zooms and
   captions, and anything you changed from the auto plan and why.

## Merging several clips (assemble / merge)

When the user has several recordings to combine into one video (takes,
chapters, separate clips), plan a sequence first and show it before
rendering:

1. If they have a script (or describe the order), save it as Markdown with a
   `#` heading per section and run
   ```bash
   videoartifex assemble <clips or folder> --script script.md   # `merge` is the same command
   ```
   Without a script, `videoartifex assemble <clips>` orders by recording time.
2. Read the printed plan and `<name>.sequence.json`. Each item has the
   section `title`, the `script` lines it covers and a `match` score. Check
   low matches (< 0.8) against the transcripts, and tell the user which
   `unmatched` script lines no clip covers.
3. Show the plan to the user (a short numbered list: section, clip, length)
   and mention `videoartifex ui` to see it as a storyboard. Apply their changes
   to the sequence file: reorder `items`, trim `keep`, add zooms. All times
   are in each clip's own source seconds.
4. `videoartifex render <name>.sequence.json --preview`, then the final render.

The sequence format is in [edit-format.md](edit-format.md#sequence-file-sequencejson).

## Music and beat-cut clips (beats / trim)

For music, or any cut that should land on the beat (a loop, a sample, a
short clip "from about 9.5 to 12.8 s"):

```bash
videoartifex beats "<video>" --from 9.5 --to 12.8   # snaps the range, lists beats near it
videoartifex trim "<video>" --from 9.5 --to 12.8 --beats -o "<name>-beat.mp4"
```

`beats` writes `<name>.beats.json` (tempo, and each beat's time and
`strength` from 0 to 1) and reuses it afterwards. Quiet beats (strength near
0) are usually a break or the gap before a drop: good places to end a clip so
it holds a whole phrase. If the snapped range cuts a phrase short, move an end
by a beat and say so. `trim -o clip.mp4` renders the range as a new clip,
which then shows up as a video of its own. Without `-o`, `trim` changes the
video's own `<name>.edit.json`, keeping its zooms and captions.

Never save an edit as `<other>.edit.json` when `<other>.mp4` exists or will
be rendered: the editor reads `<other>.edit.json` as that video's edit.

## Notes

- `videoartifex auto "<video>"` does steps 1, 2 and 4 with no review. Use it only
  when the user wants a one-shot result.
- Re-running `analyze` reuses an existing transcript unless `--force` is given.
- Silence threshold: `--noise -40` for quiet recordings, `-30` for noisy ones.
  Shorter pauses: `plan --min-silence 0.4`. More breathing room: `--pad 0.25`.
- The user may have `videoartifex ui` open (http://localhost:17211). It reloads
  `<name>.edit.json` whenever you write it, so your edits appear there live,
  and the user's edits in the page land in the same file: re-read the file
  before changing it instead of relying on an earlier copy. Suggest
  `videoartifex ui "<folder>"` when the user wants to review or fine-tune by hand.
- Never overwrite the source video. Outputs go to `<name>.edited.mp4` by default.
