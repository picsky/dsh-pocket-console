# README visual assets

What goes in this folder, in what order, and how each one is captured. The root
README renders no image today — the commented block it once carried is gone — so
the first insertion point this file fills is a new block in **How it breaks**;
the section names below are the README's current headings.

The rule this whole file follows: **an image has to answer a question the prose
cannot answer faster.** A screenshot of a settings panel answers "what do I have
to configure". A GIF answers "what actually happens when I walk away". Neither
answers the other, and a third one of the same panel answers nothing.

## 1. The distribution: 3 stills + 1 GIF

| # | Asset | The question it answers | Where it goes |
|---|---|---|---|
| 1 | `hero-pairing.png` | "What is this, in one look?" — the same request on the page and on the phone | Under the title, before **Install and uninstall** |
| 2 | `demo.gif` | "Show me the whole loop once" — bind → walk away → approve on the phone → the page settles | A new block under **Install and uninstall** |
| 3 | `phone-questions.png`, `phone-result.png` | "What exactly arrives on my phone?" — two of the card shapes | **Tuning it** |
| 4 | `settings-card.png` | "How much work is setup?" — the panel, the QR | **Install and uninstall**, step 1 |
| 5 | a mermaid block (§7) | "Where does this sit in DSH?" — desktop-first, then the timer | not shipped — add it under **For developers**, where the READMEs' engineering material now lives |

Order matters more than count. #1 buys the reader's next ten seconds; #2 buys the
next minute. If only one thing gets made, make #1. If only two, add #2.

**Everything here is a capture, not a drawing.** Earlier revisions of this folder
carried five hand-drawn SVGs as stand-ins; they were removed, because a drawing of a
panel is a picture of something that does not exist. A real capture cannot be out of
date with the product, and it is not a second thing to maintain.

**What not to do:** six screenshots stacked in a grid. The panel is already
described in prose and a table; a picture of the same panel a fourth time is
decoration, and decoration is what makes a README long and unreadable.

## 2. The hero: one image, the whole thesis

The product's entire argument is a **pairing**: the same request exists on the
page and on the phone, and the desktop is the one you are supposed to use. So the
hero is not a screenshot of a feature. It is two surfaces, one request, one arrow.

```
┌─────────────────────────────┐        ┌──────────────┐
│  DSH Web GUI — the page     │        │  Feishu      │
│                             │        │  on a phone  │
│  ┌───────────────────────┐  │  ───▶  │ ┌──────────┐ │
│  │ Allow once  │ Reject  │  │ 120s   │ │ 批准一次 │ │
│  └───────────────────────┘  │  no    │ │ 拒绝     │ │
│  approval dialog, waiting   │  answer│ └──────────┘ │
└─────────────────────────────┘        └──────────────┘
   answer here and the phone            only reached when
   is never touched                     the desk stayed quiet
```

The arrow's label is the whole design: **"desktop first · phone after 120 s"**.
Without that label the image reads like "we spam your phone", which is the exact
misreading the **What it deliberately does not do** section exists
to correct.

**Build it from two captures, not from a drawing:** the approval dialog on the page, and
the same approval as a Feishu card on the phone. Compose them side by side and put the
relative timing between them. The two surfaces must show **the same request** — the same
tool name and the same reason — or the pairing argument does not land.

## 3. The GIF: the loop, in ≤ 10 seconds

Prefer three of these over one long one. GitHub autoplays GIFs, so a long one is
paid for by every reader on every visit, forever.

**The shot list below is the summary. [`demo-storyboard.md`](demo-storyboard.md)
is the frame-by-frame sheet** — exact frame ranges, crops, cursor actions, the
ffmpeg palette commands and the pre-publish checklist. Record from that file, not
from this table.

| t | Shot | What is on screen | Caption (burned in) |
|---|---|---|---|
| 0.0–0.8 | S1 | Settings card, cursor resting on **Scan to create an app** | `1 · scan once` |
| 0.8–2.3 | S2 | Click → **Creating the Feishu app… the QR code is on its way** | the app, its scopes and the recipient are configured for you |
| 2.3–3.8 | S3 | The QR appears. Hold. **Obscure the QR** | valid for 10 minutes, single use |
| 3.9–6.9 | S4 | Cut to the phone: the card arrives, tap **批准一次** | `2 · desktop first, phone after 120 s` |
| 7.0–9.7 | S5 | Cut back to the page: the panel settles on its own, cursor still | the page follows the phone |

Totals: 194 frames at 20 fps = 9.7 s. Roughly ten seconds is the ceiling — past
that, the GIF costs more attention than the prose it replaces.

