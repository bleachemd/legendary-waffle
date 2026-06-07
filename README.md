# Interview Copilot

A stealth desktop overlay that listens to your interview audio, transcribes both sides in real time, and streams an AI-generated answer in Russian — invisible to screen-sharing software.

---

## What it does

- Sits as a frameless transparent window always on top of everything else
- Uses OS-level screen-capture protection so Zoom/Teams/Meet cannot record it
- Captures your mic and the interviewer's speaker output simultaneously
- Transcribes speech with Whisper (via Groq or locally)
- Searches your resume and the job description for relevant context
- Streams a concise Russian-language answer token by token

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | https://nodejs.org |
| Python | 3.10+ | https://python.org |
| npm | bundled with Node | — |

---

## 1. Clone and install

```bash
git clone <repo-url> interview-copilot
cd interview-copilot
npm install
pip install -r requirements.txt
```

> On macOS you may need `brew install portaudio` before `pip install pyaudio`.
> On Linux: `sudo apt install portaudio19-dev python3-dev`.
> On Windows: download the PyAudio wheel from https://www.lfd.uci.edu/~gohlke/pythonlibs/#pyaudio

---

## 2. Environment variables

Copy the example and fill in your keys:

```bash
cp .env.example .env
```

Open `.env` and set:

```
# Required — get a free key at https://openrouter.ai
OPENROUTER_API_KEY=sk-or-...

# Optional — for cloud Whisper STT (faster, recommended)
# Free tier at https://console.groq.com
GROQ_API_KEY=gsk_...
```

If `GROQ_API_KEY` is not set, the app falls back to a local `faster-whisper` model
(downloads ~140 MB on first run, no internet needed after that).

---

## 3. Run in development

```bash
npm run dev:vite      # terminal 1 — Vite dev server on localhost:5173
npm run dev:electron  # terminal 2 — launches Electron (waits for Vite)
```

Or run both together (requires `wait-on`):

```bash
npm run dev
```

---

## 4. Build for production

```bash
npm run build:electron   # compile TypeScript Electron main process
npm run build            # compile React UI + package with electron-builder
```

The installer/binary is written to `release/`.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+H` | Show / hide the overlay |
| `Ctrl+Shift+P` | Toggle click-through (mouse events fall through) |
| `Ctrl+Shift+R` | Start / stop recording |
| `Ctrl+Shift+C` | Clear current session |

---

## Module overview

```
electron/
  main.ts          Window creation, screen-capture protection, IPC, Python subprocess
  preload.ts       Exposes a safe API from main to renderer

src/
  App.tsx          Root React component
  components/
    Overlay.tsx    The entire UI — transcript, answer, file upload
  hooks/
    usePythonBridge.ts  IPC bridge to/from Python
  utils/
    markdown.ts    Lightweight markdown renderer for the answer panel

python/
  main.py          Command loop (reads from Electron, writes JSON events)
  audio_capture.py Mic + loopback capture (PyAudio / soundcard)
  stt.py           VAD + Groq Whisper / faster-whisper transcription
  rag.py           FAISS-backed vector store, sentence-transformers embeddings
  llm.py           OpenRouter streaming connector
```

---

## How the stealth works

In `electron/main.ts`:

```typescript
mainWindow.setContentProtection(true)
```

On Windows this calls `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`.
On macOS it sets `NSWindowSharingType` to `NSWindowSharingNone`.

Both are OS-level APIs, not application-level tricks. The window is excluded from
the compositor's capture surface before any screen-sharing tool can read it.
There is no known way to bypass this from userspace — the exclusion happens in the
kernel's DWM (Windows) or SkyLight/CoreGraphics (macOS) layer.

---

## Troubleshooting

**"No loopback device found"** on macOS:
Install BlackHole (free) to create a virtual audio loopback device:
https://github.com/ExistentialAudio/BlackHole

**"No loopback device found"** on Linux:
Enable PulseAudio monitor source:
```bash
pactl load-module module-loopback
```

**Window is visible in screen share (unexpected)**:
Make sure you are running the packaged app, not a plain `node` process.
`setContentProtection` only works inside Electron.

**Python backend not starting**:
Run the Python script manually to see the error:
```bash
cd python && python3 main.py
```
Then type a JSON command and press Enter:
```
{"type": "start_recording"}
```

---

## License

MIT
