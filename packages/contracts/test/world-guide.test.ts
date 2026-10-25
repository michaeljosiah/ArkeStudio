import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_GUIDE_RECORD,
  guideCounts,
  guideDocument,
  guideLoreText,
  guidePublicText,
  guideSections,
  GuideRecordSchema,
  guideTheme,
  readGuide,
  sameGuideTeaser,
  SetGuideTeasersSchema,
  type CanonEntry,
  type GuideMaterial,
  type GuideRecord,
  type Sheet,
  type WorldAsset,
} from "../src/index.js";

// SPEC-059 R-1 – R-5, R-11, R-12: what a world's Guide makes public, read from the sheets and canon
// as they are now. The text is the fixture world's own.
const sheet = (id: string, type: Sheet["type"], sections: Array<[string, string]>, extra: Partial<Sheet> = {}): Sheet => ({
  id,
  type,
  name: id.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "),
  version: 1,
  status: "locked",
  canonRules: [],
  links: [],
  created: "2026-05-02",
  updated: "2026-08-07",
  sections: sections.map(([heading, body]) => ({ heading, body })),
  ...extra,
});
const canon = (id: string, status: CanonEntry["status"], body: string, extra: Partial<CanonEntry> = {}): CanonEntry => ({ id, type: "lore", title: id, status, introducedAt: 1, links: [], body, ...extra });

const MAREN_ESSENCE = `Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go.

> Room note: keep her fallible as a listener. The calling is skill; the hearing is weather. The
> moment she translates the Keeper reliably, the mystery becomes a radio.

> She does not sing; she listens.`;
const UNDERSONG = `Beneath the harbour lies a drowned god, and it is still singing.

**Amended at revision 52**, because "luck" was doing too much work and meant nothing:

The tide in this harbour does not obey the tables.

**Further amended at revision 59. This paragraph is the concealed layer.**

None of the three schools was wrong.`;

const maren = sheet("maren-kest", "character", [["Essence", MAREN_ESSENCE], ["Relationships", "Trusts Bray with her life, not her secrets."], ["Notes", "> Room note: only notes here."]], { role: "Tide-caller", links: ["bray-half-hitch", "the-vigil", "the-ebb-council"] });
const bray = sheet("bray-half-hitch", "character", [["Essence", "Rigger."]], { links: ["maren-kest"] });
const ines = sheet("ines-half-hitch", "character", [["Essence", "Council clerk, retired."]], { retired: true });
const vigil = sheet("the-vigil", "location", [["Look", "A watchtower of black stone."], ["Sound", "Bells under the water."]], { region: "Harbour mouth", links: ["maren-kest"] });
const council = sheet("the-ebb-council", "faction", [["Essence", "The harbour's shadow government."]]);
const world = {
  characters: [maren, bray, ines],
  locations: [vigil],
  factions: [council],
  canon: [canon("CANON-001", "settled", UNDERSONG, { links: ["maren-kest", "CANON-044"] }), canon("CANON-031", "settled", "The god went under.", { type: "timeline" }), canon("CANON-044", "open", "Who taught the Chorister?", { type: "thread" })],
};
const material = (overrides: Partial<GuideMaterial> = {}): GuideMaterial => ({
  ...world,
  productions: [{ id: "the-ledger-of-nights", title: "The Ledger of Nights", chapters: [{ id: "neap", number: 1, title: "Neap", book: "OEBPS/chapter-1.xhtml" }, { id: "independent-record", number: 6, title: "Independent record" }] }],
  picture: (kind, of) => (kind === "characters" && of.id === "maren-kest" ? "g-maren" : undefined),
  voice: () => undefined,
  ...overrides,
});
const SIX = { production: "the-ledger-of-nights", chapter: "independent-record" };

