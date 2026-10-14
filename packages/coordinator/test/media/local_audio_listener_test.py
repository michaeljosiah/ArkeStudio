"""Stdlib protocol and offline inference-boundary tests; no model download or GPU."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[2] / "src/media/local-audio-listener.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def request(rate=16000, channels=1, frames=160):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack("<h", 8192) * frames * channels)
    return {"audio": base64.b64encode(stream.getvalue()).decode("ascii"), "focuses": ["music", "emotion", "voice-delivery"]}


class ListeningWorkerTests(unittest.TestCase):
    def test_decodes_waveform_and_refuses_invalid_or_oversized_inputs(self):
        pcm, focuses = worker.decode_request(json.dumps(request()))
        self.assertEqual(pcm, struct.pack("<h", 8192) * 160)
        self.assertEqual(focuses, ["music", "emotion", "voice-delivery"])
        for value in [request(rate=24000), request(channels=2), request(frames=480001),
                      {**request(), "focuses": ["music", "music"]}, {**request(), "path": "private.wav"},
                      {**request(), "audio": "invalid!"}]:
            with self.assertRaises((ValueError, wave.Error)):
                worker.decode_request(json.dumps(value))

    def test_real_worker_inference_boundary_consumes_pcm_not_transcript_and_loads_only_local_safetensors(self):
        seen = {}

        class Audio:
            def astype(self, dtype):
                return self

            def __truediv__(self, scale):
                seen["scale"] = scale
                return self

        def frombuffer(pcm, dtype):
            seen["pcm"] = pcm
            seen["dtype"] = dtype
            return Audio()

        class Inputs(dict):
            input_ids = types.SimpleNamespace(size=lambda index: 4)

            def to(self, device):
                return self

        class Generated:
            def __getitem__(self, index):
                return self

        class Processor:
            feature_extractor = types.SimpleNamespace(sampling_rate=16000)

            @staticmethod
            def from_pretrained(directory, **kwargs):
                seen["processor"] = kwargs
                return Processor()

            def apply_chat_template(self, conversation, **kwargs):
                seen["conversation"] = conversation
                return "<|AUDIO|>review"

            # Match the supported processor signature; arbitrary kwargs hid deprecated alias bugs.
            def __call__(self, *, text, audio, sampling_rate, return_tensors, padding):
                seen["inputs"] = {"text": text, "audio": audio, "sampling_rate": sampling_rate,
                                  "return_tensors": return_tensors, "padding": padding}
                return Inputs(input_features=audio)

            def batch_decode(self, generated, **kwargs):
                return ["The music has a slow pulse; the voice sounds restrained."]

        class Model:
            device = "cpu"

            @staticmethod
            def from_pretrained(directory, **kwargs):
                seen["model"] = kwargs
                return Model()

            def eval(self):
                return self

            def generate(self, **kwargs):
                seen["generation"] = kwargs
                return Generated()

        fake_numpy = types.SimpleNamespace(frombuffer=frombuffer, float32="float32")
        fake_torch = types.SimpleNamespace(__version__="fixture", inference_mode=contextlib.nullcontext)
        fake_transformers = types.SimpleNamespace(__version__="4.51.3", AutoProcessor=Processor, Qwen2AudioForConditionalGeneration=Model)
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory)
            (model / "config.json").write_text(json.dumps({"model_type": "qwen2_audio", "architectures": ["Qwen2AudioForConditionalGeneration"]}))
            (model / "model.safetensors").write_bytes(b"fixture model")
            for name in ["preprocessor_config.json", "tokenizer_config.json"]:
                (model / name).write_text("{}")
            files = worker.model_files(model)
            pcm, focuses = worker.decode_request(json.dumps(request()))
            with patch.dict(sys.modules, numpy=fake_numpy, torch=fake_torch, transformers=fake_transformers):
                result = worker.review(model, files, pcm, focuses)
                (model / "tokenizer_config.json").write_text('{"changed":true}')
                changed = worker.review(model, files, pcm, focuses)
        self.assertEqual(seen["pcm"], pcm)
        self.assertEqual(seen["scale"], 32768)
        self.assertEqual(seen["inputs"]["sampling_rate"], 16000)
        self.assertIsInstance(seen["generation"]["input_features"][0], Audio)
        self.assertTrue(seen["model"]["local_files_only"])
        self.assertTrue(seen["model"]["use_safetensors"])
        self.assertFalse(seen["model"]["trust_remote_code"])
        self.assertFalse(seen["generation"]["do_sample"])
        self.assertEqual(seen["generation"]["max_new_tokens"], 768)
        self.assertNotEqual(result["engine"]["modelHash"], changed["engine"]["modelHash"])
        self.assertIn("slow pulse", result["review"])
        self.assertIn("actual feelings", seen["conversation"][0]["content"][1]["text"])


if __name__ == "__main__":
    unittest.main()
