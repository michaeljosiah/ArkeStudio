"""Exercise ComfyUI's real adapter loader and CUDA patch math, without sampling media.

This is a component probe, not end-to-end recipe verification. Run with ComfyUI's Python.
"""
import argparse
import gc
import hashlib
import json
import logging
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("engine_dir", type=Path)
parser.add_argument("report_dir", type=Path)
args = parser.parse_args()
sys.path.insert(0, str(args.engine_dir.resolve()))
# ComfyUI owns its own argv parser; don't forward this script's paths to it.
sys.argv = [sys.argv[0]]
import torch
import comfy.lora
from safetensors.torch import load_file

root = args.report_dir.resolve()
inventory = json.loads((root / "inventory-report.json").read_text())
bases = json.loads((root / "base-headers.json").read_text())
results = []
runtime = {"torch": torch.__version__, "cuda": torch.version.cuda,
           "gpu": torch.cuda.get_device_name(0), "kind": "loader-and-patch-probe"}


class Warnings(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


for release in inventory["results"]:
    file = root / "weights" / f"{release.get('sha256', '')}.safetensors"
    if not release.get("bytesVerified") or not file.is_file():
        results.append({"id": release["id"], "status": "weights-unavailable"})
        continue
    started = time.monotonic()
    result = {"id": release["id"], "sha256": release["sha256"]}
    warnings = Warnings()
    logging.getLogger().addHandler(warnings)
    try:
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != release["sha256"]:
                raise ValueError("Validation weight hash changed")
        tensors = load_file(str(file), device="cpu")
        non_finite = [key for key, tensor in tensors.items() if not bool(torch.isfinite(tensor).all())]
        result["nonFiniteAlphaKeys"] = [key for key in non_finite if key.endswith(".alpha")]
        if any(not key.endswith(".alpha") for key in non_finite):
            raise ValueError("Adapter contains non-finite weight tensors")
        # Fully factored LoKr uses alpha=1 in this runtime even when its stored scalar is
        # non-finite. Record those scalars; let actual CUDA calculation establish its result.
        matrices = []
        for base_name, header in bases.items():
            mapping = {f"diffusion_model.{key[:-7]}": key for key in header if key.endswith(".weight")}
            patches = comfy.lora.load_lora(tensors, mapping)
            if not patches or warnings.messages:
                raise ValueError("Loader refused or ignored keys: " + "; ".join(warnings.messages[:5]))
            checked = set()
            samples = []
            # Every patch must address a real base tensor. Exercise each distinct loader/shape
            # on CUDA; repeating an identical matrix shape at every block adds no coverage.
            for key, patch in patches.items():
                shape = tuple(header[key]["shape"])
                kind = type(patch).__name__
                if (kind, shape) in checked:
                    continue
                checked.add((kind, shape))
                torch.cuda.reset_peak_memory_stats()
                weight = torch.zeros(shape, device="cuda", dtype=torch.bfloat16)
                updated = patch.calculate_weight(weight, key, 1.0, 1.0, None, lambda value: value)
                torch.cuda.synchronize()
                if updated.shape != weight.shape or not bool(torch.isfinite(updated).all()) or not bool(torch.count_nonzero(updated)):
                    raise ValueError(f"Invalid or ineffective CUDA patch for {key}")
                peak = torch.cuda.max_memory_allocated()
                del updated, weight
                torch.cuda.empty_cache()
                original = patch.weights
                patch.weights = tuple(value.to(device="cuda") if isinstance(value, torch.Tensor) else value for value in original)
                x = torch.sin(torch.arange(shape[1], device="cuda", dtype=torch.float32)).to(torch.bfloat16).unsqueeze(0)
                base_out = torch.zeros((1, shape[0]), device="cuda", dtype=torch.bfloat16)
                bypass = patch.h(x, base_out)
                torch.cuda.synchronize()
                bypass_finite = bypass.shape == base_out.shape and bool(torch.isfinite(bypass).all())
                samples.append({"key": key, "shape": shape, "loader": kind,
                                "peakAllocatedBytes": max(peak, torch.cuda.max_memory_allocated()), "bypassFinite": bypass_finite})
                patch.weights = original
                del bypass, x, base_out
                torch.cuda.empty_cache()
            matrices.append({"base": base_name, "loadedPatches": len(patches), "cudaSamples": samples})
            del patches
        if warnings.messages:
            raise ValueError("Loader reported warnings: " + "; ".join(warnings.messages[:5]))
        bypass_ok = all(sample["bypassFinite"] for matrix in matrices for sample in matrix["cudaSamples"])
        result.update(status="component-probe-passed" if bypass_ok else "bypass-probe-failed", weightPatch="passed", bases=matrices)
        del tensors
    except Exception as error:
        result.update(status="component-probe-failed", reason=str(error))
    finally:
        logging.getLogger().removeHandler(warnings)
        gc.collect()
        torch.cuda.empty_cache()
    result["elapsedSec"] = round(time.monotonic() - started, 3)
    results.append(result)
    print(json.dumps(result), flush=True)
    (root / "loader-report.json").write_text(json.dumps({"runtime": runtime, "results": results}, indent=2))

if any(row["status"] != "component-probe-passed" for row in results):
    raise SystemExit(1)
