"""Input-boundary checks for the standalone audition; no ML dependencies or model download."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("ming_probe", Path(__file__).with_name("probe-ming-tts.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class SuiteBoundaryTests(unittest.TestCase):
    def test_sharded_checkpoint_must_be_complete_and_cannot_escape_model_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory)
            index = model / "model.safetensors.index.json"
            shard = "model-00001-of-00001.safetensors"
            index.write_text(json.dumps({"weight_map": {"weight": shard}}))
            with self.assertRaises(ValueError):
                probe.checkpoint_weights(model, "tiny")
            (model / shard).write_bytes(b"fixture")
            self.assertEqual(probe.checkpoint_weights(model, "tiny"), [model / shard])
            index.write_text(json.dumps({"weight_map": {"weight": "../outside.safetensors"}}))
            with self.assertRaises(ValueError):
                probe.checkpoint_weights(model, "tiny")

    def test_tiny_mapping_keeps_identity_text_seed_and_explicit_decode_ceiling(self):
        mapped = probe.tiny_request({"task": "TTS", "text": "[Sigh] Hello.",
            "prompt_wav_path": "reference.wav", "prompt_text": "Reference words.",
            "language_id": "English", "use_spk_emb": True, "max_decode_steps": 1000}, 1895)
        self.assertEqual(mapped, {"task": "paralinguistic", "text": "[Sigh] Hello.",
            "prompt_wav": "reference.wav", "prompt_text": "Reference words.",
            "target_language": "English", "seed": 1895, "log_every_n_steps": 10,
            "max_decode_steps": 1000})

    def test_windows_environment_preserves_os_bootstrap_and_excludes_credentials(self):
        env = probe.worker_environment(Path("scratch"), {
            "SYSTEMROOT": r"C:\Windows", "SystemDrive": "C:", "PATH": "runtime-path",
            "OPENAI_API_KEY": "must-not-reach-child", "HF_TOKEN": "must-not-reach-child",
        })
        self.assertEqual(env["SYSTEMROOT"], r"C:\Windows")
        self.assertEqual(env["SystemDrive"], "C:")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("HF_TOKEN", env)
        self.assertEqual(env["HF_HUB_OFFLINE"], "1")

    def test_tiny_tonal_tasks_do_not_inherit_the_cloning_language_line(self):
        for task, extra in [
            ("BASIC", {"controls": {"speed": "中速", "pitch": "中", "volume": "低"}}),
            ("EMOTION", {"controls": {"emotion": "愤怒"}}),
            ("FREEFORM", {"instruction": "Whisper quietly."}),
        ]:
            with self.subTest(task=task):
                mapped = probe.tiny_request({"task": task, "text": "Keep the gate closed.",
                    "language_id": "English", "prompt_wav_path": "reference.wav", **extra}, 1895)
                self.assertNotIn("target_language", mapped)
                self.assertEqual(mapped["prompt_wav"], "reference.wav")
                self.assertEqual(mapped["text"], "Keep the gate closed.")
                if "controls" in extra:
                    for name, value in extra["controls"].items():
                        self.assertEqual(mapped[name], value)
                else:
                    self.assertEqual(mapped["instruction"], extra["instruction"])

    def test_rejects_case_filename_escape_before_inference(self):
        for name in ("../outside", "C:/outside", "duplicate.wav", "", "Name"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                suite = Path(directory) / "suite.json"
                suite.write_text(json.dumps({"cases": [{"id": name, "request": {"text": "Hello"}}]}))
                with self.assertRaises(ValueError):
                    probe.load_suite(suite, ".")

    def test_reference_identity_is_bound_to_bytes_and_suite_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = root / "voice.wav"
            reference.write_bytes(b"first recording")
            suite = root / "suite.json"
            suite.write_text(json.dumps({"cases": [{"id": "neutral", "request": {
                "text": "Hello", "prompt_wav_path": "voice.wav"}}]}))
            _, cases = probe.load_suite(suite, "neutral")
            self.assertEqual(cases[0]["request"]["prompt_wav_path"], str(reference.resolve()))
            identity = cases[0]["referenceSha256"]
            reference.write_bytes(b"replacement recording")
            _, changed = probe.load_suite(suite, "neutral")
            self.assertNotEqual(changed[0]["referenceSha256"], identity)
            reference.unlink()
            with self.assertRaises(ValueError):
                probe.load_suite(suite, "neutral")

    def test_refuses_duplicate_ids_and_output_path_override(self):
        with tempfile.TemporaryDirectory() as directory:
            suite = Path(directory) / "suite.json"
            case = {"id": "neutral", "request": {"text": "Hello"}}
            for cases in ([case, case], [{"id": "neutral", "request": {
                "text": "Hello", "output_path": "elsewhere.wav"}}]):
                suite.write_text(json.dumps({"cases": cases}))
                with self.assertRaises(ValueError):
                    probe.load_suite(suite, ".")


if __name__ == "__main__":
    unittest.main()