describe("a world's Guide (SPEC-059)", () => {
  it("leaves Room notes out of a section, and keeps every other quote (R-5)", () => {
    assert.equal(guidePublicText(MAREN_ESSENCE), "Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go.\n\nShe does not sing; she listens.");
    assert.deepEqual(guideSections(maren).map((section) => section.heading), ["Essence", "Relationships"]);
  });

  it("gives a reader words, not Markdown: wrapped lines joined, emphasis and links gone", () => {
    const written = "The old word for what she is: **Tide-Called** (CANON-058). What reaches her\nis *not* sentences but [impressions](https://example.org) — a bell_rope, a tide_table.\n\n- a bell\n- a pipe";
    assert.equal(guidePublicText(written), "The old word for what she is: Tide-Called (CANON-058). What reaches her is not sentences but impressions — a bell_rope, a tide_table.\n\n- a bell\n- a pipe");
  });

  it("reads a canon entry's statement without its amendments (R-5)", () => {
    assert.equal(guideLoreText(UNDERSONG), "Beneath the harbour lies a drowned god, and it is still singing.");
  });

  it("starts with nothing public, counting only what can be (R-1, R-2, R-3)", () => {
    assert.deepEqual(guideCounts(EMPTY_GUIDE_RECORD, world), { teasers: { chosen: 0, of: 6 }, characters: { public: 0, of: 2 }, places: { public: 0, of: 2 }, lore: { public: 0, of: 2 }, after: 0, themes: 0 });
    assert.equal(guideDocument(EMPTY_GUIDE_RECORD, material()), null);
  });

  const record: GuideRecord = {
    schemaVersion: 1,
    characters: {
      "maren-kest": { public: true, sections: { Essence: { public: true }, Relationships: { public: true, after: SIX } } },
      "bray-half-hitch": { public: true, after: SIX, sections: { Essence: { public: true } } },
      "ines-half-hitch": { public: true, sections: { Essence: { public: true } } },
    },
    locations: { "the-vigil": { public: true, sections: { Look: { public: true } } } },
    factions: { "the-ebb-council": { public: false } },
    // An open thread made public before it was reopened never ships (R-3).
    lore: { "CANON-001": { public: true }, "CANON-044": { public: true } },
  };

  it("carries only what is public, read now, as a reader may see it (R-11, R-12)", () => {
    const guide = guideDocument(record, material())!;
    assert.deepEqual(guide.characters.map((entry) => entry.id), ["maren-kest", "bray-half-hitch"]);
    const first = guide.characters[0]!;
    assert.equal(first.portrait, "g-maren");
    assert.deepEqual(first.sections, [
      { heading: "Essence", text: "Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go.\n\nShe does not sing; she listens." },
      { heading: "Relationships", text: "Trusts Bray with her life, not her secrets.", after: SIX },
    ]);
    // Links keep only what ships: the council is not public.
    assert.deepEqual(first.links, ["bray-half-hitch", "the-vigil"]);
    assert.deepEqual(guide.places, [{ id: "the-vigil", name: "The Vigil", role: "Harbour mouth", sections: [{ heading: "Look", text: "A watchtower of black stone." }], links: ["maren-kest"] }]);
    assert.deepEqual(guide.lore, [{ id: "canon-001", kind: "lore", title: "CANON-001", text: "Beneath the harbour lies a drowned god, and it is still singing.", links: ["maren-kest"] }]);
    // Only the production something waits for, with all its chapters.
    assert.deepEqual(guide.productions.map((production) => [production.id, production.chapters.map((chapter) => chapter.number)]), [["the-ledger-of-nights", [1, 6]]]);
    assert.deepEqual(guideCounts(record, world), { teasers: { chosen: 0, of: 6 }, characters: { public: 2, of: 2 }, places: { public: 1, of: 2 }, lore: { public: 1, of: 2 }, after: 1, themes: 0 });
  });

  it("writes what the shared reader accepts (R-14)", () => {
    const guide = guideDocument(record, material())!;
    const digest = "0".repeat(64);
    const assets: Record<string, WorldAsset> = { "g-maren": { path: "guide/maren-kest.jpg", mediaType: "image/jpeg", byteLength: 1, sha256: digest } };
    const read = readGuide(JSON.stringify(guide), assets);
    assert.ok(read.ok, read.ok ? "" : read.reason);
  });

  it("keeps out what waits for a chapter the world no longer has", () => {
    const gone = { production: "the-ledger-of-nights", chapter: "cut-chapter" };
    const guide = guideDocument({ ...record, characters: { ...record.characters, "maren-kest": { public: true, sections: { Essence: { public: true }, Relationships: { public: true, after: gone } } }, "bray-half-hitch": { public: true, after: gone } } }, material())!;
    assert.deepEqual(guide.characters.map((entry) => [entry.id, entry.sections.map((section) => section.heading)]), [["maren-kest", ["Essence"]]]);
  });

  it("gives a place a slug a character has a number of its own, so a link stays one entry", () => {
    const twin = sheet("maren-kest", "location", [["Look", "A rock named for her."]]);
    const guide = guideDocument({ ...record, locations: { ...record.locations, "maren-kest": { public: true, sections: { Look: { public: true } } } } }, material({ locations: [vigil, twin] }))!;
    assert.deepEqual(guide.places.map((entry) => entry.id), ["the-vigil", "maren-kest-2"]);
    assert.deepEqual(guide.places[0]!.links, ["maren-kest"]);
  });
});

