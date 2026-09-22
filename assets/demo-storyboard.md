# demo.gif — frame-by-frame sheet

The shot list in [README.md](README.md) says *what* happens. This file says
*which frames*, so the recording can be made in one pass and exported once.

## Output spec

| | |
|---|---|
| Canvas | 1280 × 720 |
| Frame rate | 20 fps (GIF has no audio and no motion blur; 20 is enough for a cursor and halves the file vs 30+) |
| Duration | 194 frames = **9.7 s** |
| Caption band | fixed at `y = 632`, height 34 px, black at 55 % opacity, white centred text at 14 px |
| Target size | **≤ 2.5 MB**, hard cap 3 MB |
| Format | GIF. Keep a WebP build beside it and compare bytes after the first push (below) |

## Shots

Five separate recordings, not one take. Record each, then join. A five-shot
recording means a bad shot costs one clip, and it means the phone never has to be
in the same frame as the desktop.

### S1 — f0–f15 (0.80 s) · Settings card, unbound

- **Source:** desktop. Crop to the *Pocket console* card only: x 0–700, y 60–760 of
  the settings page. No browser chrome — the URL bar is a privacy leak and adds
  nothing.
- **On screen:** card title, description, `Not bound` chip, `Scan to create an app`
  (primary, blue) / `Use an existing app`, the two guide lines, `Escalation`, and
  the `Pending` block.
- **Cursor:** already resting on the centre of the blue button at f0. No movement.
  The button's own hover state is the only change in the shot.
- **Caption:** `1 · 扫一次码` / `1 · scan once`
- **Do not:** show the mouse travelling to the button. Two frames of travel read as
  latency.

### S2 — f16–f45 (1.50 s) · Click → waiting state

- **Source:** same crop, same session, no window resize.
- **On screen:** click at f18; by f24 the card shows
  `Creating the Feishu app… the QR code is on its way`, and the buttons are
  disabled/busy. Hold that state to the end of the shot.
- **Cursor:** one click, then park off the card (bottom-right of the crop) so it is
  not sitting on a disabled control.
- **Caption:** `应用、权限、接收人一次配好` / `the app, its scopes and the recipient are configured for you`
- **Why this shot exists:** it is the honest version of "one scan". The wait is a
  round trip to Feishu; showing the card *announce* the wait is the feature.

### S3 — f46–f75 (1.50 s) · The QR code appears

- **Source:** same crop. This is the tail of the same attempt, not a new one.
- **On screen:** `Scan this code with Feishu to finish binding. The link is valid
  for 10 minutes and can be used once.` plus the QR image.
- **Censor:** the QR **must** be obscured — a 60 × 60 px opaque block over the
  centre is enough to make it unscannable while still reading as a QR code. It
  carries the `client_id` / `client_secret` pair and is valid for ten minutes.
- **Hold:** the code is on screen for the full 1.50 s. Do not pan or zoom.
- **Caption:** `二维码：10 分钟、仅可使用一次` / `valid for 10 minutes, single use`
- **Cut out:** everything between the click and the code arriving. That gap is
  seconds of a spinner and belongs in neither a GIF nor the reader's attention.

### S4 — f78–f138 (3.05 s) · Phone: the card arrives, one tap

- **Source:** phone, screen-recorded in Feishu. Crop to the card, keep the phone
  chrome but keep it *identical* across S4 and any still you take from the same
  session.
- **On screen:** the bot chat, then the approval card arriving:
  - title `工具审批` (with `titlePrefix` if you set one — set it for the recording
    so the demo matches the docs)
  - `桌面 120 秒内未应答，已升级到手机。批准仅对本次调用生效。`
  - `工具` + the command in a code box, `调用 ID`, `原因`
  - `拒绝` and `批准一次`
  - Buttons are thumb-anchored at the bottom of the card; keep the card's real
    proportions rather than resizing it to fill the frame.
- **Notifier:** the Feishu push banner, if it arrives, is welcome — it is the
  product's actual delivery path. Keep it for ≤ 8 frames at the start of the shot.
  If it is flaky, cut it; do not fake it.
