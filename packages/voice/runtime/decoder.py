"""Bounded local audio decoding through Studio's separate FFmpeg executable."""
import os
from pathlib import Path
import subprocess
import threading

import numpy as np

MAX_SECONDS = 600
MAX_DECODED_BYTES = MAX_SECONDS * 16000 * 4
_decoder = None


def configure_decoder(path):
    global _decoder
    _decoder = Path(path).resolve() if path else None


def decode_audio(data, content_type=""):
    kind = content_type.lower().split(";")[0]
    if kind in ("audio/pcm", "audio/l16", "application/octet-stream"):
        if not data or len(data) % 2 or len(data) > MAX_SECONDS * 16000 * 2:
            raise ValueError("Raw PCM must contain complete samples within the duration bound.")
        return np.frombuffer(data, dtype=">i2" if kind == "audio/l16" else "<i2").astype(np.float32) / 32768
    if not _decoder or not _decoder.is_file():
        raise ValueError("The local audio decoder is unavailable.")
    # Input and output are pipes, never recording files. Disable network protocols,
    # select one audio stream and read only one sample beyond the duration bound.
    process = subprocess.Popen([str(_decoder), "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "2",
        "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", "16000", "-t", str(MAX_SECONDS + .01), "-f", "f32le", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    def write():
        try:
            process.stdin.write(data)
        except (BrokenPipeError, OSError):
            pass
        finally:
            process.stdin.close()
    writer = threading.Thread(target=write, daemon=True)
    expired = threading.Event()
    def timeout():
        expired.set()
        try:
            process.kill()
        except OSError:
            pass
    timer = threading.Timer(30, timeout)
    writer.start(); timer.start()
    try:
        pcm = process.stdout.read(MAX_DECODED_BYTES + 4)
        if len(pcm) > MAX_DECODED_BYTES:
            raise ValueError("Audio exceeds ten minutes.")
        if process.wait(timeout=5) != 0 or expired.is_set() or not pcm or len(pcm) % 4:
            raise ValueError("The recording could not be decoded.")
        samples = np.frombuffer(pcm, dtype="<f4")
        if not np.isfinite(samples).all():
            raise ValueError("The recording contains invalid samples.")
        return samples
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()
        writer.join(timeout=5)
