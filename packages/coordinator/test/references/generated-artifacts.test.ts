import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactSidecarSchema,
  CHARACTER_REFERENCE_ARTIFACT_TARGETS,
  type ArtifactSidecar,
  type Job,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { recordReferenceReview } from "../../src/references/takes.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { pngBytes } from "../queue/fake-provider.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Every generated character reference is also a world artifact (issue 475).
 *
 * A paid picture used to be visible on the character's own surface and absent from the world's
 * shelf: the bytes were under `references/` and the artifact registry had never heard of them.
 * These drive the real `onJobTerminal`, not the filing helper, because the gap that shipped was
 * a missing CALL — the writer existed and worked and nothing on the character path reached it.
 */

const CLOCK = "2026-08-26T12:00:00.000Z";

const SHEET = "maren-kest";

/** A well-formed job id ending in `tag` — ULID shape, because the sidecar is parsed back. */
function jobId(tag: string): Job["id"] {
  return `jb_01J8E${"0".repeat(26 - 5 - tag.length)}${tag}` as Job["id"];
}

/** A succeeded character-image job, landed and ready to finalize. */
function generatedJob(input: {
  id: string;
  kind: Job["target"]["kind"];
  targetId: string;
  landed: string;
  sheetVersion: number;
  provider?: string;
  model?: string;
  params?: Record<string, unknown>;
  createdAt?: string;
}): Job {
  return {
    id: input.id as Job["id"],
    idempotencyKey: input.id.slice(3) as Job["idempotencyKey"],
    worldId: WORLD_ID,
    target: { kind: input.kind, id: input.targetId },
    capability: "image",
    provider: input.provider ?? "fal",
    model: input.model ?? "flux-2-pro",
    params: {
      prompt: "a face against the tide-wall",
      references: [`references/${SHEET}/head-front.png`],
      provenance: {
        canonRevision: 42,
        sheets: { [SHEET]: input.sheetVersion },
        artDirectionVersion: 3,
        anchorFile: "head-front.png",
      },
      artDirection: { version: 3, source: "world", transport: "text" },
      ...input.params,
    },
    estimatedMicroUsd: 47000,
    status: "succeeded",
    providerJobId: `remote-${input.id}`,
    attempt: 1,
    landing: { dir: input.landed.slice(0, input.landed.lastIndexOf("/")) },
    landedFiles: [input.landed],
    error: null,
    createdAt: input.createdAt ?? CLOCK,
    updatedAt: CLOCK,
  };
}

async function openWorld(): Promise<{
  root: string;
  worldDir: string;
  provider: FsWorldProvider;
  coordinator: Coordinator;
  sheetVersion: number;
}> {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
  });
  const sheetVersion = provider.openStore()?.getBundle().sheets.find((s) => s.id === SHEET)?.version ?? 1;
  return { root, worldDir, provider, coordinator, sheetVersion };
}

