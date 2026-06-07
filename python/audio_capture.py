"""
Dual-channel audio capture.

On macOS/Linux: uses soundcard to grab the loopback (speaker output) and
PyAudio for the microphone, running them in separate threads.

On Windows: uses PyAudio with WASAPI loopback for speaker capture.

Both streams are fed into the STT engine as (speaker_label, pcm_bytes) tuples.
"""

import threading
import sys
from typing import Callable, Optional
import numpy as np

SAMPLE_RATE = 16000     # 16 kHz mono — what Whisper expects
CHUNK_MS    = 30        # 30 ms chunks  (480 samples at 16 kHz)
CHUNK_SAMP  = int(SAMPLE_RATE * CHUNK_MS / 1000)
DTYPE       = np.int16

AudioCallback = Callable[[str, bytes], None]  # (speaker_label, pcm_bytes)


class AudioCapture:
    def __init__(self, on_audio: Optional[AudioCallback]):
        self.on_audio = on_audio
        self._mic_thread: Optional[threading.Thread] = None
        self._loopback_thread: Optional[threading.Thread] = None
        self._running = False

    # ── Public ─────────────────────────────────────────────────────────────

    def start(self):
        if self._running:
            return
        self._running = True
        self._mic_thread = threading.Thread(target=self._run_mic, daemon=True)
        self._mic_thread.start()
        self._loopback_thread = threading.Thread(target=self._run_loopback, daemon=True)
        self._loopback_thread.start()

    def stop(self):
        self._running = False
        # threads are daemon — they exit when running flag clears

    # ── Microphone ──────────────────────────────────────────────────────────

    def _run_mic(self):
        try:
            import pyaudio  # type: ignore
        except ImportError:
            print("[audio] pyaudio not installed — mic capture disabled", file=sys.stderr)
            return

        pa = pyaudio.PyAudio()
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_SAMP,
        )
        try:
            while self._running:
                data = stream.read(CHUNK_SAMP, exception_on_overflow=False)
                if self.on_audio:
                    self.on_audio("mic", data)
        finally:
            stream.stop_stream()
            stream.close()
            pa.terminate()

    # ── Loopback (speaker output) ────────────────────────────────────────────

    def _run_loopback(self):
        platform = sys.platform
        if platform == "win32":
            self._run_loopback_wasapi()
        else:
            self._run_loopback_soundcard()

    def _run_loopback_soundcard(self):
        """macOS / Linux — uses the soundcard library."""
        try:
            import soundcard  # type: ignore
        except ImportError:
            print("[audio] soundcard not installed — loopback disabled", file=sys.stderr)
            return

        try:
            mic = soundcard.get_microphone(id=str(soundcard.default_speaker().id), include_loopback=True)
        except Exception:
            # fallback: some systems expose it differently
            speakers = soundcard.all_microphones(include_loopback=True)
            if not speakers:
                print("[audio] no loopback device found", file=sys.stderr)
                return
            mic = speakers[0]

        with mic.recorder(samplerate=SAMPLE_RATE, channels=1) as rec:
            while self._running:
                data = rec.record(numframes=CHUNK_SAMP)  # shape (CHUNK_SAMP, 1)
                pcm = (data[:, 0] * 32767).astype(DTYPE).tobytes()
                if self.on_audio:
                    self.on_audio("speaker", pcm)

    def _run_loopback_wasapi(self):
        """Windows — WASAPI loopback via PyAudio."""
        try:
            import pyaudio  # type: ignore
        except ImportError:
            print("[audio] pyaudio not installed — loopback disabled", file=sys.stderr)
            return

        pa = pyaudio.PyAudio()

        # Find a WASAPI loopback device (render device used as input)
        loopback_index = None
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info.get("maxInputChannels", 0) > 0 and "loopback" in str(info.get("name", "")).lower():
                loopback_index = i
                break

        if loopback_index is None:
            # On some systems the default output device can be opened in loopback mode
            loopback_index = pa.get_default_output_device_info()["index"]

        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=SAMPLE_RATE,
                input=True,
                input_device_index=loopback_index,
                frames_per_buffer=CHUNK_SAMP,
                as_loopback=True,   # PyAudio WASAPI extension
            )
            while self._running:
                data = stream.read(CHUNK_SAMP, exception_on_overflow=False)
                if self.on_audio:
                    self.on_audio("speaker", data)
        except OSError as e:
            print(f"[audio] WASAPI loopback failed: {e}", file=sys.stderr)
        finally:
            pa.terminate()
