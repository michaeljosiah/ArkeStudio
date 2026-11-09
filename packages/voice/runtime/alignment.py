"""The existing qualified acoustic alignment, isolated behind bounded stdin/stdout."""
import hashlib
import json
import os
import subprocess

import numpy as np

from engines import decode_audio

MODEL_SHA256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
ENGINE = "whisper.cpp/dtw-word-boundaries-v1"


class AlignmentRejected(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail


class Alignment:
    def __init__(self, helper, model):
        self.helper, self.model = helper, model
        self.ready = False
        try:
            if helper and model and helper.is_file() and model.is_file():
                with model.open("rb") as source:
                    self.ready = hashlib.file_digest(source, "sha256").hexdigest() == MODEL_SHA256
        except OSError:
            pass

    def transcribe(self, data, content_type):
        samples = decode_audio(data, content_type)
        pcm = np.clip(samples * 32768, -32768, 32767).astype("<i2").tobytes()
        if not self.ready:
            raise AlignmentRejected(503, "Local acoustic word alignment is unavailable.")
        try:
            result = subprocess.run([str(self.helper), "--model", str(self.model)], input=pcm,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=320, check=True,
                env={key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ},
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if len(result.stdout) > 8 * 1024**2:
                raise ValueError()
            response = json.loads(result.stdout)
            if response.get("status") == 422:
                detail = response.get("detail", "")
                if detail in {
                    "Invalid audio duration.", "Word timing requires at least 0.2 seconds of audio.",
                    "Long audio requires a measurable silent pause within each 28-second alignment window.",
                    "The recognizer returned text without usable word timings.",
                    "The recognizer returned multiple words under one timestamp.",
                    "The recognizer returned out-of-order tokens.",
                    "A word has no usable acoustic interval or an unresolved pause.",
                }:
                    raise AlignmentRejected(422, detail)
                raise AlignmentRejected(422, "The recognizer returned text without usable word timings.")
            heard = response["data"]
            if response.get("status") != 200 or heard["engine"]["id"] != ENGINE or heard["engine"]["model"] != "sha256:" + MODEL_SHA256:
                raise ValueError()
            return heard
        except AlignmentRejected:
            raise
        except Exception:
            raise AlignmentRejected(503, "Local acoustic word alignment is unavailable.") from None
