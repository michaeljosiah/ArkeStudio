"""Standard-library tests for archive safety and the exact Ming task API mapping."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ming_worker", ROOT / "packages/coordinator/src/local-ai/ming-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_obviously_truncated_reads_are_not_published_as_success(self):
        text = "A word " * 20
        with self.assertRaisesRegex(ValueError, "stopped too early"):
            worker.validate_audio_length(text, 44100, 44100)
        worker.validate_audio_length(text, 12 * 44100, 44100)

    def test_cloning_uses_reference_words_only_as_prompt(self):
        for variant, task in (("dense", "TTS"), ("tiny", "seed")):
            request = worker.task_request(variant, "New words.", "voice.wav", "Reference words.", "en", None, 3)
            self.assertEqual(request["task"], task)
            self.assertEqual(request["text"], "New words.")
            self.assertEqual(request["prompt_text"], "Reference words.")

    def test_freeform_retains_speaker_but_does_not_send_invalid_prompt_text(self):
        for variant in ("dense", "tiny"):
            request = worker.task_request(variant, "New words.", "voice.wav", "Reference words.", "en", "Quiet anger.", 3)
            self.assertNotIn("prompt_text", request)
            self.assertEqual(request["instruction"], "Quiet anger.")
            self.assertEqual(request["text"], "New words.")
            self.assertEqual(request["prompt_wav_path" if variant == "dense" else "prompt_wav"], "voice.wav")
        self.assertNotIn("target_language", request)

    def test_archive_hash_and_traversal_are_rejected_before_writing_outside(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as target:
                target.writestr("../outside.py", "unsafe")
            expected = {"bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                worker.extract_verified(archive, expected, root / "out")
            self.assertFalse((root / "outside.py").exists())
            expected["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "verification"):
                worker.extract_verified(archive, expected, root / "out")

    def test_verified_extraction_and_sdk_allowlist(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "sdk.zip"
            with zipfile.ZipFile(archive, "w") as target:
                target.writestr("tools/include/Python.h", "header")
                target.writestr("tools/python.exe", "must not extract")
            expected = {"bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            worker.extract_verified(archive, expected, root / "out", sdk=True)
            self.assertEqual((root / "out/include/Python.h").read_text(), "header")
            self.assertFalse((root / "out/python.exe").exists())


if __name__ == "__main__":
    unittest.main()
