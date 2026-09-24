import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

// SPEC-048 §2.3 conformance spike only: synthetic captured content, no world or provider.
export const captured = {
  id: "urn:uuid:14be2337-8e1d-42de-8049-f3f32d8154ee", title: "The harbour lights", language: "en-GB",
  timescale: 1000,
  blocks: [
    { text: "A gold light shone across the quiet harbour.", start: 0, end: 2000 },
    { text: "Mara followed its reflection home.", start: 2000, end: 4000 },
  ],
};
export const anchor = text => `text-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
const xml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const json = value => JSON.stringify(value, null, 2) + "\n";
const doc = body => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en-GB" lang="en-GB">
<head><title>${captured.title}</title><meta name="viewport" content="width=640,height=640"/><style>body{box-sizing:border-box;margin:0;padding:12px}img{display:block;max-width:100%;height:auto}p{line-height:1.4}</style></head><body>${body}</body></html>`;

export function manifests(durations) {
  const tracks = durations.map((duration, i) => ({ href: `chapter-${i + 1}.mp3`, type: "audio/mpeg", title: `Chapter ${i + 1}`, duration }));
  const metadata = { title: captured.title, identifier: captured.id, language: captured.language,
    author: "Arke test fixture", narrator: "Synthetic tones", duration: durations.reduce((a, b) => a + b, 0) };
  const guided = { guided: captured.blocks.map(block => ({ role: ["paragraph"], textref: `page.xhtml#${anchor(block.text)}`,
    audioref: `chapter-1.mp3#t=${block.start / captured.timescale},${block.end / captured.timescale}`, text: { plain: block.text, language: captured.language } })) };
  const image = { href: "harbour.svg", type: "image/svg+xml", title: "A gold light above a blue harbour", width: 640, height: 360 };
  const book = { "@context": "https://readium.org/webpub-manifest/context.jsonld",
    metadata: { ...metadata, duration: 4, "@type": "http://schema.org/Book", conformsTo: ["https://readium.org/webpub-manifest/profiles/epub"], layout: "fixed", spread: "none" },
    links: [], readingOrder: [{ href: "page.xhtml", type: "application/xhtml+xml", title: "The light", width: 640, height: 640,
      alternate: [{ href: "guided.json", type: "application/guided-navigation+json", duration: 4 }] }],
    resources: [image, tracks[0], { href: "guided.json", type: "application/guided-navigation+json" }],
    toc: captured.blocks.map(block => ({ href: `page.xhtml#${anchor(block.text)}`, title: block.text })) };
  const audio = { "@context": "https://readium.org/webpub-manifest/context.jsonld",
    metadata: { ...metadata, "@type": "http://schema.org/Audiobook", conformsTo: ["https://readium.org/webpub-manifest/profiles/audiobook"] },
    links: [], readingOrder: tracks, resources: [image], toc: tracks.map(({ href, title, type }) => ({ href, title, type })) };
  const w3c = { "@context": ["https://schema.org", "https://www.w3.org/ns/pub-context"],
    conformsTo: "https://www.w3.org/TR/audiobooks/", type: "Audiobook", id: captured.id, name: captured.title,
    inLanguage: captured.language, author: { type: "Person", name: "Arke test fixture" }, readBy: { type: "Person", name: "Synthetic tones" },
    duration: `PT${metadata.duration}S`, readingOrder: tracks.map(track => ({ url: track.href, encodingFormat: track.type, name: track.title, duration: `PT${track.duration}S` })),
    resources: [{ url: "toc.xhtml", encodingFormat: "application/xhtml+xml", rel: "contents" },
      { url: image.href, encodingFormat: image.type, name: image.title }] };
  return { book, audio, w3c, guided };
}

