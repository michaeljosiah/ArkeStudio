import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exploreStory, storyIdentity, storyReplay, type Routing } from "@arke-studio/contracts";

/**
 * Small interactive productions for Export → Arke Player (SPEC-058 R-89): written into a world on
 * disk as the Studio writes them, with MP4s whose boxes say what a real clip's would, and every
 * transition walked in preview so the web package's findings stand aside.
 */

const u16 = (value: number) => { const out = Buffer.alloc(2); out.writeUInt16BE(value); return out; };
const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0); return out; };
const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]); };
const full = () => Buffer.from([0, 0, 0, 0]);

/** An MP4 whose boxes name a codec, a size and a length — no frames, which nothing here decodes. */
export function mp4(options: { durationMs: number; video?: { codec: string; width: number; height: number }; audio?: { objectType: number }; brand?: string; moovLast?: boolean }): Buffer {
  const ftyp = box("ftyp", Buffer.from(options.brand ?? "isom", "latin1"), u32(512), Buffer.from("isomavc1", "latin1"));
  const mvhd = box("mvhd", full(), u32(0), u32(0), u32(1000), u32(options.durationMs), Buffer.alloc(80));
  const trak = (handler: string, entry: Buffer) => box("trak", box("mdia", box("hdlr", full(), u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(12)), box("minf", box("stbl", box("stsd", full(), u32(1), entry)))));
  const traks: Buffer[] = [];
  if (options.video !== undefined) traks.push(trak("vide", box(options.video.codec, Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(options.video.width), u16(options.video.height), Buffer.alloc(50))));
  if (options.audio !== undefined) {
    // ES_Descriptor (tag 3) holding a DecoderConfigDescriptor (tag 4) whose first byte is the object type.
    const esds = box("esds", full(), Buffer.from([0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, options.audio.objectType, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02]));
    traks.push(trak("soun", box("mp4a", Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(44_100 * 65_536), esds)));
  }
  const moov = box("moov", mvhd, ...traks);
  const mdat = box("mdat", Buffer.from("frames", "latin1"));
  return Buffer.concat(options.moovLast ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

/** A clip as a phone takes it: H.264 1920×1080 with AAC, five seconds. */
export const PHONE_CLIP = () => mp4({ durationMs: 5000, video: { codec: "avc1", width: 1920, height: 1080 }, audio: { objectType: 0x40 } });

export const CLOCK = () => "2026-10-28T09:12:00.000Z";

export interface FixtureScene {
  id: string;
  title: string;
  /** The clip a movie's scene accepted, or none; a novel's scenes take stills. */
  clip?: Buffer | null;
  /** A novel's lines: narration, or a speaker's. */
  lines?: Array<{ id: string; text: string; speaker?: string }>;
}

/** Writes an interactive production into [worldDir]: its scenes, their accepted takes, its routing. */
export async function writeStoryProduction(worldDir: string, options: { id: string; title: string; kind: "movie" | "novel"; aspect?: string; scenes: FixtureScene[]; routing: Routing }): Promise<void> {
  const dir = join(worldDir, "productions", options.id);
  await mkdir(join(dir, "scenes"), { recursive: true });
  const meta = {
    id: options.id,
    format: "video",
    ...(options.kind === "movie" ? { medium: "interactive-video", kind: "interactive" } : { kind: "visual-novel" }),
    title: options.title,
    status: "in-progress",
    ...(options.aspect !== undefined ? { aspect: options.aspect } : {}),
    created: "2026-10-01T09:00:00Z",
    updated: "2026-10-01T09:00:00Z",
  };
  await writeFile(join(dir, "production.json"), JSON.stringify(meta, null, 2));
  const selections: Record<string, { acceptedTakeId: string; trimInSec: number }> = {};
  for (const [index, scene] of options.scenes.entries()) {
    const shotId = `sh_${scene.id.slice(3)}`;
    const shots = [{ id: shotId, number: 1, title: scene.title, description: scene.title, durationSec: 5, ...(scene.lines !== undefined ? { covers: scene.lines.map((line) => ({ blockId: line.id, textDigest: "sha256:12345678" })) } : {}) }];
    const record = {
      id: scene.id,
      number: index + 1,
      slug: scene.id.slice(3),
      title: scene.title,
      status: "accepted",
      version: 1,
      ...(scene.lines !== undefined ? { script: { blocks: scene.lines.map((line) => (line.speaker !== undefined ? { id: line.id, kind: "dialogue", speaker: line.speaker, text: line.text } : { id: line.id, kind: "action", text: line.text })) } } : {}),
      shots,
    };
    await writeFile(join(dir, "scenes", `${index + 1}-${record.slug}.json`), JSON.stringify(record, null, 2));
    if (scene.clip === null) continue;
    const takeId = `tk_01J8E000000000000000000${String(index + 1).padStart(3, "0")}`;
    const media = options.kind === "movie" ? "clip.mp4" : "frame.png";
    const take = {
      id: takeId,
      coversShots: [shotId],
      kind: options.kind === "movie" ? "clip" : "frame",
      provider: "fal",
      model: options.kind === "movie" ? "seedance-2.0" : "flux-pro-1.1",
      provenance: { canonRevision: 1, sheets: {} },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
      dispatchedAt: CLOCK(),
      media,
    };
    await mkdir(join(dir, "takes", takeId), { recursive: true });
    await writeFile(join(dir, "takes", takeId, "take.json"), JSON.stringify(take, null, 2));
    await writeFile(join(dir, "takes", takeId, media), options.kind === "movie" ? (scene.clip ?? PHONE_CLIP()) : Buffer.from(`picture of ${scene.id}`));
    selections[shotId] = { acceptedTakeId: takeId, trimInSec: 0 };
  }
  await writeFile(join(dir, "selections.json"), JSON.stringify(selections, null, 2));
  await writeFile(join(dir, "routing.json"), JSON.stringify(options.routing, null, 2));
}

/** Every transition of a story walked in preview (SPEC-063 R-18), so no untraversed edge blocks. */
export async function walkEveryChoice(worldDir: string, productionId: string, routing: Routing): Promise<void> {
  const lines: string[] = [];
  if (routing.schemaVersion === 2) {
    const graph = exploreStory(routing);
    for (const edge of graph.transitions) {
      const point = graph.points[edge.from]!;
      const after = storyReplay(routing, [...point.prefix, edge.choiceId]);
      const route = [routing.start, ...point.prefix.map((id) => routing.choices.find((choice) => choice.id === id)!.to)];
      lines.push(JSON.stringify({ ts: CLOCK(), routingVersion: routing.version, choiceId: edge.choiceId, from: point.sceneId, to: after.sceneId, route, story: { identity: storyIdentity(routing), prefix: point.prefix, before: storyIdentity(point.state), after: storyIdentity(after.state), provenance: "human" } }));
    }
  } else {
    for (const choice of routing.choices) lines.push(JSON.stringify({ ts: CLOCK(), routingVersion: routing.version, choiceId: choice.id, from: choice.from, to: choice.to, route: [choice.from] }));
  }
  await writeFile(join(worldDir, "productions", productionId, "routing-evidence.jsonl"), lines.join("\n") + "\n");
}

/**
 * Low Water, small: the key held or left at the harbour, the tenth key closed with a reason when
 * it was left, a back way closed without one (hidden), and two endings. Four routes.
 */
export const LOW_WATER: Routing = {
  schemaVersion: 2,
  version: 3,
  start: "sc_harbour",
  facts: [{ id: "key", label: "Key", type: "enum", values: ["held", "left"], default: "held" }],
  choices: [
    { id: "ch_keep", from: "sc_harbour", to: "sc_bell", label: "Keep the key" },
    { id: "ch_leave", from: "sc_harbour", to: "sc_bell", label: "Leave the key", effects: [{ fact: "key", value: "left" }] },
    { id: "ch_vault", from: "sc_bell", to: "sc_vault", label: "Use the tenth key", when: { op: "eq", fact: "key", value: "held" }, unavailable: { reason: "Left at the weigh house" } },
    { id: "ch_back", from: "sc_bell", to: "sc_pier", label: "The back way", when: { op: "eq", fact: "key", value: "left" } },
    { id: "ch_pier", from: "sc_bell", to: "sc_pier", label: "Walk to the pier" },
  ],
  endings: [
    { sceneId: "sc_vault", title: "The vault" },
    { sceneId: "sc_pier", title: "The pier at dusk" },
  ],
  excluded: [],
  groups: [],
} as Routing;

export const LOW_WATER_SCENES: FixtureScene[] = [
  { id: "sc_harbour", title: "The harbour at dusk" },
  { id: "sc_bell", title: "The bell" },
  { id: "sc_vault", title: "The vault" },
  { id: "sc_pier", title: "Under the pier" },
];
