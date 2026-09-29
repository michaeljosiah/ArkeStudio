import { createHash } from "node:crypto";
import { z } from "zod";
import manifest from "./indextts25-manifest.json" with { type: "json" };

const ArchiveSchema = z.object({ url: z.string(), sha256: z.string(), sizeBytes: z.number() });
type PinnedArchive = z.infer<typeof ArchiveSchema>;
const IndexTtsManifestSchema = z.object({
  schemaVersion: z.number(), model: z.string(), verifiedAt: z.string(),
  source: z.object({ repository: z.string(), commit: z.string(), archive: ArchiveSchema.extend({ root: z.string() }).strict() }).strict(),
  python: z.object({
    version: z.string(), platform: z.string(), arch: z.string(), resolver: z.string(),
    lockFile: z.string(), lockSha256: z.string(), packageCount: z.number(),
    installationVerified: z.boolean(), offlineInferenceVerified: z.boolean(), bundle: ArchiveSchema.strict().nullable(),
  }).strict(),
  models: z.array(z.object({ name: z.string(), repository: z.string(), revision: z.string(), files: z.array(
    ArchiveSchema.extend({ file: z.string(), sizeMb: z.number() }).strict(),
  ) }).strict()),
}).strict();
export type IndexTtsManifest = z.infer<typeof IndexTtsManifestSchema>;

export const INDEXTTS25_MANIFEST: IndexTtsManifest = manifest;

// Read from the pinned suite's downloader and infer_v2_5.py, independently of the manifest.
// In 2.5 codec.pth replaces the legacy MaskGCT download. The Qwen folder is still required by
// the suite's completeness check, even when this graph does not request emotion-text inference.
export const INDEXTTS25_REQUIRED_FILES: Readonly<Record<string, readonly string[]>> = {
  "IndexTTS-2.5": [
    "LICENSE", "config.yaml", "codec.pth", "feat1.pt", "feat2.pt", "gpt.pth", "s2mel.pth",
    "multilingual_zh_ja_yue_char_del.tiktoken", "wav2vec2bert_stats.pt",
    ...["Modelfile", "added_tokens.json", "chat_template.jinja", "config.json", "generation_config.json",
      "merges.txt", "model.safetensors", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "vocab.json"]
      .map(file => `qwen0.6bemo4-merge/${file}`),
  ],
  "w2v-bert-2.0": ["config.json", "model.safetensors", "preprocessor_config.json"],
  campplus: ["campplus_cn_common.bin"],
  bigvgan_v2_22khz_80band_256x: ["config.json", "bigvgan_generator.pt"],
};
const MODEL_REPOSITORIES: Readonly<Record<string, string>> = {
  "IndexTTS-2.5": "IndexTeam/IndexTTS-2.5",
  "w2v-bert-2.0": "facebook/w2v-bert-2.0",
  campplus: "funasr/campplus",
  bigvgan_v2_22khz_80band_256x: "nvidia/bigvgan_v2_22khz_80band_256x",
};

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const confined = (path: string): boolean => path.length > 0 && !/[\\:]/.test(path) &&
  path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
const hashed = (artifact: PinnedArchive): boolean => SHA256.test(artifact.sha256) &&
  !/^(.)\1+$/.test(artifact.sha256) && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes > 0;
const https = (url: string): boolean => {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash; }
  catch { return false; }
};

