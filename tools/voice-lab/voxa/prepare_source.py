"""Read-only snapshot of the seven Voxa modules needed by the native audition."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

MODULES = ("Voxa.Core", "Voxa.Transports.WebSocket", "Voxa.Speech.Abstractions",
           "Voxa.Speech.Kokoro", "Voxa.Speech.WhisperCpp", "Voxa.Audio.SileroVad", "Voxa.Audio.Onnx")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    records = {}
    for module in MODULES:
        source = args.source / "src" / module
        target = args.destination / "src" / module
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("bin", "obj"), dirs_exist_ok=True)
        for file in sorted(target.rglob("*")):
            if file.is_file():
                records[file.relative_to(args.destination).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    (args.destination / "source-manifest.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