async function land(worldDir: string, path: string): Promise<void> {
  await mkdir(join(worldDir, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
  await writeFile(join(worldDir, path), pngBytes());
}

async function finalize(coordinator: Coordinator, job: Job): Promise<void> {
  await (coordinator as unknown as { onJobTerminal(terminal: Job): Promise<void> }).onJobTerminal(job);
}

/** Every sidecar under artifacts/, parsed the way the world scan parses them. */
async function sidecars(worldDir: string): Promise<ArtifactSidecar[]> {
  const names = (await readdir(join(worldDir, "artifacts")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".json"),
  );
  const parsed: ArtifactSidecar[] = [];
  for (const name of names) {
    const raw = await readFile(join(worldDir, "artifacts", name), "utf8");
    parsed.push(ArtifactSidecarSchema.parse(JSON.parse(raw)));
  }
  return parsed;
}

function generatedFor(all: ArtifactSidecar[], jobId: string): ArtifactSidecar[] {
  return all.filter((a) => a.generation?.source === "character-reference" && a.generation.jobId === jobId);
}

describe("generated character references become artifacts (issue 475)", () => {
  it("files a main-photo candidate with a system origin and its whole request", async () => {
    const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
    const landed = `references/${SHEET}/candidates/main-photo-g1-1.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("M01"),
      kind: "main-photo-candidate",
      targetId: `${SHEET}/g1/1`,
      landed,
      sheetVersion,
      params: { seed: 4711 },
    });
    await finalize(coordinator, job);

    const filed = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(filed.length, 1, "exactly one artifact for one generated candidate");
    const artifact = filed[0]!;
    assert.equal(artifact.kind, "image");
    // Named for the character and the file the generation made, so a shelf of six references
    // for one person is readable without opening a single sidecar.
    assert.equal(artifact.file, "maren-kest-main-photo-g1-1.png");
    // A trusted origin, stated by the coordinator — never taken from the renderer's word.
    assert.deepEqual(artifact.origin, { by: "system", producedBy: "character-reference" });
    assert.equal(artifact.production, undefined, "the world owns a character's references");
    assert.deepEqual(artifact.links, [SHEET], "linked to the sheet it is a picture of");

    const generation = artifact.generation!;
    assert.equal(generation.source, "character-reference");
    if (generation.source !== "character-reference") throw new Error("unreachable");
    assert.equal(generation.workflow, "main-photo-candidate");
    assert.equal(generation.sheetId, SHEET);
    assert.equal(generation.jobId, job.id);
    assert.equal(generation.takeId, `tk_${job.id.slice(3)}`);
    // Filed from the take's own copy, never from the transient candidates/ staging path.
    assert.equal(generation.sourceFile, `references/${SHEET}/takes/tk_${job.id.slice(3)}/${landed.split("/").pop()}`);
    assert.equal(generation.prompt, "a face against the tide-wall");
    assert.deepEqual(generation.references, [`references/${SHEET}/head-front.png`]);
    assert.equal(generation.provider, "fal");
    assert.equal(generation.model, "flux-2-pro");
    assert.equal(generation.requestedSeed, 4711);
    assert.equal(generation.estimatedMicroUsd, 47000);
    assert.equal(generation.costMicroUsd, null, "no ledger entry, and it says so rather than guessing");
    assert.equal(generation.provenance.canonRevision, 42);
    assert.equal(generation.provenance.sheets[SHEET], sheetVersion);
    assert.equal(generation.provenance.artDirectionVersion, 3);
    assert.equal(generation.params["artDirection"] !== undefined, true, "the request is kept whole");

    // The bytes are a real second copy, and the reference copy is untouched.
    const bytes = await readFile(join(worldDir, "artifacts", artifact.file));
    assert.deepEqual(new Uint8Array(bytes), new Uint8Array(pngBytes()));
    const take = await readFile(
      join(worldDir, "references", SHEET, "takes", `tk_${job.id.slice(3)}`, "take.json"),
      "utf8",
    );
    assert.ok(take.includes(job.id), "the take still owns its own copy and provenance");
    await provider.close();
  });

  it("files an establish candidate that nobody has chosen as the main photo yet", async () => {
    const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
    const landed = `references/${SHEET}/candidates/candidate-2.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("E02"),
      kind: "establish-candidate",
      targetId: `${SHEET}/2`,
      landed,
      sheetVersion,
    });
    await finalize(coordinator, job);

    const filed = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(filed.length, 1, "an unchosen candidate is still something this app made");
    const reviews = await readFile(join(worldDir, "references", "reviews.jsonl"), "utf8").catch(() => "");
    assert.equal(
      reviews.includes(`tk_${job.id.slice(3)}`),
      false,
      "and filing it decided nothing — the take is still awaiting review",
    );
    await provider.close();
  });

  it("files a character sheet whether the composite is designated or outranked", async () => {
    // Designated: the human's own action rule accepts it as it lands.
    {
      const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
      const landed = `references/${SHEET}/incoming/character-sheet-g1.png`;
      await land(worldDir, landed);
      const job = generatedJob({
        id: jobId("S03"),
        kind: "character-sheet",
        targetId: `${SHEET}/g1`,
        landed,
        sheetVersion,
      });
      await finalize(coordinator, job);

      const kit = JSON.parse(
        await readFile(join(worldDir, "references", SHEET, "kit.json"), "utf8"),
      ) as { designatedCompilation?: string };
      assert.equal(kit.designatedCompilation, `takes/tk_${job.id.slice(3)}/character-sheet-g1.png`);
      assert.equal(generatedFor(await sidecars(worldDir), job.id).length, 1);
      await provider.close();
    }
    // Outranked: a later human choice keeps the slot, and the artifact is filed all the same.
    {
      const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
      const landed = `references/${SHEET}/incoming/character-sheet-late.png`;
      await land(worldDir, landed);
      const job = generatedJob({
        id: jobId("S04"),
        kind: "character-sheet",
        targetId: `${SHEET}/late`,
        landed,
        sheetVersion,
        // The fixture's designated compilation was compiled in July; this job began before it.
        createdAt: "2026-07-01T09:00:00.000Z",
      });
      await finalize(coordinator, job);

      const kit = JSON.parse(
        await readFile(join(worldDir, "references", SHEET, "kit.json"), "utf8"),
      ) as { designatedCompilation?: string };
      assert.equal(kit.designatedCompilation, "model-sheet-v4.png", "the earlier human choice keeps the slot");
      assert.equal(
        generatedFor(await sidecars(worldDir), job.id).length,
        1,
        "the composite nobody designated is still on the shelf",
      );
      await provider.close();
    }
  });

  it("files a character look, and keeps it after the look is rejected", async () => {
    const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
    const landed = `references/${SHEET}/looks/incoming/look-g1-1.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("K05"),
      kind: "character-look",
      targetId: `${SHEET}/g1/1`,
      landed,
      sheetVersion,
      params: { lookKind: "costume", lookPrompt: "harbour oilskins" },
    });
    await finalize(coordinator, job);
    const filed = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(filed.length, 1);

    // Rejecting the look changes the kit, never the shelf: the artifact is immutable history.
    const store = provider.openStore()!;
    const take = store.getBundle().referenceTakes.find((t) => t.jobId === job.id)!;
    await recordReferenceReview(store, take, "reject", { field: "identity", note: "not the coat" });
    assert.equal(
      generatedFor(await sidecars(worldDir), job.id).length,
      1,
      "a rejected result stays in Artifacts — the shelf is the history of what was made",
    );
    await provider.close();
  });

  it("files the legacy reference tile without disturbing its kit row", async () => {
    const { worldDir, provider, coordinator } = await openWorld();
    const landed = `references/${SHEET}/incoming/head-profile.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("T06"),
      kind: "reference-tile",
      targetId: `${SHEET}/head-profile`,
      landed,
      sheetVersion: 4,
    });
    await finalize(coordinator, job);

    const kit = JSON.parse(await readFile(join(worldDir, "references", SHEET, "kit.json"), "utf8")) as {
      tiles: Array<{ angle: string; status: string; file?: string }>;
    };
    assert.ok(
      kit.tiles.some((t) => t.angle === "head-profile" && t.status === "generated" && t.file === "incoming/head-profile.png"),
      "the kit tile path is unchanged",
    );
    const filed = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(filed.length, 1);
    const generation = filed[0]!.generation!;
    if (generation.source !== "character-reference") throw new Error("unreachable");
    assert.equal(generation.workflow, "reference-tile");
    // A tile is not a take: it says so rather than naming one that does not exist.
    assert.equal(generation.takeId, undefined);
    assert.equal(generation.sourceFile, landed);
    await provider.close();
  });

  it("files the same artifact once however many times finalization is replayed", async () => {
    const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
    const landed = `references/${SHEET}/candidates/main-photo-g2-1.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("R07"),
      kind: "main-photo-candidate",
      targetId: `${SHEET}/g2/1`,
      landed,
      sheetVersion,
    });
    await finalize(coordinator, job);
    const first = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(first.length, 1);

    // A retry from Activity re-enters the same finalization; the staging copy is already gone.
    await finalize(coordinator, job);
    await finalize(coordinator, job);
    const again = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(again.length, 1, "a replay finds what the first pass filed");
    assert.equal(again[0]!.id, first[0]!.id);

    // And reopening the world does not double it either.
    await provider.close();
    const reopened = new FsWorldProvider(join(worldDir, "..", ".."), { clock: () => CLOCK });
    await reopened.loadWorld(WORLD_ID);
    assert.equal(
      reopened
        .openStore()!
        .getBundle()
        .artifacts.filter(
          (a) => a.generation?.source === "character-reference" && a.generation.jobId === job.id,
        ).length,
      1,
      "the reopened world holds one artifact for one generated result",
    );
    await reopened.close();
  });

  it("files the same way for a local provider as for a remote one", async () => {
    const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
    const landed = `references/${SHEET}/looks/incoming/look-local-1.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("P08"),
      kind: "character-look",
      targetId: `${SHEET}/local/1`,
      landed,
      sheetVersion,
      provider: "comfyui",
      model: "draft-image",
    });
    await finalize(coordinator, job);

    const filed = generatedFor(await sidecars(worldDir), job.id);
    assert.equal(filed.length, 1, "which provider made it changes provenance, not whether it is filed");
    const generation = filed[0]!.generation!;
    if (generation.source !== "character-reference") throw new Error("unreachable");
    assert.equal(generation.provider, "comfyui");
    assert.equal(generation.model, "draft-image");
    await provider.close();
  });

  /**
   * The test that the shipped gap needed. `finalize` reaches the artifact writer through a
   * published set; a workflow added to the set and not to the call would fall straight through
   * and file nothing, which is precisely what happened before this existed.
   */
  it("files an artifact for every workflow the published set names", async () => {
    for (const kind of CHARACTER_REFERENCE_ARTIFACT_TARGETS) {
      const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
      const landed = `references/${SHEET}/incoming/${kind}.png`;
      await land(worldDir, landed);
      const job = generatedJob({
        id: jobId(`W${String([...CHARACTER_REFERENCE_ARTIFACT_TARGETS].indexOf(kind)).padStart(2, "0")}`),
        kind,
        targetId: kind === "reference-tile" ? `${SHEET}/head-profile` : `${SHEET}/set/1`,
        landed,
        sheetVersion,
      });
      await finalize(coordinator, job);
      assert.equal(
        generatedFor(await sidecars(worldDir), job.id).length,
        1,
        `${kind} finalization filed no artifact — the picture would be on the character and off the shelf`,
      );
      await provider.close();
    }
  });

  it("leaves nothing behind when the generation did not succeed", async () => {
    const { worldDir, provider, coordinator, sheetVersion } = await openWorld();
    const landed = `references/${SHEET}/candidates/main-photo-fail-1.png`;
    await land(worldDir, landed);
    const job = generatedJob({
      id: jobId("F09"),
      kind: "main-photo-candidate",
      targetId: `${SHEET}/fail/1`,
      landed,
      sheetVersion,
    });
    await finalize(coordinator, { ...job, status: "failed", error: "the provider refused" });

    assert.equal(
      (await sidecars(worldDir)).some((a) => a.generation?.source === "character-reference"),
      false,
      "a failed generation files no artifact and no sidecar",
    );
    await provider.close();
  });
});
