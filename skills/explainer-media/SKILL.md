---
name: explainer-media
description: Turn a technical explanation into an audio story, a two-host dialogue that macOS voices read into an MP3. When asked, also make a short narrated video in Remotion (title cards, diagram frames, captions) and export it to MP4. Use it when the user wants to listen to or watch an explanation instead of reading it. Triggers: "make it a podcast", "read it to me", "audio version", "narrate this", "explainer video", "turn this into a story".
---

# Explainer media

This skill turns an explanation into something the user can listen to or watch. The words come first: the script follows the harness explaining standard (`docs/explaining-standard.md`, skill `explain`). The audio comes next. The video is optional and reuses the same narration.

```
topic ─► explanation (explain skill)
           │
           ▼
     dialogue script (A/B lines, chapters)
           │
           ▼
     say, one file per line ─► ffmpeg concat + gaps ─► story.mp3
           │                                              │
           │ (video asked)                                ▼
           └─► Remotion: cards + diagrams + captions ─► story.mp4
                                                          │
                                                          ▼
                                        send-only notifier (or a path)
```

**Terms**
- Dialogue script: a text file with one spoken line per row, `A: ...` or `B: ...`. A row that starts with `#` marks a chapter.
- Host A, host B: the two voices. Host A asks and recaps; host B explains with the analogy.
- `say`: the macOS text-to-speech (TTS) command. It writes speech to an audio file with an installed voice.
- ffmpeg: the command-line tool that converts, joins and encodes audio and video.
- MP3: the compressed audio file format that every phone plays. MP4 (H.264 video in an MP4 file): the video format every chat app plays.
- Remotion: a framework that draws video frames with React code and renders them to a video file.
- ASCII (American Standard Code for Information Interchange) diagram: a diagram drawn with plain text characters, as the explaining standard asks for.
- Caption timeline: a TSV (tab-separated values) file with the start, end, speaker and text of each line.

## 1. Write the dialogue script

1. Write the explanation to the explaining standard first. The script is a spoken copy of it, not new content.
2. Open with the question in one line. Then give the simple version, as you would tell a child.
3. Give one analogy and keep it through the whole story. Host B owns the analogy.
4. Split the process into short chapters of three to five lines. Mark each chapter with a `#` row.
5. Keep each line to two short sentences. A listener cannot scroll back.
6. Say each step number aloud ("Step three.") so the listener can keep their place.
7. Define each term the first time a host says it. Spell out acronyms as words the voice can say.
8. End with a recap chapter. Host A repeats the whole flow in one line; host B says the key takeaway.
9. Remove anything private before you render. WARNING: never put a secret, a password, a token, an email address or a private name into a script. The audio file can travel further than the chat.

Length: about 150 words gives one minute at the default rate. A five-minute story is about 750 words.

## 2. Pick the voices

1. Run `say -v '?'` to list the installed voices and their locales.
2. Pick two voices that sound clearly different (for example, one male and one female, or two accents).
3. Use the user's choice when they have one, for example an Indian-English host (`en_IN` voices such as Rishi, Aman or Tara).
4. Set `VOICE_A` and `VOICE_B`. The defaults are Rishi and Samantha.

If a voice is missing, the user can add it in System Settings > Accessibility > Spoken Content > System voice > Manage Voices. Do not install voices yourself.

## 3. Render the audio

Run the helper script from this skill's folder:

```
VOICE_A=Rishi VOICE_B=Samantha TIMELINE=story.tsv \
  scripts/render-dialogue.sh story.txt story.mp3
```

The script does these steps:
1. It checks that `say`, `ffmpeg` and `ffprobe` exist, and that both voices are installed.
2. It renders each line to its own file with the voice of its host.
3. It adds a short gap between lines (`GAP`, default 0.35 s) and a longer gap at a chapter mark (`CHAPTER_GAP`, default 0.9 s).
4. It joins all files with ffmpeg and encodes one MP3.
5. It prints the output path and the length in seconds.
6. With `TIMELINE` set, it also writes the caption timeline for the video step.

`RATE` sets the speed in words per minute (default 175). Listen to the first 20 seconds before you send. Check the names and acronyms: `say` can read them wrong. Respell a word in the script (for example "O-Auth") when it does.

## 4. Make the video (only when asked)

The video reuses the MP3 and the caption timeline. Install the tools only for this step, in a scratch folder. Never copy Remotion into the harness or into the user's project.

