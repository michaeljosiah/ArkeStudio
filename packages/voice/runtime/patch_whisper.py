"""Build the minimal deterministic MIT Faster Whisper adaptation for managed speech.

Only NumPy input is supported. The application owns bounded separate-process
decoding, so neither PyAV nor a linked FFmpeg dependency belongs in this wheel.
The upstream recognition, features, VAD, tokenizer and weights are unchanged.
"""
import argparse
import base64
import csv
import hashlib
import io
from pathlib import Path
import zipfile
import tarfile

UPSTREAM_SHA256 = "79a66ad50688c0b794dd501dc340a736992a6342f7f95e5811be60b5224a26a7"
VERSION = "1.2.1+arke.1"


def build(source, destination):
    if hashlib.sha256(source.read_bytes()).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("The upstream Faster Whisper wheel checksum is incorrect")
    old_info, new_info = "faster_whisper-1.2.1.dist-info", f"faster_whisper-{VERSION}.dist-info"
    files = {}
    with zipfile.ZipFile(source) as archive:
        for name in archive.namelist():
            if name.endswith("/") or name.endswith("/RECORD"):
                continue
            data = archive.read(name)
            if name == "faster_whisper/audio.py":
                original = data.decode("utf-8")
                pad = original[original.index("def pad_or_trim("):]
                data = ('"""Arke adaptation: NumPy audio only; the host owns separate FFmpeg decoding.\n'
                    'Recognition and feature padding remain the upstream MIT implementation.\n"""\nimport numpy as np\n\n'
                    'def decode_audio(*args, **kwargs):\n'
                    '    raise ValueError("This managed build accepts decoded NumPy audio only.")\n\n\n' + pad).encode()
            if name == old_info + "/METADATA":
                metadata = data.decode("utf-8")
                if metadata.count("Requires-Dist: av>=11") != 1:
                    raise ValueError("The upstream audio dependency changed")
                data = metadata.replace("Version: 1.2.1\n", f"Version: {VERSION}\n", 1).replace("Requires-Dist: av>=11\n", "").encode()
            files[name.replace(old_info, new_info)] = data
    files[new_info + "/ARKE-ADAPTATION.txt"] = (
        "Faster Whisper 1.2.1, MIT, Copyright SYSTRAN. Original LICENSE is retained.\n"
        f"Upstream wheel SHA-256: {UPSTREAM_SHA256}\n"
        "Changes: disable file decoding and remove its unused PyAV dependency; accept NumPy arrays.\n"
        "Recognition implementation and model weights are unchanged.\n"
        "Build/adaptation source: packages/voice/runtime/patch_whisper.py in Arke Studio.\n").encode()
    write_wheel(files, new_info, destination, f"faster_whisper-{VERSION}-py3-none-any.whl")


def build_docopt(source, destination):
    if hashlib.sha256(source.read_bytes()).hexdigest() != "49b3a825280bd66b3aa83585ef59c4a8c82f2c8a522dbe754a8bc8d08c85c491":
        raise ValueError("The upstream docopt source checksum is incorrect")
    info = "docopt-0.6.2.dist-info"
    with tarfile.open(source) as archive:
        def read(name):
            return archive.extractfile("docopt-0.6.2/" + name).read()
        files = {"docopt.py": read("docopt.py"), info + "/LICENSE-MIT": read("LICENSE-MIT"),
            info + "/METADATA": read("PKG-INFO").replace(b"Metadata-Version: 1.1", b"Metadata-Version: 2.1", 1),
            info + "/WHEEL": b"Wheel-Version: 1.0\nGenerator: Arke pure-source packing\nRoot-Is-Purelib: true\nTag: py3-none-any\n"}
    write_wheel(files, info, destination, "docopt-0.6.2-py3-none-any.whl")


def write_wheel(files, new_info, destination, filename):
    rows = []
    for name, data in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
        rows.append([name, "sha256=" + digest, len(data)])
    rows.append([new_info + "/RECORD", "", ""])
    record = io.StringIO(newline=""); csv.writer(record, lineterminator="\n").writerows(rows)
    files[new_info + "/RECORD"] = record.getvalue().encode()
    output = destination / filename
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 9, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    print(hashlib.sha256(output.read_bytes()).hexdigest(), output.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path); parser.add_argument("destination", type=Path)
    parser.add_argument("--docopt", action="store_true")
    options = parser.parse_args(); (build_docopt if options.docopt else build)(options.source, options.destination)
