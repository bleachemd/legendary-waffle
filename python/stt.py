"""
Speech-to-text with Voice Activity Detection.

Strategy (ordered by priority):
1. Groq API with whisper-large-v3 — fastest, free tier, cloud
2. faster-whisper local (INT8 quantized) — offline fallback

VAD: WebRTC VAD (webrtcvad library) filters out silence so we don't
waste API calls on empty audio chunks.
"""

import os
import io
import sys
import queue
import threading
import numpy as np
from typing import Callable, Optional

SAMPLE_RATE = 16000
CHUNK_SAMP  = int(SAMPLE_RATE * 0.03)   # 30 ms per VAD frame
SILENCE_THRESHOLD_FRAMES = 20           # ~0.6 s of silence → flush buffer

TranscriptCallback = Callable[[str, str, bool], None]  # (speaker, text, is_final)


class STTEngine:
    def __init__(self, on_transcript: Optional[TranscriptCallback]):
        self.on_transcript = on_transcript
        self._use_groq = bool(os.getenv("GROQ_API_KEY"))

        # Separate queues per speaker so they don't mix up
        self._queues: dict[str, queue.Queue[Optional[bytes]]] = {
            "mic": queue.Queue(),
            "speaker": queue.Queue(),
        }

        # Start a processing thread per speaker channel
        for speaker in ("mic", "speaker"):
            t = threading.Thread(
                target=self._process_loop,
                args=(speaker,),
                daemon=True,
            )
            t.start()

    # ── Public ─────────────────────────────────────────────────────────────

    def feed(self, speaker: str, pcm_bytes: bytes):
        """Called from AudioCapture with 30 ms PCM chunks."""
        if speaker in self._queues:
            self._queues[speaker].put(pcm_bytes)

    # ── Internal processing loop (one per speaker) ──────────────────────────

    def _process_loop(self, speaker: str):
        try:
            import webrtcvad  # type: ignore
            vad = webrtcvad.Vad(2)   # aggressiveness 0-3; 2 is a good middle ground
            has_vad = True
        except ImportError:
            print("[stt] webrtcvad not installed — VAD disabled", file=sys.stderr)
            vad = None
            has_vad = False

        audio_buffer: list[bytes] = []
        silence_count = 0
        speech_detected = False

        q = self._queues[speaker]

        while True:
            chunk = q.get()
            if chunk is None:
                break

            is_speech = True
            if has_vad and vad is not None:
                try:
                    is_speech = vad.is_speech(chunk, SAMPLE_RATE)
                except Exception:
                    is_speech = True

            if is_speech:
                audio_buffer.append(chunk)
                silence_count = 0
                speech_detected = True

                # Stream a "pending" transcript update every ~1 second of speech
                # so the UI shows something is happening
                if len(audio_buffer) % 33 == 0 and len(audio_buffer) > 0:
                    if self.on_transcript:
                        self.on_transcript(speaker, "…", False)
            else:
                if speech_detected:
                    silence_count += 1
                    if silence_count >= SILENCE_THRESHOLD_FRAMES:
                        # End of utterance — transcribe what we have
                        if audio_buffer:
                            full_pcm = b"".join(audio_buffer)
                            audio_buffer = []
                            silence_count = 0
                            speech_detected = False
                            self._transcribe(speaker, full_pcm)

    def _transcribe(self, speaker: str, pcm_bytes: bytes):
        if self._use_groq:
            text = self._transcribe_groq(pcm_bytes)
        else:
            text = self._transcribe_local(pcm_bytes)

        if text and self.on_transcript:
            self.on_transcript(speaker, text.strip(), True)

    # ── Groq (cloud, fast) ──────────────────────────────────────────────────

    def _transcribe_groq(self, pcm_bytes: bytes) -> str:
        try:
            import groq  # type: ignore
            import wave

            # wrap raw PCM in a WAV container so the API accepts it
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)   # 16-bit
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(pcm_bytes)
            buf.seek(0)
            buf.name = "audio.wav"

            client = groq.Groq(api_key=os.environ["GROQ_API_KEY"])
            result = client.audio.transcriptions.create(
                file=buf,
                model="whisper-large-v3",
                language="ru",
                response_format="text",
            )
            return str(result)
        except Exception as exc:
            print(f"[stt] groq error: {exc}", file=sys.stderr)
            # fall back to local
            return self._transcribe_local(pcm_bytes)

    # ── faster-whisper (local, offline fallback) ────────────────────────────

    def _transcribe_local(self, pcm_bytes: bytes) -> str:
        try:
            from faster_whisper import WhisperModel  # type: ignore

            # lazy-load the model so startup stays fast
            if not hasattr(self, "_whisper"):
                self._whisper = WhisperModel(
                    "base",                # or "small" for better quality
                    device="cpu",
                    compute_type="int8",   # quantized — fast on CPU
                )

            # faster-whisper wants float32 in [-1, 1]
            samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            segments, _ = self._whisper.transcribe(samples, language="ru", beam_size=1)
            return " ".join(seg.text for seg in segments)
        except Exception as exc:
            print(f"[stt] local whisper error: {exc}", file=sys.stderr)
            return ""
