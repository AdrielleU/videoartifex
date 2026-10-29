# Edit file format (`*.edit.json`)

An edit file describes how to cut, zoom and caption one source video.
`videoartifex plan` writes a first draft; you (or Claude) adjust it; `videoartifex
render` turns it into an MP4.

**All times are seconds in the source video.** Change the cuts and the
zooms and captions still line up, because the renderer maps everything onto
the output timeline for you.

```json
{
  "version": 1,
  "input": "demo.mp4",
  "keep": [
    { "start": 0.0, "end": 12.4 },
    { "start": 13.9, "end": 41.2 }
  ],
  "zooms": [
    { "start": 5.0, "end": 9.5, "x": 0.72, "y": 0.18, "scale": 2.0 }
  ],
  "captions": { "transcript": "demo.transcript.json" }
}
```

## Fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. |
| `input` | yes | Source video, relative to the edit file. |
| `keep` | no | Source ranges to keep, ascending and non-overlapping. Everything else is cut. Omit to keep the whole video. |
| `zooms` | no | Zoom-ins, see below. |
| `captions` | no | Burned-in captions, see below. `false` or omitted = none. |
| `output` | no | Output settings, see below. |

### `keep`

`[{ "start": 0, "end": 12.4 }, ...]`. To cut a section, end one range where
the cut starts and start the next where it ends. Boundaries snap to the
nearest frame. Ranges that touch are merged.

### `zooms`

| Field | Default | Meaning |
|---|---|---|
| `start`, `end` | required | When the zoom happens (source time). Zooming in and out both happen inside this window. |
| `x`, `y` | required | Point to zoom toward, as a fraction of the frame: `0,0` is top left, `1,1` bottom right. |
| `scale` | required | Magnification, `1`–`4`. `1.5`–`2.2` reads well for screen recordings. |
| `ease` | `0.4` | Seconds spent zooming in, and again zooming out. |

Zooms must not overlap. Near the edges the crop is clamped to stay inside the
frame, so `x: 0.95` zooms into the right edge without showing black.

A zoom that spans a cut stays one continuous zoom in the output. Parts of a
zoom that fall entirely in cut sections are dropped.

### `captions`

| Field | Default | Meaning |
|---|---|---|
| `transcript` | required | Transcript JSON (see below), relative to the edit file. |
| `maxWords` | `4` | Words per caption. |
| `maxChars` | `28` | Characters per caption. |
| `position` | `"bottom"` | `bottom`, `middle` or `top`. |
| `size` | `0.055` | Font size as a fraction of the output height. |
| `font` | `"Arial"` | Any installed font. A similar font is used if it's missing. |
| `color` | `"#FFFFFF"` | Text color. |
| `highlight` | `"#FFD400"` | Color of the word being spoken. Make it equal to `color` to turn it off. |
| `uppercase` | `false` | |

Captions break at sentence ends and at pauses longer than 0.6 s. Words whose
middle falls in a cut section are dropped.

### `output`

| Field | Default | Meaning |
|---|---|---|
| `path` | `<input>.edited.mp4` | Relative to the edit file. |
| `width`, `height` | source size | Output frame. The video is fit inside and the rest is black, e.g. `1080`×`1920` for vertical. Zoom and captions apply to the fitted video. |
| `fps` | source, rounded | One of 24, 25, 30, 50, 60. |
| `crf` | `20` | x264 quality. Lower is better and bigger; 18–24 is sensible. |

`videoartifex render --preview` ignores `path`, renders at 540p and writes
`<input>.preview.mp4`.

## Transcript format (`*.transcript.json`)

```json
{
  "language": "en",
  "words": [
    { "start": 0.42, "end": 0.71, "text": "Hello" },
    { "start": 0.75, "end": 1.10, "text": "everyone." }
  ]
}
```

Times are source seconds. `videoartifex analyze` writes this with whisper. You can
also edit it to fix misheard words before rendering.

## Analysis file (`*.analysis.json`)

Written by `videoartifex analyze`, read by `videoartifex plan`. Useful when editing
by hand:

- `media`: duration, size, fps, whether there is audio.
- `silences`: silent ranges (`noise` dB threshold, default -35).
- `activity`: bursts of on-screen change in part of the frame, with a
  bounding box `{x0, y0, x1, y1}` (fractions) and an `energy` score. Typing,
  menus opening and dialogs appearing show up here; scrolling and full-screen
  changes don't.
- `transcript`: path to the transcript, if any.

## Sequence file (`*.sequence.json`)

A sequence stitches several clips into one video. `videoartifex assemble` (or
its alias `merge`) writes one; `videoartifex render` renders it like an edit
file.

```json
{
  "version": 1,
  "kind": "sequence",
  "script": "script.md",
  "captions": { "position": "bottom" },
  "output": { "width": 1920, "height": 1080 },
  "items": [
    { "input": "intro.mp4", "title": "Intro", "keep": [{ "start": 1.1, "end": 5.5 }] },
    { "input": "takes.mp4", "title": "Install", "keep": [{ "start": 9.6, "end": 12.9 }],
      "zooms": [{ "start": 10, "end": 12, "x": 0.3, "y": 0.4, "scale": 1.8 }],
      "script": "To install it, open a terminal and run npm install.", "match": 0.96 }
  ],
  "unmatched": ["Wrap up: Don't forget to subscribe."]
}
```

| Field | Meaning |
|---|---|
| `kind` | Always `"sequence"`. |
| `items` | Clips in playing order. The same video can appear more than once with different `keep` ranges. |
| `items[].input` | Source video, relative to the sequence file. |
| `items[].keep`, `items[].zooms` | Same as in an edit file, in that clip's source seconds. Omit `keep` to use the whole clip. |
| `items[].title`, `items[].script`, `items[].match` | Labels from the planner: script section, the lines this item covers, and how closely the take matched (0..1). Informational. |
| `captions` | Caption style (edit-file `captions` without `transcript`) for every item, or `false`. Each item uses `<input>.transcript.json` if it exists. |
| `output` | As in an edit file, for the whole video. Defaults to the first clip's size. |
| `script` | The script the plan came from. Informational. |
| `unmatched` | Script lines no clip covered. Informational; the renderer ignores it. |

Output goes to `<name>.edited.mp4` (`<name>.preview.mp4` with `--preview`)
next to the sequence file.

### How the planner reads a script

Markdown or plain text. `#` headings become section titles; each sentence is
one line to find. Text in `[square brackets]` is a direction, not speech, and
is ignored. Each line is matched against every clip's transcript, word by
word, tolerating filler and misheard words; when a line was recorded more
than once, the later take wins. Consecutive lines from the same take become
one item, and long pauses inside them are cut.
