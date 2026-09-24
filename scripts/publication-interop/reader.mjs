import { Manifest, Publication, HttpFetcher, Locator } from "@readium/shared";
import { AudioNavigator, EpubNavigator } from "@readium/navigator";

const check = (condition, message) => { if (!condition) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(30); }
}
async function publication(file) {
  const raw = await (await fetch(file)).json();
  raw.links.push({ rel: "self", href: new URL(file, location.href).href, type: "application/webpub+json" });
  return new Publication({ manifest: Manifest.deserialize(raw), fetcher: new HttpFetcher(undefined, location.href) });
}

async function run() {
  const book = await publication("readium-book.json");
  const guide = await book.guideForLink(book.readingOrder.items[0]);
  check(guide?.guided?.length === 2, "Readium must discover the guided navigation alternate");
  let page;
  const epub = new EpubNavigator(document.querySelector("#book"), book, {
    frameLoaded: wnd => { page = wnd.document; }, positionChanged() {}, timelineItemChanged() {}, tap: () => false,
    click: () => false, zoom() {}, miscPointer() {}, scroll() {}, customEvent() {}, handleLocator: () => false,
    textSelected() {}, contentProtection() {}, contextMenu() {}, peripheral() {},
  }, [Locator.deserialize({ href: "page.xhtml", type: "application/xhtml+xml", locations: { position: 1, progression: 0 } })]);
  await epub.load();
  await until(() => page?.querySelector("img")?.complete, "Readium illustrated page");
  const picture = page.querySelector("img");
  check(picture.naturalWidth > 0 && picture.alt === "A gold light above a blue harbour", "Illustration and alternative text must survive");
  await until(() => page.defaultView.innerHeight >= 600 && picture.getBoundingClientRect().bottom <= page.defaultView.innerHeight, "Illustration fits the actual Readium viewport");
  await until(() => {
    const frame = page.defaultView.frameElement.getBoundingClientRect();
    const host = document.querySelector("#book").getBoundingClientRect();
    return frame.left >= host.left && frame.right <= host.right + 1 && frame.bottom <= host.bottom + 1;
  }, "The complete page fits inside the host");
  for (const node of guide.guided) check(page.getElementById(node.textref.split("#")[1])?.textContent === node.text.plain, "Captured anchor text must survive");

  let media;
  const errors = [];
  const audio = new AudioNavigator(await publication("readium-audio.json"), {
    trackLoaded: element => { media = element; element.muted = true; }, error: error => errors.push(String(error)),
  });
  await until(() => media?.readyState >= 2, "First chapter decoded");
  // This is experimental host composition, not a claimed built-in read-along feature.
  // The exact captured ranges select anchors; no word timing or alignment is invented.
  const highlighted = new Set();
  const highlight = () => {
    const node = audio.currentLocator.href === "chapter-1.mp3" && guide.guided.find(item => {
      const [start, end] = item.audioref.split("#t=")[1].split(",").map(Number);
      return media.currentTime >= start && media.currentTime < end;
    });
    for (const paragraph of page.querySelectorAll("p")) paragraph.style.background = "";
    if (node) {
      const id = node.textref.split("#")[1];
      page.getElementById(id).style.background = "#ffe6a0";
      highlighted.add(id);
    }
  };
  media.addEventListener("timeupdate", highlight);
  audio.play();
  await until(() => highlighted.size === 2, "Both narration anchors visited by actual playback");
  await until(() => audio.currentLocator.href === "chapter-2.mp3", "Automatic chapter transition");
  audio.pause();
  await audio.goLink(audio.publication.readingOrder.items[0], false, ok => check(ok, "Chapter navigation"));
  audio.seek(2.5);
  await until(() => Math.abs(media.currentTime - 2.5) < 0.2 && !media.seeking, "Seek within chapter");
  highlight();
  check(errors.length === 0, errors.join("; "));
  const report = { navigator: "@readium/navigator 2.10.3", shared: "2.5.1", illustratedPage: true, pageViewport: [page.defaultView.innerWidth, page.defaultView.innerHeight],
    imageAlt: picture.alt, anchors: [...highlighted], automaticChapterTransition: true, seekSeconds: media.currentTime,
    title: audio.publication.metadata.title.getTranslation(), chapterTitles: audio.publication.readingOrder.items.map(item => item.title),
    readAlong: "Experimental host maps Readium audio clock to preserved Guided Navigation anchors", errors };
  window.interopResult = report;
  document.querySelector("#result").textContent = JSON.stringify(report, null, 2);
  // Keep the page visible for the smoke screenshot; release the audio engine's timers.
  media.removeEventListener("timeupdate", highlight);
  audio.destroy();
}
run().catch(error => { window.interopError = error.stack ?? String(error); document.querySelector("#result").textContent = window.interopError; });
