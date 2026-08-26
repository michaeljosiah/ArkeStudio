import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ArtifactSidecar, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { characterPickerSources, worldPickerSources } from "../src/components/reference-picker.js";

/**
 * A generated character reference on the world's shelf (issue 475).
 *
 * The picture was on the character and off the shelf: absent from Artifacts, from its counts,
 * and from the artifact lane of the picker. Filing it puts it in all three — and puts the same
 * bytes in two lanes at once, which is why the character lane now picks by artifact identity
 * rather than offering a second name for one file.
 */

const SHEET = "maren-kest";
const TAKE = "tk_01J8F3K2QW9VZX4N7M0RTYB6HZ";
const SOURCE_FILE = `references/${SHEET}/takes/${TAKE}/main-photo-g1-1.png`;

function generatedReference(overrides: Partial<ArtifactSidecar> = {}): ArtifactSidecar {
  return {
    id: "ar_01J8G0000000000000000000R7",
    kind: "image",
    file: "maren-kest-main-photo-candidate.png",
    hash: "sha256:9b1c02b9c44d7f31",
    origin: { by: "system", producedBy: "character-reference" },
    links: [SHEET],
    generation: {
      source: "character-reference",
      jobId: "jb_01J8E0000000000000000000M1",
      takeId: TAKE,
      sheetId: SHEET,
      workflow: "main-photo-candidate",
      sourceFile: SOURCE_FILE,
      prompt: "a face against the tide-wall",
      references: [],
      provider: "fal",
      model: "flux-2-pro",
      params: {},
      provenance: { canonRevision: 42, sheets: { [SHEET]: 4 }, artDirectionVersion: 3 },
      estimatedMicroUsd: 47000,
      costMicroUsd: null,
    },
    created: "2026-08-26T12:00:00.000Z",
    ...overrides,
  } as ArtifactSidecar;
}

function withArtifact(artifact: ArtifactSidecar): ClientState {
  return {
    ...FIXTURE_STATE,
    world: { ...FIXTURE_STATE.world!, artifacts: [...FIXTURE_STATE.world!.artifacts, artifact] },
  };
}

function renderAt(path: string, state: ClientState): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("the Artifacts shelf holds what a character generated", () => {
  it("shows the card, counts it, and says where it came from", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts`, withArtifact(generatedReference()));
    assert.match(html, /maren-kest-main-photo-candidate\.png/, "the image is on the shelf");
    // Its own word, not the bench's: a shelf that called both "made here" could not answer
    // "which of these came from a character?".
    assert.match(html, /character reference/);
    assert.match(html, /Made here 1/, "and it counts as something this application made");
  });

  it("keeps a rejected result on the shelf — no Keep press was ever required", () => {
    // Nothing about the card is conditional on a review decision; the shelf is the durable
    // history of what was made, and the kit's verdict lives in the kit.
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts`, withArtifact(generatedReference()));
    assert.match(html, /maren-kest-main-photo-candidate\.png/);
  });
});

describe("one identity for one generated picture", () => {
  const artifact = generatedReference();
  const world = {
    sheets: [{ id: SHEET, name: "Maren Kest" }],
    referenceKits: [
      { sheetId: SHEET, mainPhoto: { file: `takes/${TAKE}/main-photo-g1-1.png` }, tiles: [], looks: [] },
    ],
    referenceTakes: [{ id: TAKE, reference: { sheetId: SHEET }, media: "main-photo-g1-1.png" }],
    referenceCandidates: {},
    artifacts: [artifact],
  } as never;

  it("offers the artifact lane the generated picture", () => {
    const rows = worldPickerSources([artifact], null);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.pick, { source: "artifact", artifactId: artifact.id });
    assert.match(rows[0]!.meta, /character reference/);
  });

  it("picks the character row by artifact id, so the two lanes share one token", () => {
    const rows = characterPickerSources(world, null);
    const filed = rows.filter((r) => r.key === `artifact:${artifact.id}`);
    assert.equal(filed.length, 1, "the kit and its take name one picture, not two");
    assert.deepEqual(filed[0]!.pick, { source: "artifact", artifactId: artifact.id });
    // The character's own words are what a person searches by, so the row keeps them.
    assert.match(filed[0]!.name, /Maren Kest/);
    assert.equal(
      rows.some((r) => r.key === `file:${SOURCE_FILE}`),
      false,
      "and the same file is not also offered under a world-file identity",
    );
  });

  it("still names a picture no artifact was filed from by its path", () => {
    const rows = characterPickerSources({ ...(world as object), artifacts: [] } as never, null);
    assert.equal(rows.some((r) => r.key === `file:${SOURCE_FILE}`), true);
  });

  /**
   * Two artifacts can name one source file, because the legacy tile path lands every
   * regeneration of an angle on the SAME filename. Bundle order is the scan's alphabetical
   * sort, and the collision name `…-front-2.png.json` sorts BEFORE `…-front.png.json`, so
   * last-write-wins picked the OLDEST bytes while the row's thumbnail showed the newest.
   */
  it("hands back the newest artifact when a tile was regenerated over its own filename", () => {
    const TILE = `references/${SHEET}/incoming/head-front.png`;
    const tileArtifact = (id: string, file: string, created: string) =>
      generatedReference({
        id,
        file,
        created,
        links: [SHEET],
        generation: {
          ...generatedReference().generation,
          workflow: "reference-tile",
          takeId: undefined,
          sourceFile: TILE,
        },
      } as never);
    // In the order scanWorld yields them: "…-2.png.json" sorts first, the original sorts last.
    const older = tileArtifact("ar_01J8G0000000000000000000A1", "maren-kest-head-front.png", "2026-08-01T09:00:00.000Z");
    const newer = tileArtifact("ar_01J8G0000000000000000000B2", "maren-kest-head-front-2.png", "2026-08-20T09:00:00.000Z");
    const rows = characterPickerSources(
      {
        sheets: [{ id: SHEET, name: "Maren Kest" }],
        referenceKits: [{ sheetId: SHEET, tiles: [{ angle: "head-front", file: "incoming/head-front.png" }], looks: [] }],
        referenceTakes: [],
        referenceCandidates: {},
        artifacts: [newer, older],
      } as never,
      null,
    );
    const tile = rows.find((r) => r.imagePath === TILE)!;
    assert.deepEqual(
      tile.pick,
      { source: "artifact", artifactId: newer.id },
      "the picture on screen and the bytes a generation would carry are the same one",
    );
  });

  it("keeps a world-file identity the session already carries, rather than minting a second token", () => {
    // A session that picked the picture before an artifact existed for it. Aliasing the row to
    // the artifact id would lose this registry entry, so the row would read as addable again and
    // the coordinator would allocate a SECOND token for one picture.
    const session = {
      tokenRegistry: [{ token: "Image 1", kind: "image", source: { source: "world-file", path: SOURCE_FILE } }],
      composer: { activeTokens: ["Image 1"], keyframeTokens: [] },
    } as never;
    const rows = characterPickerSources(world, session);
    const row = rows.find((r) => r.imagePath === SOURCE_FILE)!;
    assert.equal(row.key, `file:${SOURCE_FILE}`, "the identity the session knows is the one offered");
    assert.equal(row.existingToken, "Image 1");
    assert.equal(row.active, true, "so it reads as already riding rather than as addable");
  });
});