Rules for the recording:

- **Hard cuts, no crossfades.** A transition costs frames and reads as padding.
- **Cursor visible, but no cursor wander.** Move once, click once.
- **Nothing waits for a network round trip on camera.** The Feishu QR round trip
  can take seconds; record it, then cut the dead middle out. The card's own
  "still waiting" state is a feature — if you want to show it, show it as a
  still, not as four seconds of a spinner.
- **Keep every frame below the 32 KB card-text budget's visual cousin:** if the card
  body would have been clipped in reality, do not show it unclipped in the GIF.
- **Captions, not narration.** Five short lines total, one per shot, burned in with
  ScreenToGif or ShareX at the same y position in every shot. A GIF has no audio
  and a README has no player, so the caption is the only commentary there is.

If a still tells the story better than the loop, use the still. Three perfect
stills beat one muddy GIF.

## 4. Capture setup

| | Desktop | Phone |
|---|---|---|
| Resolution | 1920 × 1080 or 2560 × 1440, at 100 % browser zoom | default |
| Theme | whatever `dsh web` runs; keep it consistent across every shot | Feishu light theme |
| Window | one browser window, one tab, sized and never resized between shots | the app, no notification shade |
| Region | crop to the card / dialog, **not** the whole desktop | crop to the card, phone chrome optional but consistent |
| Scale | export at 2× then downscale to 1200–1440 px wide | export at 2×, downscale to 800–900 px wide |
| Format | PNG, or SVG for a diagram | PNG / WebP |
| Budget | ≤ 400 KB per still | ≤ 400 KB per still, GIF ≤ 3 MB, hero GIF ≤ 5 MB |

Recording tools that work on Windows, in order of preference:

- **ScreenToGif** — region capture, per-frame editing, and *frame de-duplication*,
  which is the difference between a 3 MB GIF and a 20 MB one. Free, portable.
- **ShareX** — region capture to GIF **or MP4** with annotation. Use it when the
  asset is a video rather than a GIF.
- **ffmpeg** — `mp4 → webp` is the quality-per-byte winner if GitHub's rendering
  is acceptable to you; `mp4 → gif` with a generated palette is the safe fallback.
- **OBS** — only for the phone, or when you need both surfaces at once.

A single recording session, one pass per asset, same window size and theme. Do
not assemble shots from separate sessions: the chrome, the fonts and the DPI will
not match, and the mismatch is what makes a README look assembled rather than
made.

## 5. Privacy, before anything is published

This plugin's whole subject matter is credentials and grants, so the screenshots
are a leak surface. Every one of these is a real story from a real repo:

- **The QR code is a live capability.** It carries the pair `client_id` /
  `client_secret` and is single-use for ten minutes. Blur or cover it in every
  frame, including frames you plan to cut — a cut frame is still in the file.
- **Cover the recipient `open_id`.** It is the identity a card action is
  authorized against. `ou_…` in a screenshot is a permanent, public identifier.
- **Never show a real App Secret.** Even partially. Use a demo tenant and a
  placeholder that is obviously a placeholder (`cli_demo0000000000`).
- **Cover the shell, the path and the hostname.** `/home/<you>/`, `$DSH_HOME`,
  internal hostnames and the browser's URL bar all say more than the screenshot
  needs to.
- **Do not screenshot a real conversation.** Use a throwaway session whose
  prompt is about the README itself, so the transcript is self-evidently demo
  data.
- **Card text is bounded in bytes.** If your demo drives a long `plan-review`
  plan, the card on screen will be a head with a clip mark. That is honest and
  worth one still — but do not crop the clip mark out to make it look complete.

## 6. Cross-surface paths

The root README is read on GitHub **and on npmjs.com**, and the two resolve image paths
differently: npm re-hosts only what the published tarball carries, and `assets/` is not
in `package.json`'s `files` array — deliberately, because a 4 MB package does not need
3 MB of GIF in it. A relative `assets/…` path therefore renders on GitHub and **404s on
the package page**.

**This is settled: every image in a root README uses an absolute url.**

```html
https://raw.githubusercontent.com/picsky/dsh-pocket-console/main/assets/<file>
```

GitHub renders that identically to the relative path, so one form serves both surfaces
and nothing has to be kept in step between them. `npm run check:parity` now enforces
it — a relative `<img src>` in either root README fails the gate — and it applies to the
**commented** insertion point too, so the block is already correct the day it is
uncommented. `cdn.jsdelivr.net/gh/picsky/dsh-pocket-console@main/assets/<file>` is an
equivalent CDN if you ever want one; the `raw.githubusercontent.com` form is used
because it needs no third party.

