# VidArtifax

**Turn a raw recording into a finished video in minutes with Claude Code.**

Point it at a screen recording or talking-head video. vidartifax cuts the
dead air, zooms in where things happen on screen, and burns in captions that
highlight each word as it's spoken. Edits are plain JSON, so Claude Code can
read the analysis, tweak the plan ("zoom tighter on the settings panel", "keep
the pause after the demo") and re-render, with no timeline editor.

Rendering is a single native ffmpeg pass. There's no browser, no Electron app
and no cloud upload.

```bash
npx vidartifax auto demo.mp4
# -> demo.analysis.json, demo.transcript.json, demo.edit.json, demo.edited.mp4
```

## Why VidArtifax

I wanted to edit demos and tutorials by describing the edit to Claude Code,
not by dragging clips around a timeline. The existing tools I tried got in the
way. Some had licenses that rule out commercial use, so you can't use them for
work or build on them. Others only render inside a browser editor, which is
slow and can't be scripted.

So VidArtifax is MIT licensed: use it for personal or commercial videos, fork
it, ship it in your own products. It runs as a plain command-line tool on
native ffmpeg, so Claude Code (or a script, or CI) can drive it end to end.

## Requirements

- Node.js 20+
- ffmpeg 6+ with libass (most builds: `brew install ffmpeg`,
  `sudo apt install ffmpeg`, `winget install ffmpeg`)
- For captions: [uv](https://docs.astral.sh/uv/). faster-whisper is installed
  automatically on first use. Or bring your own SRT/VTT with `--transcript`.

Run `npx vidartifax doctor` to check your setup.

## With Claude Code

Install the plugin, then just ask:

```
/plugin marketplace add AdrielleU/vidartifax
/plugin install vidartifax@vidartifax
```

> Edit ~/Desktop/demo.mov: cut the pauses, zoom in on the clicks, add captions,
> and make a vertical version for Shorts.

Claude runs the analysis, writes `demo.edit.json`, renders a fast preview,
looks at frames to check the zooms, then renders the final video.

## Commands

| Command | What it does |
|---|---|
| `vidartifax auto <video>` | Analyze, plan and render in one step. |
| `vidartifax analyze <video>` | Find silences and on-screen activity, transcribe. Writes `<name>.analysis.json`. |
| `vidartifax plan <video>` | Write `<name>.edit.json` from the analysis. |
| `vidartifax render <edit.json>` | Render. `--preview` for a fast 540p draft. |
| `vidartifax frames <video> --at 3,7.5 --grid` | PNG snapshots with a 10x10 grid for picking zoom points. |
| `vidartifax validate <edit.json>` | Check an edit file. |
| `vidartifax doctor` | Check ffmpeg and transcription. |

Useful options: `--no-cut`, `--no-zoom`, `--no-captions`, `--min-silence 0.8`,
`--pad 0.2`, `--max-zoom 1.8`, `--model small`, `--language en`,
`--transcript subs.srt`. See `vidartifax --help`.

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
the zooms or captions. Full reference: [skills/vidartifax/edit-format.md](skills/vidartifax/edit-format.md).

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
