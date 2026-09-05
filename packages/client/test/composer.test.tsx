import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { Composer, isLongPaste } from "../src/components/composer.js";

const noop = () => {};

describe("the composer", () => {
  it("shows the placeholder only while it is empty", () => {
    const empty = renderToString(
      <Composer value="" onChange={noop} onSubmit={noop} placeholder="Keep going, or ask it to surprise you…" />,
    );
    assert.ok(empty.includes("Keep going, or ask it to surprise you…"));
    assert.ok(empty.includes("fy-cx__placeholder"));

    const typed = renderToString(
      <Composer value="a drowned city" onChange={noop} onSubmit={noop} placeholder="Keep going…" />,
    );
    assert.ok(!typed.includes("fy-cx__placeholder"), "the placeholder gets out of the way");
  });

  it("will not send an empty message, or one that is only spaces", () => {
    for (const value of ["", "   ", "\n\n"]) {
      const html = renderToString(<Composer value={value} onChange={noop} onSubmit={noop} placeholder="…" />);
      assert.match(html, /class="fy-cx__send"[^>]*disabled/, `"${value.replace(/\n/g, "\\n")}" cannot be sent`);
    }
    const ready = renderToString(<Composer value="something" onChange={noop} onSubmit={noop} placeholder="…" />);
    assert.ok(!/class="fy-cx__send"[^>]*disabled/.test(ready));
  });

  it("states the reason when it is unavailable, rather than being a dead box", () => {
    const html = renderToString(
      <Composer
        value=""
        onChange={noop}
        onSubmit={noop}
        placeholder="…"
        disabledReason="Chat needs OpenCode running — the form below still settles it."
      />,
    );
    assert.ok(html.includes("fy-cx--off"));
    assert.ok(html.includes("Chat needs OpenCode running"));
    assert.match(html, /contenteditable="false"/i, "and it cannot be typed into");
  });

  it("names who is answering, and what it is doing while it is busy", () => {
    const html = renderToString(
      <Composer
        value=""
        onChange={noop}
        onSubmit={noop}
        placeholder="…"
        agentLabel="world author"
        busy
        busyLabel="shaping the draft…"
      />,
    );
    assert.ok(html.includes("world author"));
    assert.ok(html.includes("shaping the draft…"));
    assert.match(html, /contenteditable="false"/i, "a turn in flight is read-only");
  });

  it("treats a pasted document as an attachment, and an ordinary paste as typing", () => {
    assert.equal(isLongPaste("a drowned city that still sings"), false);
    assert.equal(isLongPaste("line\n".repeat(60)), false, "sixty lines is still a message");
    assert.equal(isLongPaste("x".repeat(8_001)), true);
    assert.equal(isLongPaste("line\n".repeat(121)), true, "a hundred and twenty-one is a document");
  });

  it("says what would not go in, rather than swallowing it", () => {
    const html = renderToString(
      <Composer
        value=""
        onChange={noop}
        onSubmit={noop}
        placeholder="…"
        refusals={[{ name: "the-tapes.zip", reason: "the studio has no use for a .zip yet" }]}
      />,
    );
    assert.ok(html.includes("fy-cx__chip--bad"), "the chip is there, greyed");
    assert.ok(html.includes("the-tapes.zip"));
    assert.ok(html.includes("the studio has no use for a .zip yet"), "with the reason on it");
  });

  it("offers to file private evidence until it has been promoted", () => {
    const privateChip = renderToString(
      <Composer
        value=""
        onChange={noop}
        onSubmit={noop}
        placeholder="…"
        attachments={[{ id: "a1", file: "map.txt", kind: "document", promoted: false }]}
        onPromoteAttachment={noop}
      />,
    );
    const filedChip = renderToString(
      <Composer
        value=""
        onChange={noop}
        onSubmit={noop}
        placeholder="…"
        attachments={[{ id: "a1", file: "map.txt · filed in world", kind: "document", promoted: true }]}
        onPromoteAttachment={noop}
      />,
    );
    assert.ok(privateChip.includes("File in world"));
    assert.ok(!filedChip.includes("File in world"));
    assert.ok(filedChip.includes("filed in world"));
  });
});
