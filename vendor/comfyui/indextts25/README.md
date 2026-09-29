# IndexTTS 2.5 dependency candidate

The authoritative artifact manifest is
`packages/providers/src/comfyui/indextts25-manifest.json`. It pins the upstream suite archive,
the model dependency closure and the digest of this Python lock. These files do not enable
managed installation by themselves. See [the integration status](../../../docs/development/indextts25.md).

`requirements.in` is the requirements file from TTS-Audio-Suite commit
`dedd982ab999633d5296c3e5a152ef772941fb82`, with one addition: `matplotlib`. The pinned
IndexTTS BigVGAN imports it directly, while upstream installs it through `install.py` instead
of listing it in requirements.txt. The upstream MIT licence is retained here.

`constraints.txt` fixes the inference stack versions used for this validation.
`requirements-win-py313.lock` resolves the full suite requirements to 193 exact versions
with distribution SHA-256 hashes. It was installed in an empty Windows x64 Python 3.13.11
environment using uv 0.12.20, and `indextts.infer_v2_5` imported with outbound sockets disabled.
This does not establish that all suite engines work or that a complete ComfyUI graph runs.

To reproduce the dependency installation, use a **new environment**, not an existing ComfyUI:

```powershell
uv venv work/indextts-validation --python 3.13.11
uv pip sync vendor/comfyui/indextts25/requirements-win-py313.lock --python work/indextts-validation/Scripts/python.exe --require-hashes --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match
work/indextts-validation/Scripts/python.exe scripts/check-indextts25-import.py --suite-path <verified-extracted-suite>
```

To intentionally regenerate the candidate lock with uv 0.12.20:

```powershell
uv pip compile vendor/comfyui/indextts25/requirements.in --constraint vendor/comfyui/indextts25/constraints.txt --extra-index-url https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match --python-platform x86_64-pc-windows-msvc --python-version 3.13.11 --generate-hashes --no-header --no-annotate --output-file vendor/comfyui/indextts25/requirements-win-py313.lock
```

Review changed distributions, repeat the clean install and offline import check, then update
the manifest's lock digest and package count and bump the recipe version. A source-distribution
hash does not pin the build toolchain or produce a portable binary bundle. The successful
local install built several source distributions. A production bundle still needs a controlled
wheel build, retained notices, digest verification and an offline ComfyUI inference check.
Do not set the bundle or inference verification fields merely because resolution/imports pass.
The import check blocks Python socket calls and requests no GPU memory. It is dependency smoke
coverage, not an operating-system network sandbox or an offline synthesis test.
