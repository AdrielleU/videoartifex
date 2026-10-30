<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="VideoArtifex" width="360">
  </picture>
</p>

# VideoArtifex

**Turn a raw recording into a finished video in minutes with Claude Code.**

Point it at a screen recording or talking-head video. videoartifex cuts the
dead air, zooms in where things happen on screen, and burns in captions that
highlight each word as it's spoken. Edits are plain JSON, so Claude Code can
read the analysis, tweak the plan ("zoom tighter on the settings panel", "keep
the pause after the demo") and re-render, with no timeline editor.

Rendering is a single native ffmpeg pass. There's no Electron app and no cloud
upload. An optional local web editor shows the edit live while Claude works on it.

```bash
npx videoartifex auto demo.mp4
# -> demo.analysis.json, demo.transcript.json, demo.edit.json, demo.edited.mp4
```

## Why VideoArtifex

I wanted to edit demos and tutorials by describing the edit to Claude Code,
not by dragging clips around a timeline. The existing tools I tried got in the
way. Some had licenses that rule out commercial use, so you can't use them for
work or build on them. Others only render inside a browser editor, which is
slow and can't be scripted.

So VideoArtifex is MIT licensed: use it for personal or commercial videos, fork
it, ship it in your own products. It runs as a plain command-line tool on
native ffmpeg, so Claude Code (or a script, or CI) can drive it end to end.

## Requirements

- Node.js 20+
- ffmpeg 6+ with libass (most builds: `brew install ffmpeg`,
  `sudo apt install ffmpeg`, `winget install ffmpeg`)
- For captions: [uv](https://docs.astral.sh/uv/). faster-whisper is installed
  automatically on first use. Or bring your own SRT/VTT with `--transcript`.

Run `npx videoartifex doctor` to check your setup.

## With Claude Code

Install the plugin, then just ask:

```
/plugin marketplace add AdrielleU/videoartifex
/plugin install videoartifex@videoartifex
```

> Edit ~/Desktop/demo.mov: cut the pauses, zoom in on the clicks, add captions,
> and make a vertical version for Shorts.

Claude runs the analysis, writes `demo.edit.json`, renders a fast preview,
looks at frames to check the zooms, then renders the final video.

## Merging clips

Recorded a tutorial in pieces, with a few retakes? Give VideoArtifex the clips
and, optionally, the script you read from:

```bash
videoartifex assemble ./clips --script script.md     # or: videoartifex merge ...
# -> script.sequence.json: clips in script order, best take of each line
videoartifex render script.sequence.json --preview
```

With a script, each line is matched against the transcripts of every clip.
Clips are put in script order and trimmed to the take of each line, the later
one when you recorded it twice. Lines no clip covers are listed so you know
what's missing. Without a script, clips follow their recording time (then
file name), each with its silences cut.

The plan comes first: nothing renders until you've looked at it. Open
`videoartifex ui` to see the plan as a storyboard. Every clip is shown with the
script line it covers and how well the take matched, and you can drag to
reorder, trim, zoom, play the whole thing through, then render. Or ask Claude
Code to adjust it.

## Web editor

```bash
videoartifex ui ~/Videos        # then open http://localhost:17211
```

A local editor for every video and merged video in the folder. **+ Merge
videos** in the sidebar plans a sequence from the clips and a script you
pick. It plays the source with your
edit applied live, so you see and hear the cuts, zooms and captions without
rendering. Use the timeline to cut ranges (`I`, `O`, then `X`), shift-click
words in the transcript to cut a sentence, add a zoom at the playhead (`Z`)
and click the video to aim it, switch to vertical, and render the preview or
the final video.

The edit file stays the source of truth. Every change in the page is saved to
`<name>.edit.json`, and changes made elsewhere (by Claude Code, the CLI or a
text editor) show up in the page within a second. So you can keep the editor
open next to Claude Code, ask for changes in plain words, and fine-tune by
hand. `Ctrl+Z` undoes, including changes that came from disk.

It listens on 127.0.0.1 only. Use `--port` to change the port and
`--host 0.0.0.0` inside Docker.

## Commands

| Command | What it does |
|---|---|
| `videoartifex auto <video>` | Analyze, plan and render in one step. |
| `videoartifex analyze <video>` | Find silences and on-screen activity, transcribe. Writes `<name>.analysis.json`. |
| `videoartifex plan <video>` | Write `<name>.edit.json` from the analysis. |
| `videoartifex render <edit.json or sequence.json>` | Render. `--preview` for a fast 540p draft. |
| `videoartifex frames <video> --at 3,7.5 --grid` | PNG snapshots with a 10x10 grid for picking zoom points. |
| `videoartifex validate <edit.json>` | Check an edit file. |
| `videoartifex assemble <clips or folder> [--script s.md]` | Plan one video from many clips (`merge` works too). Writes `<name>.sequence.json`. |
| `videoartifex ui [folder]` | Web editor at http://localhost:17211 with a live preview. |
| `videoartifex doctor` | Check ffmpeg and transcription. |

Useful options: `--no-cut`, `--no-zoom`, `--no-captions`, `--min-silence 0.8`,
`--pad 0.2`, `--max-zoom 1.8`, `--model small`, `--language en`,
`--transcript subs.srt`. See `videoartifex --help`.

## The edit file

```json
{
  "version": 1,
  "input": "demo.mp4",
  "keep": [{ "start": 0.0, "end": 12.4 }, { "start": 13.9, "end": 41.2 }],
  "zooms": [{ "start": 5.0, "end": 9.5, "x": 0.72, "y": 0.18, "scale": 2.0 }],
  "captions": { "transcript": "demo.transcript.json", "highlight": "#FFD400" },
  "output": { "width": 1080, "height": 1920 }
}
```

Times are always in source-video seconds, so changing the cuts never breaks
the zooms or captions. Full reference: [skills/videoartifex/edit-format.md](skills/videoartifex/edit-format.md).

## How it works

- **Silences:** ffmpeg `silencedetect`. Cuts keep 0.15 s of padding so
  speech isn't clipped, and snap to frame boundaries. Audio is cut on the same
  grid, so picture and sound stay in sync across hundreds of cuts.
- **Auto-zoom:** a tiny grayscale copy of the video is diffed frame by frame
  on a 16x9 grid. Bursts of change confined to part of the screen (typing, a
  menu opening, a dialog) become zoom candidates. Full-screen changes such as
  scrolling or switching apps are ignored. Zooms are rendered with a sub-pixel
  `perspective` crop, so they stay smooth even when slow.
- **Captions:** whisper word timestamps, grouped into short phrases, mapped
  through the cuts, burned in as ASS subtitles.
- **Render:** one ffmpeg command with a single filter graph (no intermediate
  files), x264 `veryfast`.

## License

[MIT](LICENSE). Free for personal and commercial use.
