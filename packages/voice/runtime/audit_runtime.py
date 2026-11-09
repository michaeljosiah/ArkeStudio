"""Fail closed on decoder linkage and inventory every redistributed Python package."""
import argparse
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import re
import sys


def audit():
    if importlib.util.find_spec("av") is not None:
        raise ValueError("PyAV must not be installed in the managed speech process")
    import faster_whisper
    import soundfile
    import soxr
    import onnxruntime
    assert faster_whisper.__version__ == "1.2.1"  # unchanged recognition source
    assert "av" not in sys.modules
    assert soundfile.__libsndfile_version__ == "1.2.2"
    rows = []
    for dist in sorted(importlib.metadata.distributions(), key=lambda item: item.metadata["Name"].lower()):
        name = dist.metadata["Name"]
        licences = [str(path) for path in dist.files or [] if re.search(r"(^|/)(licen[cs]e|copying|notice|third.?party)", str(path), re.I)]
        declared = dist.metadata.get("License-Expression") or dist.metadata.get("License") or "; ".join(
            value for value in dist.metadata.get_all("Classifier", []) if value.startswith("License ::"))
        if not licences:
            raise ValueError(f"{name} lacks a redistributed licence/notice file")
        rows.append({"name": name, "version": dist.version, "declaredLicense": declared, "licenseFiles": licences})
    root = Path(sys.prefix)
    if any(re.search(r"^(avcodec|avformat|avutil|swscale|swresample|libx264|libx265)", path.name, re.I) for path in root.rglob("*.dll")):
        raise ValueError("An embedded FFmpeg/codec DLL remains in the speech runtime")
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args(); rows = audit()
    options.output.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    print(f"Verified {len(rows)} Python package notices; no embedded FFmpeg decoder")
