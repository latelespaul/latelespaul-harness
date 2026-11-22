---
name: product-demo
description: Make a short launch or demo video (20 to 60 seconds) of the user's own web app. Record a scripted click path with Playwright and edit it in Remotion: zooms, cursor highlight, captions, brand intro and outro. Run a polish check, then export 16:9, 9:16 and 1:1 video files (MP4, H.264) that fit chat apps. Triggers: "demo video", "launch video", "product walkthrough", "promo clip", "screen recording of my app", a video for a post or a pull request.
---

# Product demo

This skill makes a short, polished video of a web app that the user owns. A script drives the browser, so every take is the same and you can record it again after a fix. The edit happens in code, so the brand colours and fonts come from the app itself.

```
brief ─► click path ─► capture (Playwright) ─► raw.webm + timeline.json
                                                   │
                                                   ▼
          Remotion: intro ─ zooms + cursor + captions ─ outro
                                                   │
                                                   ▼
                       polish check ─► fix ─► render 16:9 master
                                                   │
                                                   ▼
                         9:16 and 1:1 cuts ─► encode-chat.sh ─► send
```

**Terms**
- Brief: one short note that fixes the audience, the length and the key moments.
- Click path: the list of browser steps that the capture script runs (go to, click, fill, press, wait, screenshot).
- Capture: one recorded run of the click path. It writes `raw.webm` (the video) and `timeline.json` (when each step starts, and where each click lands).
- Playwright: a library that drives a real browser from code and can record its window.
- Remotion: a framework that draws video frames with React code and renders them to a video file.
- Design tokens: the named colours, fonts and sizes in the app's code (CSS (Cascading Style Sheets) variables, a Tailwind config, or a theme file).
- Cut: one export of the video at one aspect ratio. 16:9 is landscape, 9:16 is portrait (phone stories), 1:1 is square (feeds).
- MP4: the video file format that chat apps play.
- H.264: the video codec that every phone and chat app plays. CRF (constant rate factor) sets its quality; a lower number gives a better picture and a larger file.

## 1. Write the brief

Ask only what you cannot find in the app or the conversation. Write the brief in five lines:
1. **Audience.** Who watches it, and where (a launch post, a pull request (PR), a landing page).
2. **Length.** 20 to 60 seconds. Use 30 seconds when the user does not say.
3. **Key moments.** Two to four actions that show the value. One moment per 8 to 15 seconds.
4. **Claim.** The one sentence that the video proves. Use only claims that the app really does today.
5. **Data.** Demo data or the user's own test account. WARNING: never record real users' names, emails, messages or payments. Seed a demo account or blur the data.

## 2. Write the click path

1. Write each key moment as browser steps in `path.json`. The format is in the header of `scripts/capture.mjs`.
2. Use stable selectors: a `data-testid`, a role with a name, or a label. Avoid CSS classes that a build can change.
3. Add a `caption` to each step that the viewer must understand. Keep a caption to eight words or fewer.
4. Add a `hold` after each important step, so the viewer can see the result (800 to 1500 ms).
5. Type at a human speed. The script types at 60 ms per key.
6. Add a `shot` at each key moment. The screenshots become the poster frame and the frames for the polish check.

## 3. Capture

Install the tools only for this step, in a scratch folder. Never copy Playwright or Remotion into the harness or into the user's project.

```
mkdir -p /tmp/demo && cd /tmp/demo
npm i -D playwright && npx playwright install chromium
node <skill>/scripts/capture.mjs path.json take1 --width 1920 --height 1080
```

1. Use a clean browser profile, as the script does by default. Your own logins and extensions must not appear.
2. When the app needs a login, log in to the demo account inside the click path. WARNING: never put a password in `path.json`. Use a fill step with `"textEnv": "DEMO_PASSWORD"` instead of `"text"`. The script types the value of that environment variable and does not write it to `timeline.json`. The user sets the variable before the run.
3. Watch `take1/raw.webm` once. Record again when a step stalls, a toast covers the action, or a spinner shows for long.
4. As another way, use the harness browser tools to record a flow that a script cannot drive. Keep the same brief and the same checks.

## 4. Edit in Remotion

