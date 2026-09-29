"""Import smoke only: run inside a fresh environment synced from the candidate lock."""
import argparse
import json
import os
from pathlib import Path
import platform
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--suite-path", type=Path, required=True, help="Root of the verified, extracted suite archive")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "packages/providers/src/comfyui/indextts25-manifest.json").read_text())
if platform.python_version() != manifest["python"]["version"] or sys.platform != manifest["python"]["platform"]:
    parser.error("Use the Python version and platform pinned by the manifest")
suite = args.suite_path.resolve()
if not (suite / "engines/index_tts/indextts/infer_v2_5.py").is_file():
    parser.error("The suite path does not contain the IndexTTS 2.5 inference module")

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1", CUDA_VISIBLE_DEVICES="")


def reject_socket_connections(event, _args):
    if event in {"socket.connect", "socket.sendto", "socket.getaddrinfo"}:
        raise RuntimeError("Python socket networking is disabled for the dependency import smoke test")


sys.addaudithook(reject_socket_connections)
sys.path.insert(0, str(suite))
sys.path.insert(0, str(suite / "engines/index_tts"))
from indextts.infer_v2_5 import IndexTTS2

assert IndexTTS2 is not None
print("IndexTTS 2.5 inference module imported with Python socket connections blocked; graph inference was not tested.")
