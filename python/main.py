"""
Entry point for the Python backend.
Reads newline-delimited JSON from stdin (commands from Electron)
and writes newline-delimited JSON to stdout (events to Electron).

All heavy work (audio, STT, RAG, LLM) is delegated to the other modules.
"""

import sys
import json
import threading
from audio_capture import AudioCapture
from stt import STTEngine
from rag import RAGStore
from llm import stream_answer

# ─── helpers ─────────────────────────────────────────────────────────────────

def send(msg: dict):
    """Write a JSON message to stdout so Electron can read it."""
    print(json.dumps(msg, ensure_ascii=False), flush=True)

def send_status(text: str):
    send({"type": "status", "text": text})

def send_error(message: str):
    send({"type": "error", "message": message})

# ─── globals ─────────────────────────────────────────────────────────────────

rag_store = RAGStore()
stt_engine = STTEngine(on_transcript=None)   # callback set below
audio_capture = AudioCapture(on_audio=None)   # callback set below
recording = False

# ─── transcript pipeline ─────────────────────────────────────────────────────

def on_transcript(speaker: str, text: str, is_final: bool):
    """Called by STT engine whenever a new segment is ready."""
    send({"type": "transcript", "speaker": speaker, "text": text, "final": is_final})

    if is_final and speaker == "speaker":
        # The interviewer finished talking — generate an answer
        threading.Thread(target=generate_answer, args=(text,), daemon=True).start()

def generate_answer(question: str):
    context_chunks = rag_store.query(question, k=4)
    context = "\n\n".join(context_chunks) if context_chunks else ""
    try:
        for token in stream_answer(question, context):
            send({"type": "llm_token", "token": token})
        send({"type": "llm_done"})
    except Exception as exc:
        send_error(str(exc))

# ─── wire up callbacks ───────────────────────────────────────────────────────

stt_engine.on_transcript = on_transcript
audio_capture.on_audio = stt_engine.feed

# ─── command loop ─────────────────────────────────────────────────────────────

send_status("Бэкенд запущен, жду команд")

for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue

    try:
        cmd = json.loads(raw_line)
    except json.JSONDecodeError:
        send_error(f"bad json: {raw_line[:80]}")
        continue

    cmd_type = cmd.get("type", "")

    if cmd_type == "start_recording":
        if not recording:
            recording = True
            audio_capture.start()
            send_status("Запись начата")

    elif cmd_type == "stop_recording":
        if recording:
            recording = False
            audio_capture.stop()
            send_status("Запись остановлена")

    elif cmd_type == "upload_resume":
        content = cmd.get("content", "")
        name = cmd.get("name", "resume")
        try:
            rag_store.add_document(content, source=name)
            send({"type": "rag_ready"})
            send_status(f"Резюме '{name}' проиндексировано")
        except Exception as exc:
            send_error(str(exc))

    elif cmd_type == "upload_jd":
        content = cmd.get("content", "")
        name = cmd.get("name", "jd")
        try:
            rag_store.add_document(content, source=name)
            send({"type": "rag_ready"})
            send_status(f"Вакансия '{name}' проиндексирована")
        except Exception as exc:
            send_error(str(exc))

    else:
        send_error(f"unknown command: {cmd_type}")
