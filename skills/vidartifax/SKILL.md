---
name: vidartifax
description: Edit a video file with vidartifax (native ffmpeg) - cut silences and dead air, auto-zoom on on-screen activity, burn in word-highlighted captions, make vertical versions. Use when the user asks to edit, trim, tighten, caption, zoom or reformat a screen recording, demo, tutorial or talking-head video file.
allowed-tools: Bash(vidartifax *) Bash(npx -y vidartifax *)
---

# Editing videos with vidartifax

vidartifax works in three steps, each a CLI call: **analyze** the video, **plan**
an edit (`<name>.edit.json`), **render** it. You do the judgment in between:
read the analysis, adjust the edit file, check frames, render.

Run it as `vidartifax` if it's on PATH, otherwise `npx -y vidartifax`. Run
`vidartifax doctor` first if anything fails; ffmpeg is required.

## Workflow

1. **Analyze** (slow part: transcription runs at roughly real-time on CPU):
   ```bash
   vidartifax analyze "<video>"            # add --no-transcript if no captions wanted
   ```
   This writes `<name>.analysis.json` and `<name>.transcript.json` next to the video.

2. **Plan** a first draft:
   ```bash
   vidartifax plan "<video>"               # --no-cut / --no-zoom / --no-captions as asked
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
     vidartifax frames "<video>" --at 12.5,30 --grid
     ```
     Each grid line is 0.1 of the frame, so read `x`/`y` straight off it.
   - Vertical (Shorts/Reels/TikTok): `"output": { "width": 1080, "height": 1920 }`
     and captions `"position": "middle"` or a larger `size` usually look better.
   - Fix misheard words directly in `<name>.transcript.json`.

4. **Validate, preview, render**:
   ```bash
   vidartifax validate "<name>.edit.json"
   vidartifax render "<name>.edit.json" --preview   # fast 540p draft
   vidartifax render "<name>.edit.json"             # final
   ```
   After the preview, snapshot a few output moments with
   `vidartifax frames "<name>.preview.mp4" --at ...` to confirm zooms and
   captions look right before the final render.

5. **Report** the output path, old and new length, number of cuts, zooms and
   captions, and anything you changed from the auto plan and why.

## Notes

- `vidartifax auto "<video>"` does steps 1, 2 and 4 with no review. Use it only
  when the user wants a one-shot result.
- Re-running `analyze` reuses an existing transcript unless `--force` is given.
- Silence threshold: `--noise -40` for quiet recordings, `-30` for noisy ones.
  Shorter pauses: `plan --min-silence 0.4`. More breathing room: `--pad 0.25`.
- The user may have `vidartifax ui` open (http://localhost:17211). It reloads
  `<name>.edit.json` whenever you write it, so your edits appear there live,
  and the user's edits in the page land in the same file: re-read the file
  before changing it instead of relying on an earlier copy. Suggest
  `vidartifax ui "<folder>"` when the user wants to review or fine-tune by hand.
- Never overwrite the source video. Outputs go to `<name>.edited.mp4` by default.
