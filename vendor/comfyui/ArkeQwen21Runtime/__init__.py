"""Opt-in runtime guard for Arke's measured Qwen 2.1 recipe (AGPL-3.0-only)."""
import logging
from comfy.cli_args import args
import comfy_kitchen as kitchen


def configured():
    # ComfyUI gives an explicit enable precedence over disable; accepting both would
    # advertise the very dynamic-loading path this profile was introduced to avoid.
    if getattr(args, "enable_dynamic_vram", False) or getattr(args, "cpu", False):
        return False
    return all(getattr(args, name, False) for name in (
        "disable_dynamic_vram", "disable_pinned_memory", "disable_async_offload",
        "disable_cuda_malloc",
    )) and (getattr(args, "reserve_vram", None) or 0) >= 4.5


def profile_error():
    if not configured():
        return "Qwen Image 2.1 needs the conservative launch profile; see Arke's Qwen setup guide."
    backends = kitchen.list_backends()
    if not backends.get("cuda", {}).get("disabled", False) or not backends.get("triton", {}).get("disabled", False):
        return "Qwen Image 2.1 needs the eager kernel backend; restart with the conservative launch profile."
    return None


class ArkeQwen21Runtime:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "check"
    CATEGORY = "Arke/runtime"

    @classmethod
    def VALIDATE_INPUTS(cls):
        return profile_error() or True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # A cached pass-through must not hide another extension changing the backend.
        return float("nan")

    def check(self, model):
        error = profile_error()
        if error:
            raise RuntimeError(error)
        return (model,)


# Presence in /object_info is the engine service's existing readiness gate. A normal
# launch neither changes its kernels nor advertises this recipe's runtime dependency.
NODE_CLASS_MAPPINGS = {}
if configured():
    kitchen.disable_backend("cuda")
    kitchen.disable_backend("triton")
    NODE_CLASS_MAPPINGS["ArkeQwen21Runtime"] = ArkeQwen21Runtime
else:
    logging.info("Arke Qwen Image 2.1 is unavailable: start with its conservative launch profile.")
NODE_DISPLAY_NAME_MAPPINGS = {"ArkeQwen21Runtime": "Qwen Image 2.1 runtime"}