// SPEC-059 R-35 – R-37 (design turn 238f, 238g): a character's or place's theme, a song teaser, and
// the guide version that carries them.
describe("music in a world's Guide (SPEC-059 R-35 – R-37)", () => {
  const verse = { production: "songs-of-the-drowned-quarter", track: "the-drowned-verse" };
  const tracks: Record<string, { title: string; duration: number }> = { "the-drowned-verse": { title: "The Drowned Verse", duration: 252_000 } };
  const music = (overrides: Partial<GuideMaterial> = {}) =>
    material({
      theme: (theme) => (theme.production === verse.production ? tracks[theme.track] : undefined),
      song: (teaser) => (tracks[teaser.track] !== undefined ? { title: tracks[teaser.track]!.title, picture: "t-cover", audio: "t-song", duration: teaser.duration } : undefined),
      ...overrides,
    });
  const assets: Record<string, WorldAsset> = {
    "g-maren": { path: "guide/maren-kest.jpg", mediaType: "image/jpeg", byteLength: 1, sha256: "0".repeat(64) },
    "t-cover": { path: "guide/teasers/t001.jpg", mediaType: "image/jpeg", byteLength: 1, sha256: "1".repeat(64) },
    "t-song": { path: "guide/teasers/t001.m4a", mediaType: "audio/mp4", byteLength: 1, sha256: "2".repeat(64) },
  };

  it("carries a theme on its entry as a version 3 guide, and leaves out one whose track is gone (R-35, R-37)", () => {
    const record: GuideRecord = {
      ...EMPTY_GUIDE_RECORD,
      characters: {
        "maren-kest": { public: true, theme: verse, sections: { Essence: { public: true } } },
        "bray-half-hitch": { public: true, theme: { production: verse.production, track: "cut-track" } },
      },
      locations: { "the-vigil": { public: true, theme: verse } },
    };
    const guide = guideDocument(record, music())!;
    assert.equal(guide.version, 3);
    assert.deepEqual(guideTheme(guide.characters[0]!), { production: "songs-of-the-drowned-quarter", track: "the-drowned-verse", title: "The Drowned Verse", duration: 252_000 });
    assert.equal(guideTheme(guide.characters[1]!), undefined);
    assert.equal(guideTheme(guide.places[0]!)?.track, "the-drowned-verse");
    assert.ok(readGuide(JSON.stringify(guide), assets).ok);
    // The head counts the themes the author chose on entries that are public.
    assert.equal(guideCounts(record, world).themes, 3);
  });

  it("follows its entry's gate: a theme on an entry that is not public neither ships nor counts", () => {
    const record: GuideRecord = { ...EMPTY_GUIDE_RECORD, characters: { "maren-kest": { public: true }, "bray-half-hitch": { public: false, theme: verse } } };
    assert.equal(guideDocument(record, music())!.version, 1);
    assert.equal(guideCounts(record, world).themes, 0);
  });

  it("makes a song teaser from its excerpt as a version 3 guide, and leaves out one whose track is gone (R-36, R-37)", () => {
    const record: GuideRecord = {
      ...EMPTY_GUIDE_RECORD,
      characters: { "maren-kest": { public: true } },
      teasers: [{ kind: "song", ...verse, start: 108_000, duration: 24_000 }, { kind: "song", production: verse.production, track: "cut-track", start: 0, duration: 30_000 }],
    };
    const guide = guideDocument(record, music())!;
    assert.equal(guide.version, 3);
    assert.deepEqual(guide.version === 3 ? guide.teasers : [], [{ kind: "song", title: "The Drowned Verse", picture: "t-cover", audio: "t-song", duration: 24_000, production: "songs-of-the-drowned-quarter", track: "the-drowned-verse" }]);
    assert.ok(readGuide(JSON.stringify(guide), assets).ok);
    // With its only song gone, a guide is the version every Player reads.
    assert.equal(guideDocument({ ...record, teasers: record.teasers!.slice(1) }, music())!.version, 1);
  });

  it("keeps a song by its track and an excerpt of at most 30 seconds", () => {
    const song = { kind: "song" as const, ...verse, start: 0, duration: 30_000 };
    assert.ok(sameGuideTeaser(song, { ...song, start: 60_000, duration: 12_000 }));
    assert.ok(!sameGuideTeaser(song, { ...song, track: "saltmouth-bells" }));
    assert.ok(!sameGuideTeaser(song, { kind: "picture", production: verse.production, chapter: "neap", block: "b1" }));
    assert.equal(SetGuideTeasersSchema.safeParse({ teasers: [song, { ...song, start: 60_000 }] }).success, false);
    assert.equal(GuideRecordSchema.safeParse({ ...EMPTY_GUIDE_RECORD, teasers: [{ ...song, duration: 30_001 }] }).success, false);
    assert.equal(GuideRecordSchema.safeParse({ ...EMPTY_GUIDE_RECORD, characters: { "maren-kest": { public: true, theme: { ...verse, title: "copied" } } } }).success, false);
  });
});