export async function generate(parent, ffmpeg = "ffmpeg", ffprobe = "ffprobe") {
  await mkdir(parent, { recursive: true });
  const out = await mkdtemp(join(parent, "publication-interop-"));
  const files = new Map();
  files.set("harbour.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><title>A gold light above a blue harbour</title><rect width="640" height="360" fill="#102940"/><path d="M0 230H640V360H0Z" fill="#26768a"/><path d="M300 110H330V230H300Z" fill="#ddd7c4"/><circle cx="315" cy="95" r="32" fill="#ffce65"/><path d="M308 240L280 345H350L322 240Z" fill="#e4b855"/></svg>`);
  files.set("page.xhtml", doc(`<h1>The light</h1><img src="harbour.svg" width="640" height="360" alt="A gold light above a blue harbour"/>${captured.blocks.map(block => `<p id="${anchor(block.text)}">${xml(block.text)}</p>`).join("")}`));
  files.set("toc.xhtml", doc(`<nav epub:type="toc" role="doc-toc"><h1>Contents</h1><ol><li><a href="chapter-1.mp3">Chapter 1</a></li><li><a href="chapter-2.mp3">Chapter 2</a></li></ol></nav>`));
  const durations = [];
  for (let i = 1; i <= 2; i++) {
    const path = join(out, `chapter-${i}.mp3`);
    execFileSync(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `sine=frequency=${i === 1 ? 440 : 660}:sample_rate=44100`, "-t", "4", "-c:a", "libmp3lame", "-b:a", "128k", "-map_metadata", "-1", path], { windowsHide: true });
    durations.push(Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { encoding: "utf8", windowsHide: true }).trim()));
    files.set(`chapter-${i}.mp3`, await readFile(path));
  }
  const { book, audio, w3c, guided } = manifests(durations);
  for (const [name, value] of Object.entries({ "readium-book.json": book, "readium-audio.json": audio, "publication.json": w3c, "guided.json": guided, "captured.json": captured })) files.set(name, json(value));
  for (const [name, bytes] of files) await writeFile(join(out, name), bytes);
  const zip = async (name, entries, epub = false) => {
    const archive = new JSZip();
    if (epub) archive.file("mimetype", "application/epub+zip", { compression: "STORE", date: new Date("2026-09-24T00:00:00Z") });
    for (const [key, bytes] of entries) archive.file(key, bytes, { createFolders: false, date: new Date("2026-09-24T00:00:00Z"), compression: key.endsWith(".mp3") ? "STORE" : "DEFLATE" });
    await writeFile(join(out, name), await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  };
  await zip("readium.audiobook", new Map([["manifest.json", json(audio)], ...["chapter-1.mp3", "chapter-2.mp3", "harbour.svg"].map(name => [name, files.get(name)])]));
  await zip("w3c.lpf", new Map(["publication.json", "chapter-1.mp3", "chapter-2.mp3", "harbour.svg", "toc.xhtml"].map(name => [name, files.get(name)])));
  const smil = `<?xml version="1.0"?><smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0"><body><seq epub:textref="page.xhtml">${captured.blocks.map((block, i) => `<par id="par-${i}"><text src="page.xhtml#${anchor(block.text)}"/><audio src="chapter-1.mp3" clipBegin="${block.start / 1000}s" clipEnd="${block.end / 1000}s"/></par>`).join("")}</seq></body></smil>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en-GB"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">${captured.id}</dc:identifier><dc:title>${captured.title}</dc:title><dc:language>en-GB</dc:language><meta property="dcterms:modified">2026-09-24T00:00:00Z</meta><meta property="media:duration">0:00:04.000</meta><meta property="media:duration" refines="#overlay">0:00:04.000</meta><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="page" href="page.xhtml" media-type="application/xhtml+xml" media-overlay="overlay"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="picture" href="harbour.svg" media-type="image/svg+xml"/><item id="audio" href="chapter-1.mp3" media-type="audio/mpeg"/><item id="overlay" href="overlay.smil" media-type="application/smil+xml"/></manifest><spine><itemref idref="page"/></spine></package>`;
  await zip("narrated.epub", new Map([
    ["META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ["content.opf", opf], ["overlay.smil", smil], ["nav.xhtml", doc('<nav epub:type="toc" role="doc-toc"><h1>Contents</h1><ol><li><a href="page.xhtml">The light</a></li></ol></nav>')],
    ...["page.xhtml", "harbour.svg", "chapter-1.mp3"].map(name => [name, files.get(name)]),
  ]), true);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const parent = resolve(fileURLToPath(new URL("../..", import.meta.url)), ".dev");
  console.log(await generate(parent, process.env.ARKE_TEST_FFMPEG, process.env.ARKE_TEST_FFPROBE));
}
