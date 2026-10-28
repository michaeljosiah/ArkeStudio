"""Standard-library tests for archive safety and the exact Ming task API mapping."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ming_worker", ROOT / "packages/coordinator/src/local-ai/ming-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_admitted_expansion_and_entry_bounds_apply_before_any_extraction(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "dependency.zip"
            with zipfile.ZipFile(archive, "w") as target:
                target.writestr("one.py", "12345")
                target.writestr("two.py", "67890")
            expected = {"bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
            dependencies = [(archive, expected, root / "output", "", False)]
            for byte_limit, entry_limit in ((9, 2), (10, 1)):
                with self.assertRaisesRegex(ValueError, "admitted"):
                    worker.extract_dependencies(dependencies, byte_limit, entry_limit)
                self.assertFalse((root / "output").exists())
            self.assertEqual(worker.extract_dependencies(dependencies, 10, 2), 10)
            self.assertEqual((root / "output/one.py").read_text(), "12345")

    def test_audio_budget_checks_the_actual_pcm_size_and_silence_before_writing(self):
        worker.validate_audio_budget(44100 * 600, 44100)
        with self.assertRaisesRegex(ValueError, "ten minutes"):
            worker.validate_audio_budget(44100 * 600 + round(44100 * 0.08), 44100)
        largest = (worker.MAX_AUDIO_BYTES - 4096) // 2
        worker.validate_audio_budget(largest, 192000)
        with self.assertRaisesRegex(ValueError, "audio file limit"):
            worker.validate_audio_budget(largest + 1, 192000)
        for rate in (0, -1, float("nan"), float("inf")):
            with self.assertRaisesRegex(ValueError, "invalid audio size"):
                worker.validate_audio_budget(1, rate)

    def test_every_dependency_is_planned_before_the_first_archive_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dependencies = []
            for name, entries in (("first", [("valid.py", "first")]),
                                  ("last", [("valid.py", "last"), ("../outside.py", "unsafe")])):
                archive = root / (name + ".zip")
                with zipfile.ZipFile(archive, "w") as target:
                    for path, text in entries:
                        target.writestr(path, text)
                expected = {"bytes": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
                dependencies.append((archive, expected, root / name, "", False))
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                worker.extract_dependencies(dependencies)
            self.assertFalse((root / "first").exists())
            self.assertFalse((root / "last").exists())
            self.assertFalse((root / "outside.py").exists())

    def test_oversized_generated_audio_never_reaches_the_wav_writer(self):
        class Samples:
            size = (worker.MAX_AUDIO_BYTES - 4096) // 2 + 1

            def detach(self): return self
            def cpu(self): return self
            def float(self): return self
            def numpy(self): return self
            def reshape(self, _): return self

        noop = lambda *_: None
        torch = SimpleNamespace(__version__="2.14.0+cu130", manual_seed=noop,
                                cuda=SimpleNamespace(is_available=lambda: True, set_device=noop, manual_seed_all=noop),
                                backends=SimpleNamespace(cudnn=SimpleNamespace()))
        np = SimpleNamespace(random=SimpleNamespace(seed=noop), isfinite=lambda _: SimpleNamespace(all=lambda: True))
        writes = []
        sf = SimpleNamespace(info=lambda _: SimpleNamespace(duration=1), write=lambda *args, **kwargs: writes.append(args))
        model = SimpleNamespace(sample_rate=192000, synthesize=lambda **_: Samples())
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            request = {"schemaVersion": 1, "variant": "dense", "chunks": ["One sentence."], "output": str(root / "speech.wav"),
                       "runtime": str(root), "weights": str(root), "reference": "reference.wav", "seed": 1,
                       "language": "en", "transcript": "Reference words."}
            assets = {"source": {"file": "source.zip"}, "sourceRevision": "fixture", "variants": {"dense": {"wheels": [], "expandedBytes": 1, "expandedEntries": 1}}}
            with patch.dict(worker.sys.modules, {"torch": torch, "numpy": np, "soundfile": sf,
                                                "ming_tts": SimpleNamespace(MingTTS=lambda *args, **kwargs: model)}), \
                    patch.object(worker.sys, "version_info", (3, 13)), \
                    patch.object(worker, "adapt_runtime", noop), patch.object(worker, "extract_dependencies", noop), \
                    patch.object(worker.sys, "path", list(worker.sys.path)):
                with self.assertRaisesRegex(ValueError, "audio file limit"):
                    worker.main(request, assets)
            self.assertEqual(writes, [])
            self.assertFalse((root / "result.json").exists())

    def test_declared_entry_size_is_enforced_on_streams(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for text, size, message in ((b"long", 3, "exceeds"), (b"short", 6, "did not match")):
                member = SimpleNamespace(file_size=size)
                source = SimpleNamespace(open=lambda _: io.BytesIO(text))
                with self.assertRaisesRegex(ValueError, message):
                    worker.extract_planned(source, [(member, message)], root)
                self.assertLessEqual((root / message).stat().st_size, size)

    def test_archive_entry_and_total_limits_are_checked_before_extraction(self):
        def entry(name, size):
            return SimpleNamespace(filename=name, file_size=size, external_attr=0, is_dir=lambda: False)
        for entries in ([entry("large.bin", 512 * 1024 ** 2 + 1)],
                        [entry(str(index), 512 * 1024 ** 2) for index in range(4)] + [entry("extra", 1)]):
            with self.assertRaisesRegex(ValueError, "extraction limit"):
                worker.archive_entries(SimpleNamespace(infolist=lambda: entries))

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
            self.assertEqual(worker.extract_verified(archive, expected, root / "out", sdk=True), len("header"))
            self.assertEqual((root / "out/include/Python.h").read_text(), "header")
            self.assertFalse((root / "out/python.exe").exists())


if __name__ == "__main__":
    unittest.main()