- **Action:** the card arrives at f78; by f86 the cursor is on `批准一次`; tap at
  f92; the card settles to `已批准（仅本次）` and holds to f138.
- **Caption:** `2 · 桌面优先，120 秒后才到手机` / `2 · desktop first, phone after 120 s`
- **Do not:** show the 120-second wait. The timer is *told*, not shown — a 120 s
  shot is the whole point of a GIF budget, and the caption already carries it.

### S5 — f139–f193 (2.75 s) · Back on the page: it settles by itself

- **Source:** desktop, same crop as S1–S3, same window.
- **On screen:** the approval dialog closing / settling without a click. This is
  the browser mirror doing its work (`mirror.js`), and it is the single most
  counter-intuitive thing in the product: the phone answered, the page obeyed.
- **Cursor:** parked and still. **No click happens in this shot** — a click would
  destroy the entire point.
- **Hold:** hold the settled state for the last ~30 frames so the loop ends on a
  readable stillness instead of mid-transition.
- **Caption:** `桌面页面跟着手机一起结算` / `the page follows the phone`

## Assembling

1. Export each clip as MP4 (ShareX/OBS) or PNG sequence (ScreenToGif).
2. Trim to the exact frame counts above, then join in that order with **hard
   cuts** — no transitions, no crossfades.
3. Insert 2 hold frames before and after each cut (already counted in the frame
   ranges) so a player cannot smear the cut point.
4. Burn in the caption band last, at `y = 632`, so a re-timed shot does not need
   the captions re-laid.
5. Export at 1280 × 720, 20 fps, with a generated palette:

```sh
# palette first: without it, gradients and the QR block band badly
ffmpeg -i demo.mp4 -vf "fps=20,scale=1280:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
ffmpeg -i demo.mp4 -i palette.png -lavfi "fps=20,scale=1280:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 demo.gif
```

6. Check the result:

```sh
# size, frame count, duration
ls -l demo.gif
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 demo.gif
```

7. **Optional WebP build**, usually 2–3× smaller at better quality:

```sh
ffmpeg -i demo.mp4 -vf "fps=20,scale=1280:-1:flags=lanczos" -c:v libwebp -lossless 0 -q:v 72 -loop 0 -an -preset picture demo.webp
```

   Ship one file, not two, unless you have confirmed animated WebP survives the
   renderer you care about: push it with `README.md` pointing at the GIF until a
   test commit proves the WebP animates where the README is actually read
   (GitHub, npm, and any proxy in between each have their own opinion).

## What is not in the GIF, on purpose

| Left out | Why | Where it goes instead |
|---|---|---|
| `ask_user_question` on the phone | A second card shape costs ~2 s and ~40 frames; the approval already teaches "tap to continue" | A real still in **Answering questions from your phone** |
| The result notice and its reply box | Different direction, different mental model — this GIF is about blocking requests | A real still in **Result notices** |
| The QR app-creation wait | Seconds of spinner, no information | S2 exists to say the wait is announced |
| The 120-second timer | Cannot be shown honestly in a GIF | The caption in S4, and a still of the desktop-first card |
| Any terminal output | Establishes nothing for a GUI product | A still of `logNoCredentials` / `logReady`, beside the settings card |
| A wrong-credential error path | It is a feature, but it is not the pitch | **Quick start** prose; it is already explained there well |

## Pre-publish checklist

- [ ] QR block is opaque and covers the finder patterns
- [ ] no `ou_…` open_id anywhere in any frame, including frames you cut
- [ ] no real App Secret, even partially visible, even in a cut frame
- [ ] no shell prompt, `$DSH_HOME` path, `/home/<user>`, internal hostname, or URL bar
- [ ] the transcript on screen is demo data and says so
- [ ] `titlePrefix` in the recording matches whatever the README claims
- [ ] the demo tenant is not the one that binds your real account
- [ ] file is ≤ 2.5 MB and ≤ 194 frames
- [ ] plays and loops in the browser at 100 % zoom without scrolling
- [ ] the same GIF is referenced from `README.md` and `README.en.md` (one file,
      two READMEs — do not make a Chinese and an English recording)
