import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { Composer } from "../src/components/composer.js";

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
});
