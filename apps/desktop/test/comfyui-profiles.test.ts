import assert from "node:assert/strict";
import { it } from "node:test";
import { cudaFreeMemoryArgs, largestCudaDevice, qwenEngineProfile } from "../src/comfyui-profiles.js";

it("Qwen launches and measures the same largest CUDA card even when it is not device zero", () => {
  const device = largestCudaDevice("GPU-aaaa, 8192\nGPU-bbbb, 24576\nGPU-cccc, 10240");
  assert.equal(device, "GPU-bbbb");
  const profile = qwenEngineProfile("C:/bundle", device);
  assert.deepEqual(profile.launch.args.slice(0, 2), ["--cuda-device", device]);
  assert.deepEqual(cudaFreeMemoryArgs(device).slice(-2), ["--id", device]);
  assert.equal(largestCudaDevice("GPU-aaaa, N/A\nnot a device, 32768"), null);
});
