"""
Entry point for the Python backend.

Two modes, selected by the WS_MODE env var:
  WS_MODE=false (default) — reads from stdin / writes to stdout (local subprocess)
  WS_MODE=true            — runs a WebSocket server on WS_HOST:WS_PORT (Docker)

All message framing is identical in both modes: newline-delimited JSON objects
with a `type` field, so the Electron side doesn't need to know which mode is active.
"""

import warnings
warnings.filterwarnings("ignore", message="pkg_resources is deprecated")

import os
import sys
import json
import threading

# load .env when running locally (harmless in Docker where vars come from env_file)
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

from audio_capture import AudioCapture
from stt import STTEngine
from rag import RAGStore
from llm import stream_answer, make_system_message

WS_MODE = os.getenv("WS_MODE", "false").lower() in ("1", "true", "yes")
WS_HOST = os.getenv("WS_HOST", "0.0.0.0")
WS_PORT = int(os.getenv("WS_PORT", "8765"))

# ─── shared state ────────────────────────────────────────────────────────────

rag_store = RAGStore()
recording = False

# Conversation history — persists across questions so the model can reason
# about follow-up questions. reasoning_details from each assistant turn are
# preserved here so the model can continue from where it left off.
# Capped at MAX_HISTORY_TURNS to avoid blowing the context window.
MAX_HISTORY_TURNS = 6   # = 6 user+assistant pairs (12 messages, not counting system)
conversation_history: list[dict] = [make_system_message()]

# send_fn is replaced per-connection in WS mode; in stdio mode it's set once
_send_lock = threading.Lock()
_send_fn = None   # type: ignore[assignment]


def send(msg: dict):
    if _send_fn is None:
        return
    with _send_lock:
        _send_fn(msg)

def send_status(text: str):
    send({"type": "status", "text": text})

def send_error(message: str):
    send({"type": "error", "message": message})

# ─── transcript pipeline ─────────────────────────────────────────────────────

def on_transcript(speaker: str, text: str, is_final: bool):
    send({"type": "transcript", "speaker": speaker, "text": text, "final": is_final})
    if is_final and speaker == "speaker":
        threading.Thread(target=generate_answer, args=(text,), daemon=True).start()

def generate_answer(question: str):
    global conversation_history

    context_chunks = rag_store.query(question, k=4)
    context = "\n\n".join(context_chunks) if context_chunks else ""

    user_content = question
    if context:
        user_content = f"Контекст из резюме/вакансии:\n{context}\n\nВопрос интервьюера: {question}"

    conversation_history.append({"role": "user", "content": user_content})

    # trim to keep only the system message + last MAX_HISTORY_TURNS pairs
    if len(conversation_history) > 1 + MAX_HISTORY_TURNS * 2:
        conversation_history = [conversation_history[0]] + conversation_history[-(MAX_HISTORY_TURNS * 2):]

    try:
        for event in stream_answer(conversation_history):
            if event["type"] == "turn_complete":
                # append assistant message (with reasoning_details) for the next turn
                conversation_history.append(event["assistant_message"])
                send({"type": "llm_done"})
            else:
                # forward reasoning_token and llm_token directly to Electron
                send(event)
    except Exception as exc:
        send_error(str(exc))
        # pop the user message we just added so history stays consistent
        if conversation_history and conversation_history[-1]["role"] == "user":
            conversation_history.pop()

# ─── shared command handler ────────────────────────────────────────────────────

stt_engine = STTEngine(on_transcript=on_transcript)
audio_capture = AudioCapture(on_audio=stt_engine.feed)

def handle_command(cmd: dict):
    global recording
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

    elif cmd_type == "clear_session":
        conversation_history.clear()
        conversation_history.append(make_system_message())
        send_status("История очищена")

    else:
        send_error(f"unknown command: {cmd_type}")

# ─── mode: stdio ─────────────────────────────────────────────────────────────

def run_stdio():
    global _send_fn

    def _write(msg: dict):
        print(json.dumps(msg, ensure_ascii=False), flush=True)

    _send_fn = _write
    send_status("Бэкенд запущен (stdio), жду команд")

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            cmd = json.loads(raw_line)
        except json.JSONDecodeError:
            send_error(f"bad json: {raw_line[:80]}")
            continue
        handle_command(cmd)

# ─── mode: WebSocket server ───────────────────────────────────────────────────

def run_websocket():
    try:
        import asyncio
        import websockets  # type: ignore
    except ImportError:
        print("[main] websockets not installed — pip install websockets", file=sys.stderr)
        sys.exit(1)

    async def handler(ws):
        global _send_fn

        # Each new connection becomes the active send target.
        # Only one Electron client connects at a time in practice.
        def _write(msg: dict):
            # schedule the coroutine from whatever thread calls send()
            asyncio.run_coroutine_threadsafe(
                ws.send(json.dumps(msg, ensure_ascii=False)),
                loop,
            )

        _send_fn = _write
        send_status("Бэкенд запущен (WebSocket), жду команд")

        try:
            async for raw in ws:
                try:
                    cmd = json.loads(raw)
                except json.JSONDecodeError:
                    send_error(f"bad json: {str(raw)[:80]}")
                    continue
                handle_command(cmd)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if _send_fn is _write:
                _send_fn = None  # type: ignore[assignment]

    async def main():
        print(f"[main] WebSocket server listening on ws://{WS_HOST}:{WS_PORT}", flush=True)
        async with websockets.serve(handler, WS_HOST, WS_PORT):
            await asyncio.Future()  # run forever

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(main())

# ─── entry ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if WS_MODE:
        run_websocket()
    else:
        run_stdio()