1. Create a scratch project: `npx create-video@latest` (pick the blank template). Install the official Remotion agent skills when the prompt offers them; they hold the current best practices.
2. Copy `story.mp3` into the project's `public/` folder. Add it to the composition as one audio track.
3. Set the composition length from the MP3 length: frames = seconds × fps (use 30 fps).
4. Make one title card per chapter. Show the chapter name for about two seconds.
5. Turn each ASCII diagram in the explanation into one diagram frame. Draw the boxes and arrows as shapes, then reveal them in the order of the steps.
6. Show captions from the caption timeline. Show one line at a time, at the bottom, with high contrast. Keep each caption to two rows or fewer.
7. Keep one focus per frame. Do not add moving decoration that does not carry meaning.
8. Preview in Remotion Studio (`npx remotion studio`) and check a few frames by eye.
9. Render: `npx remotion render <CompositionId> out/story.mp4`.
10. Encode for chat apps with ffmpeg: H.264, `yuv420p` pixel format, `+faststart`, AAC (Advanced Audio Coding) audio. Example: `ffmpeg -i out/story.mp4 -c:v libx264 -crf 23 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k story-chat.mp4`.

**License.** Remotion is free for individuals, for-profit companies with up to three employees, non-profits and evaluation. A larger for-profit company needs a Remotion company license. Tell the user this before the first render when the work is for a company. The terms are in Remotion's `LICENSE.md`.

## 5. Deliver

1. Use the harness's send-only notifier when it can attach files. Otherwise send the file through the chat session's own reply tool, or give the user the absolute path.
2. Send the length and the voice pair with the file, in one short line.
3. Keep files under the chat app's limit. Telegram bots can send up to 50 MB (megabytes). For a larger video, lower the quality (`-crf 28`) or the size (`-vf scale=-2:720`) and encode again.
4. Do not send the file anywhere else unless the user asks.

## Example: "How does Sign in with Google work?"

The script (`story.txt`), shortened:

```
# Chapter 1: the idea
A: Today's question. How does "Sign in with Google" work on a website?
B: Think of a club with a bouncer. You show a pass that a trusted friend signed.
A: The website is the club. Google is the trusted friend. The pass is a token.
# Chapter 2: the steps
B: Step one. You click the button, and the website sends you to Google.
A: Step two. You log in at Google, not at the website. The website never sees your password.
...
# Chapter 3: recap
A: So, the recap. Click, log in at Google, approve, get a code, swap it for a token, check it.
B: Your password stays with Google. The website only gets a signed pass.
```

The render, 11 lines and 177 words:

```
$ VOICE_A=Rishi VOICE_B=Samantha TIMELINE=story.tsv scripts/render-dialogue.sh story.txt story.mp3
story.mp3 59s (11 lines)
$ head -2 story.tsv
0.00	4.06	A	Today's question. How does "Sign in with Google" work on a website?
4.41	8.60	B	Think of a club with a bouncer. You show a pass that a trusted friend signed.
```

For a video, the three chapters become three title cards. The flow diagram (button → Google → consent → code → token → check) becomes one frame that reveals each box when the host says its step.

## Edge cases and warnings

- **No ffmpeg.** The script stops and says so. Ask the user before you run `brew install ffmpeg`.
- **Voice missing.** The script stops and names the voice. Pick another installed voice or ask the user to add one.
- **Long scripts.** For more than about 10 minutes, split the story into parts of 5 minutes and render each part. A listener stops after a long block, and a re-render of one part is faster.
- **Wrong pronunciation.** Respell the word in the script. Do not change the meaning to fix the sound.
- **Privacy.** Never narrate secrets, tokens, passwords, private names or personal data. Read the script once for this before you render. In a video, never show a real screen with private data.
- **Not macOS.** `say` exists only on macOS. On another system, use any local TTS tool that writes one audio file per line, then keep the same concat step.
- **Facts.** Narrate only what the explanation already says and what you checked. A confident voice makes a wrong fact sound true.

## Sources

We wrote this skill fresh and copied no text or code. Its workflow draws on ideas from these projects:
- [remotion-dev/remotion](https://github.com/remotion-dev/remotion) and its agent skills, [remotion-dev/skills](https://github.com/remotion-dev/skills): Remotion License (free tier and company license).
- [Vincentwei1021/anything2explainer](https://github.com/Vincentwei1021/anything2explainer): a topic-to-narrated-video pipeline (PolyForm Noncommercial 1.0.0). This skill takes only two ideas from it: fix the script before narration, and check each stage.