1. Create a scratch project: `npx create-video@latest` (blank template). Install the official Remotion agent skills when the prompt offers them.
2. Read the brand from the design tokens: the main colours, the font family and the corner radius. Load the same font files. Do not invent a palette.
3. Put `raw.webm` in `public/`. Build one composition at 1920×1080, 30 fps.
4. **Intro card** (1.5 to 2.5 s): the product name, the one-sentence claim, the brand colours.
5. **Zoom on the action.** Before each click or fill, zoom in on its box from `timeline.json` (scale 1.3 to 1.8). Ease in over about 0.5 s, hold, and ease out. Keep one zoom at a time.
6. **Cursor highlight.** Draw a soft ring at the box centre for each click, with a short pulse at the click time. Keep it subtle.
7. **Captions.** Show each step's caption from its `t` time until the next step. Use the brand font, high contrast, and a safe margin of 5% from each edge.
8. **Speed.** Speed up waits and page loads (2× to 4×). Cut dead time instead of showing a spinner.
9. **Outro card** (2 to 3 s): the product name, the address or the call to action, nothing else.
10. Add music only when the user asks and gives a track they have the right to use.

Make the portrait and square cuts as their own compositions (1080×1920 and 1080×1080). Do not crop the landscape master. Re-frame each zoom so the action stays in view, and move the captions into the safe area of each shape.

## 5. Polish check

Render stills at each key moment (`npx remotion still`) and check each item. Fix, then check again.

- **Spacing.** Margins are even. Nothing touches the frame edge or the captions.
- **Contrast.** Caption text is easy to read on every frame, light and dark parts included.
- **Text overflow.** No caption wraps to more than two rows. The 9:16 cut shows all text in full.
- **Timing.** Each caption stays long enough to read twice. No zoom starts while the previous one still moves.
- **Focus.** Each frame has one thing to look at. The cursor ring never hides the button text.
- **No generic look.** No default gradients, no stock glow, no bounce on every element, no emoji. The video looks like the app, not like a template.
- **Honest claims.** Every caption describes what the app really did in the capture. No fake numbers, no fake testimonials, no features that do not exist.
- **Privacy.** No real personal data, no tokens in the address bar, no notifications from other apps.

## 6. Export

1. Render each cut: `npx remotion render <CompositionId> out/demo-16x9.mp4` (and `demo-9x16`, `demo-1x1`).
2. Encode each cut for chat apps and posts:

```
<skill>/scripts/encode-chat.sh out/demo-16x9.mp4 demo-16x9.mp4 50
```

The script encodes H.264 with `yuv420p`, AAC (Advanced Audio Coding) audio and `+faststart`. It lowers the quality, then the size, until the file fits the limit in MB (megabytes). Telegram bots can send up to 50 MB. Other apps have their own limits; check them before you send.

3. Send the files through the harness's send-only notifier when it can attach files. Otherwise use the chat session's reply tool, or give the user the paths. Post to a public site only when the user says so.

## Example: a 30-second demo of a to-do app

The brief: "New users on the landing page. 30 s. Moments: add a task, set a due date, see it in Today."

`path.json`:

```
[
  {"goto": "http://localhost:3000/demo", "hold": 1200},
  {"click": "[data-testid=new-task]", "caption": "Add a task in one click"},
  {"fill": "[data-testid=task-title]", "text": "Send the invoice"},
  {"click": "[data-testid=due-tomorrow]", "caption": "Pick a due date", "hold": 1000},
  {"click": "role=link[name=\"Today\"]", "caption": "It shows up in Today", "hold": 1500, "shot": "today"}
]
```

The values below are illustrative. The capture prints `take1/raw.webm (5 steps, 9.8 s)`. The edit adds a 2 s intro, three zooms and a 2.5 s outro, and speeds up the page load. The master is 24 s. `encode-chat.sh` prints `demo-16x9.mp4 6.1 MB 24s (crf 23)`.

## Edge cases and warnings

- **No ffmpeg or Node.** The scripts stop and say so. Ask the user before you install them.
- **The app needs a login.** Use a demo account. Never record the user's real account with private data.
- **Flaky steps.** Wait for the element, not for a fixed time. When a step still fails, fix the selector and capture again.
- **Animations or cookie banners.** Dismiss the banner in the click path. Turn off random content, such as a rotating hero, with a demo flag in the app.
- **Too long.** Cut moments, not speed. A 60 s video with four moments is the upper limit.
- **Too large for chat.** `encode-chat.sh` steps down the quality. When it still fails, make the video shorter.
- **License.** Remotion is free for individuals, for-profit companies with up to three employees, non-profits and evaluation. A larger for-profit company needs a Remotion company license. Tell the user before the first render when the app belongs to such a company.

## Sources

We wrote this skill fresh and copied no text or code. Its workflow draws on ideas from these projects:
- [getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) (MIT): auto zoom on clicks, cursor effects, captions, several aspect ratios.
- [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0): a final polish pass and a check for generic, template-like design.
- [remotion-dev/remotion](https://github.com/remotion-dev/remotion) and [remotion-dev/skills](https://github.com/remotion-dev/skills): Remotion License (free tier and company license).