Two consequences worth knowing:

- **`main`, not a tag.** The url tracks the branch, so a replaced image updates without
  a new url. Using a tag would make each published README immutable, at the cost of
  repointing every url at every release.
- **The image still has to exist on `main`.** A snippet pasted before the asset is
  committed shows a broken image on both surfaces — which is why the GIF's snippet stays
  commented until the GIF exists.

Use the same absolute form in **both** `README.md` (Chinese) and `README.en.md`, in the same
places, so the two languages do not drift.

## 7. The diagrams

**Diagrams are mermaid, not images.** A drawn sequence diagram goes stale the moment a
participant is renamed, and it is a file to keep in step; a mermaid block is text, it
diffs, and GitHub renders it for free. The one diagram that earns its place is the block
below — it shows the two things prose keeps having to re-explain: that the plugin calls
`next()` **first**, and that the phone is reached by a **timer**, not by default. It is
not shipped in either README yet; add it under **For developers**, where the READMEs'
engineering material now lives, beside the sentence that names the two documented
waterfalls the plugin registers on.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant D as DSH harness
  participant P as dsh-pocket-console
  participant W as Desktop GUI
  participant F as Feishu → phone

  A->>D: tool call needs approval
  D->>P: approval/request (prepend: true)
  P->>D: next()  — the rest of the chain runs unchanged
  D->>W: dialog opens and waits
  P->>P: start delaySeconds (default 120 s)
  W-->>P: no answer yet
  Note over P,F: the timer expires
  P->>F: deliver the card
  F-->>P: recipient taps Allow once
  P->>D: resolve allowed-once
  Note over W: the page settles by way of the browser mirror
```

Keep mermaid for what a screenshot cannot hold: ordering, participants, and the
fact that the desktop path is never replaced. Do not draw an architecture diagram
of DSH itself — that belongs upstream, and it goes stale here first.

A `stateDiagram-v2` of the binding states (`unbound → awaiting → starting →
connected | failed`, with `reconnecting` in the middle) is the one other
candidate, and it fits inside **Limitations** or the settings doc — not the root
README.

## 8. Where each capture goes

Both READMEs get the same **pictures in the same places** — a bilingual project whose two
entry points show different screenshots is two projects.

| Asset | English README | Chinese README |
|---|---|---|
| `hero-pairing.png` | after the badges and the unofficial notice | same place |
| `demo.gif` | a new block under **Install and uninstall** | same place |
| `phone-questions.png` | **Tuning it** | same place |
| `phone-result.png` | **Tuning it** | same place |
| `settings-card.png` | **Install and uninstall**, step 1 | same place |
| the mermaid block | not shipped — add it under **For developers** | same place |

A capture is **language-bound**: it shows whatever the deployment was running in. So a
Chinese deployment's screenshots belong in `README.md` and a Chinese card in the
English README is the same mistake as a Chinese diagram there. Two ways out, in order of
preference:

1. **Capture each surface twice**, once with the interface in each language. This is the
   honest pair, and it costs one extra pass in the same session.
2. **Capture once in English** if the pair is not worth the pass, and say so — an English
   screenshot in a Chinese README reads as a screenshot, not as an untranslated string.

`demo.gif` is language-independent: it is a recording of a running deployment, so it
appears in both READMEs as it is.

## 9. Wiring a capture in

Every image in a root README uses an absolute url — §6 says why. The snippets below are
already in that form, so one can be pasted without failing `check:parity`.

**What exists today: nothing.** `demo.gif` and the stills are all still to be captured,
which is why the README's insertion point is still a commented block. The snippet below
is the one to paste *after* recording; pasting it before puts a broken image on the front
page. `npm run check:parity` enforces that: an `<img>` a README actually renders must
resolve, and the commented insertion point is deliberately exempt because a plan is not an
image.

**The existing commented GIF block** — replace the comment with:

```html
<p align="center">
  <img src="https://raw.githubusercontent.com/picsky/dsh-pocket-console/main/assets/demo.gif" alt="Binding from the Settings card, then approving a tool call from the phone" width="720">
</p>
```

**Every other capture** follows the same shape, at the width that suits it:

```html
<p align="center">
  <img src="https://raw.githubusercontent.com/picsky/dsh-pocket-console/main/assets/<file>.png" alt="<what it shows>" width="720">
</p>
```

Set `width` on every one. Markdown image syntax cannot express a width, and an unsized
capture renders at its intrinsic size — often wider than the column.
