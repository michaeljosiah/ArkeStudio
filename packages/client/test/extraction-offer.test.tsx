import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { ExtractionOffer } from "../src/components/extraction-offer.js";

const noop = () => {};
const props = { file: "series-bible.pdf", onRead: noop, onStop: noop, onReview: noop, onDismiss: noop };

describe("the extraction offer", () => {
  it("offers before it reads — the button is the consent", () => {
    const html = renderToString(<ExtractionOffer {...props} />);
    assert.ok(html.includes("series-bible.pdf"));
    assert.ok(html.includes("Read it for facts?"));
    assert.ok(html.includes("Read it") && html.includes("Not now"));
    assert.ok(!html.includes("Reading series-bible.pdf"), "nothing has been read yet");
  });

  it("can be stopped while it is reading", () => {
    const html = renderToString(<ExtractionOffer {...props} state="reading" />);
    assert.ok(html.includes("Reading series-bible.pdf"));
    assert.ok(html.includes("Stop"));
    assert.ok(html.includes("fy-off__dot--live"));
  });

  it("counts what it found, and what it threw away for not quoting the document", () => {
    const html = renderToString(<ExtractionOffer {...props} state="found" found={14} dropped={3} />);
    assert.ok(html.includes("14 fact"));
    assert.ok(html.includes("Review them"));
    assert.ok(html.includes("3 more"), "the dropped ones are counted, never hidden");
  });

  it("says nothing-found plainly, because a silent nothing reads as a failure", () => {
    const html = renderToString(<ExtractionOffer {...props} state="nothing" />);
    assert.ok(html.includes("Nothing in series-bible.pdf that the canon does not already say"));
    assert.ok(!html.includes("Review them"), "there is nothing to review");
  });

  it("separates a stop, a file with no text, and a genuine failure", () => {
    const stopped = renderToString(<ExtractionOffer {...props} state="stopped" />);
    assert.ok(stopped.includes("stays filed, unread"), "stopping is not losing the file");

    const noText = renderToString(<ExtractionOffer {...props} state="no-text" reason="scanned pages, no text layer" />);
    assert.ok(noText.includes("scanned pages, no text layer"));

    const failed = renderToString(<ExtractionOffer {...props} state="failed" reason="the session died" />);
    assert.ok(failed.includes("Could not read") && failed.includes("the session died"));
  });

  it("names the harness when it is the harness that is missing, not the file", () => {
    const html = renderToString(
      <ExtractionOffer {...props} state="unavailable" reason="reading needs the writing service running" />,
    );
    assert.ok(html.includes("reading needs the writing service running"));
  });
});
