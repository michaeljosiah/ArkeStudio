// A provider's mark, shared by Settings and the screens that name a provider (issue 2816).
import { cx } from "./ui.js";

/**
 * The marks under public/marks, by provider or engine (SPEC-042 R-20). Bundled with the client
 * and never fetched from the provider at runtime. Voxa is our own engine, so it carries Arke's.
 */
const MARK_SRC: Partial<Record<string, string>> = {
  fal: "./marks/fal.ico",
  anthropic: "./marks/anthropic.ico",
  elevenlabs: "./marks/elevenlabs.ico",
  higgsfield: "./marks/higgsfield.ico",
  comfyui: "./marks/comfyui.ico",
  ollama: "./marks/ollama.png",
  voxa: "./marks/arke.ico",
};

/**
 * A provider's or engine's mark, on one light plate whatever the theme: half of these are a
 * black glyph on nothing and would disappear against a dark pane. A source with no bundled mark
 * keeps a monogram in the same slot, so nothing in the layout depends on having one.
 */
export function ProviderMark({ id, label, size = "sm", letter }: { id: string; label: string; size?: "xs" | "sm" | "lg"; /** The monogram, where the name's first letter is not the one drawn. */ letter?: string }) {
  const src = MARK_SRC[id];
  return (
    <span
      className={cx("fy-mark", size === "lg" && "fy-mark--lg", size === "xs" && "fy-mark--xs", src === undefined && "fy-mark--letter")}
      aria-hidden="true"
    >
      {src !== undefined ? <img src={src} alt="" /> : (letter ?? label.slice(0, 1).toUpperCase())}
    </span>
  );
}