/** Build-time validation must catch omissions, not merely check that the remaining rows hash. */
export function indexTtsManifestIssues(input: unknown): string[] {
  const parsed = IndexTtsManifestSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map(issue => `Incomplete dependency manifest: ${issue.path.join(".")} (${issue.message})`);
  const value = parsed.data;
  const issues: string[] = [];
  if (value.schemaVersion !== 1 || value.model !== "IndexTTS-2.5") issues.push("IndexTTS 2.5 manifest identity is invalid");
  const source = value.source;
  if (!COMMIT.test(source.commit) || source.repository !== "https://github.com/diodiogod/TTS-Audio-Suite" ||
    source.archive.url !== `https://codeload.github.com/diodiogod/TTS-Audio-Suite/zip/${source.commit}` ||
    source.archive.root !== `TTS-Audio-Suite-${source.commit}` || !hashed(source.archive)) {
    issues.push("TTS-Audio-Suite source archive is not immutable and hash-pinned");
  }
  const python = value.python;
  if (python.version !== "3.13.11" || python.platform !== "win32" || python.arch !== "x64" ||
    !confined(python.lockFile) || !SHA256.test(python.lockSha256) || !Number.isSafeInteger(python.packageCount) || python.packageCount < 1) {
    issues.push("Python dependency lock is missing or has an unsupported target");
  }
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const groups = new Set<string>();
  for (const group of value.models) {
    if (groups.has(group.name)) issues.push(`Duplicate model group: ${group.name}`);
    groups.add(group.name);
    if (!INDEXTTS25_REQUIRED_FILES[group.name]) issues.push(`Unexpected model group: ${group.name}`);
    if (MODEL_REPOSITORIES[group.name] !== group.repository) issues.push(`Unexpected model repository: ${group.name}`);
    if (!COMMIT.test(group.revision)) issues.push(`Model revision is not immutable: ${group.name}`);
    for (const file of group.files) {
      const prefix = `TTS/IndexTTS/${group.name}/`;
      const remote = file.file.slice(prefix.length);
      if (!confined(file.file) || !file.file.startsWith(prefix)) issues.push(`Unsafe model destination: ${file.file}`);
      if (foldedPaths.has(file.file.toLowerCase())) issues.push(`Duplicate model destination: ${file.file}`);
      foldedPaths.add(file.file.toLowerCase());
      paths.add(file.file);
      if (!hashed(file) || !Number.isFinite(file.sizeMb) || Math.abs(file.sizeMb * 1048576 - file.sizeBytes) > 1) {
        issues.push(`Model hash or size is invalid: ${file.file}`);
      }
      if (!https(file.url) || file.url !== `https://huggingface.co/${group.repository}/resolve/${group.revision}/${remote}`) {
        issues.push(`Model URL does not match its pinned revision: ${file.file}`);
      }
    }
  }
  for (const [group, files] of Object.entries(INDEXTTS25_REQUIRED_FILES)) {
    for (const file of files) {
      const destination = `TTS/IndexTTS/${group}/${file}`;
      if (!paths.has(destination)) issues.push(`Required model artifact is missing: ${destination}`);
    }
  }
  return issues;
}

/** A resolved source lock is not proof that a clean, offline runtime can execute this recipe. */
export function indexTtsBuildAvailability(value: unknown): {
  status: "available" | "unsupported_in_build"; reason?: string; issues: string[];
} {
  const issues = indexTtsManifestIssues(value);
  // Publishing a bundle alone cannot enable a recipe whose managed installer does not consume it.
  // Remove this build constraint only with the atomic source/dependency installation and checks.
  issues.push("managed installation of the pinned TTS source and Python bundle is not integrated in this build");
  const python = IndexTtsManifestSchema.safeParse(value);
  if (!python.success || !python.data.python.installationVerified) issues.push("the locked Python dependency installation has not passed verification");
  if (!python.success || !python.data.python.offlineInferenceVerified) issues.push("offline cloned-voice inference has not passed verification");
  const bundle = python.success ? python.data.python.bundle : null;
  if (!bundle || !https(bundle.url) || !hashed(bundle)) {
    issues.push("a tested, hash-pinned Python dependency bundle has not been published");
  }
  return issues.length === 0 ? { status: "available", issues } : {
    status: "unsupported_in_build",
    reason: `Cloned voice setup is unavailable in this build: ${issues.join("; ")}.`,
    issues,
  };
}

export const INDEXTTS25_CHECKPOINTS = INDEXTTS25_MANIFEST.models.flatMap(group => group.files);
export const INDEXTTS25_BUILD = indexTtsBuildAvailability(INDEXTTS25_MANIFEST);
// Source, lock and model changes must invalidate the frozen dependency identity together.
export const INDEXTTS25_DEPENDENCY_DIGEST = createHash("sha256").update(JSON.stringify(INDEXTTS25_MANIFEST)).digest("hex");
