import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import alignment
from alignment import Alignment, AlignmentRejected, ENGINE


def test_alignment_refuses_missing_or_unverified_models(tmp_path):
    helper = tmp_path / "helper.exe"
    model = tmp_path / "model.bin"
    assert not Alignment(helper, model).ready
    helper.write_bytes(b"helper"); model.write_bytes(b"wrong model")
    assert not Alignment(helper, model).ready


def test_bounded_native_protocol_preserves_identity_and_private_environment(tmp_path, monkeypatch):
    helper = tmp_path / "helper.exe"; helper.write_bytes(b"helper")
    model = tmp_path / "model.bin"; model.write_bytes(b"verified fixture")
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    monkeypatch.setattr(alignment, "MODEL_SHA256", digest)
    monkeypatch.setenv("ARKE_SPEECH_CAPABILITY", "private")
    answer = {"status": 200, "data": {"text": "Hello.", "seconds": 1,
        "engine": {"id": ENGINE, "version": "1.9.1", "model": "sha256:" + digest},
        "words": [{"text": "Hello.", "startSec": 0, "endSec": .8, "probability": .9}]}}
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout=json.dumps(answer).encode())
    monkeypatch.setattr(alignment.subprocess, "run", run)
    monkeypatch.chdir(tmp_path)
    engine = Alignment(Path("helper.exe"), Path("model.bin"))
    assert engine.ready
    pcm = np.array([0, 16384, -16384], dtype="<i2").tobytes()
    assert engine.transcribe(pcm, "audio/pcm") == answer["data"]
    args, options = calls[0]
    assert args == [str(helper), "--model", str(model)]
    assert options["input"] == pcm and options["timeout"] == 320
    assert "ARKE_SPEECH_CAPABILITY" not in options["env"]
    answer["data"]["engine"]["id"] = "guessed-boundaries"
    with pytest.raises(AlignmentRejected) as error:
        engine.transcribe(pcm, "audio/pcm")
    assert error.value.status == 503
    answer.clear(); answer.update(status=422, detail="The recognizer returned multiple words under one timestamp.")
    with pytest.raises(AlignmentRejected) as error:
        engine.transcribe(pcm, "audio/pcm")
    assert error.value.status == 422 and "multiple words" in error.value.detail
    answer["detail"] = "Private path or transcript must never be reflected"
    with pytest.raises(AlignmentRejected) as error:
        engine.transcribe(pcm, "audio/pcm")
    assert "Private" not in error.value.detail
