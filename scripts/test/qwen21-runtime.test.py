"""No Torch/GPU required: verify registration and live guard against backend changes."""
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[2] / "vendor/comfyui/ArkeQwen21Runtime/__init__.py"


def load(enabled=True, reserve=4.5, **overrides):
    args = types.SimpleNamespace(disable_dynamic_vram=enabled, disable_pinned_memory=enabled,
                                 disable_async_offload=enabled, disable_cuda_malloc=enabled,
                                 reserve_vram=reserve)
    vars(args).update(overrides)
    backends = {"cuda": {"disabled": False}, "triton": {"disabled": False}}
    kitchen = types.ModuleType("comfy_kitchen")
    kitchen.disable_backend = lambda name: backends[name].update(disabled=True)
    kitchen.list_backends = lambda: backends
    cli = types.ModuleType("comfy.cli_args")
    cli.args = args
    with patch.dict(sys.modules, {"comfy": types.ModuleType("comfy"), "comfy.cli_args": cli, "comfy_kitchen": kitchen}):
        spec = importlib.util.spec_from_file_location("qwen_runtime_test", SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module, args, backends


class RuntimeTest(unittest.TestCase):
    def test_normal_engine_is_unchanged_and_recipe_unavailable(self):
        module, _, backends = load(False)
        self.assertEqual(module.NODE_CLASS_MAPPINGS, {})
        self.assertFalse(backends["cuda"]["disabled"])

    def test_insufficient_reserve_is_not_advertised(self):
        module, _, _ = load(reserve=2.5)
        self.assertEqual(module.NODE_CLASS_MAPPINGS, {})

    def test_conflicting_enable_or_cpu_is_not_advertised(self):
        for override in ({"enable_dynamic_vram": True}, {"cpu": True}):
            module, _, backends = load(**override)
            self.assertEqual(module.NODE_CLASS_MAPPINGS, {})
            self.assertFalse(backends["cuda"]["disabled"])

    def test_opt_in_and_live_backend_or_flag_change(self):
        module, args, backends = load()
        node = module.NODE_CLASS_MAPPINGS["ArkeQwen21Runtime"]()
        model = object()
        self.assertEqual(node.check(model), (model,))
        self.assertIs(node.VALIDATE_INPUTS(), True)
        backends["cuda"]["disabled"] = False
        with self.assertRaises(RuntimeError):
            node.check(model)
        backends["cuda"]["disabled"] = True
        args.disable_pinned_memory = False
        self.assertIsInstance(node.VALIDATE_INPUTS(), str)


if __name__ == "__main__":
    unittest.main()
