# SpecOne Design System

> The UI system for **SpecOne** — the Specification Orchestrator. Built on the **shadcn/ui (Radix) neutral monochrome** theme.

---

## 1 · Company & product context

**SpecOne** is the **Specification Orchestrator**: a web + desktop application where **Product Managers generate detailed specifications for AI engineers**. A PM co-authors a specification with AI, grounded in the codebase; that single specification becomes the **single source of truth**, and everything downstream — tasks, code, tickets, tests, tracking — is generated from it and kept in step.

It sits on top of an existing coding-agent harness (OpenCode first) and is the **cockpit a PM works in** to do three things:

1. **Author** a specification (chat with agent roles + a live preview).
2. **Review** it (multi-model review panels, then human approval).
3. **Deliver** it (a board projected from real harness events, not hand-dragged cards).

The primary user is the **Product Manager / Product Engineer** who owns a feature end to end; a Reviewer approves before merge. Governance & audit are first-class.

### Core principles (they shape the UI)
- **Direction of truth.** The specification is authoritative; tickets/tests/tracking are *projections* of it.
- **Propose · decide · execute.** The agent proposes, the human decides, the harness executes — every governed action passes a human gate.
- **The harness owns execution; the client owns the picture.** The UI realises and coordinates; it never holds credentials or runs agents.

### Why this theme
The product is built on **Radix primitives via the shadcn/ui pattern**, with a **deliberately neutral, unbranded monochrome** default so any team can re-skin it. This design system *is* that default: white surfaces, near-black primary, neutral grays, one red for destructive actions. It ships “looking like infrastructure, not one company’s app.”

### Products / surfaces
- **The Orchestrator app** (desktop via Electron/Tauri + browser): project picker, authoring cockpit, review panel, generation workspace, delivery board, session detail, diff review, permission overlays, audit trace, settings. → `ui_kits/orchestrator/`.

### Sources given
- `uploads/PRD-Specification-Orchestrator_1.html` — the full PRD. The shadcn/Radix monochrome direction comes from PRD §8.6 (“the default theme is a neutral monochrome, deliberately unbranded… Radix primitives through the shadcn/ui pattern”). No codebase, Figma, or repo was provided.

---

## 2 · Content fundamentals — how SpecOne writes

Precise, declarative, engineering-grade. It explains a system of record honestly and avoids hype.

- **Tone:** calm, authoritative, a little dry. Claims are stated plainly then qualified. No exclamation, no marketing adjectives.
- **Person:** third-person/impersonal about the system (“The orchestrator dispatches and observes; it does not execute”). The user is named by role — “the Product Manager”, “the Reviewer” — not “you”.
- **Casing:** **sentence case everywhere** — headings, buttons, labels. Small labels may be UPPERCASE with light tracking (e.g. `REQUIREMENTS`), set in **sans** (not mono).
- **Spelling:** **British English** (`realisation`, `authorisation`, `behaviour`).
- **Sentence shape:** short declaratives, em-dashes, the rhetorical triad (“author the spec, govern it, dispatch the agents”). Parallel structure is a signature.
- **Technical literalness:** code-y nouns in mono — `docs/specifications`, `AGENTS.md`, `opencode serve`. IDs like `FR-9`, `SPEC-014`.
- **No emoji.** Status is shown with color dots and pills, not faces.

**Examples (verbatim from source):** *“One specification, authored once, drives the whole delivery.”* · *“The agent proposes, the human decides, the harness executes.”* · *“A card moves because the work moved, not because a person dragged it.”*

Microcopy: button = verb-first sentence case (`Generate specification`, `Approve & persist`); status = lowercase mono (`status: draft`); metadata = `key: value` in mono.

---

## 3 · Visual foundations — shadcn neutral

The look is **quiet monochrome infrastructure**: white surfaces, neutral hairline borders, near-black primary, and a single red reserved for destructive/blocked states.

### Color (shadcn token contract)
- **Surfaces:** `--background` / `--card` white; `--muted` / `--secondary` `#F5F5F5` for recessed strips, hover, and segmented controls.
- **Text:** `--foreground` `#0A0A0A`; `--muted-foreground` `#737373` for secondary/labels. A full **neutral ramp** (`--neutral-50…950`) is available for fine control.
- **Primary:** `--primary` `#171717` (near-black) with `--primary-foreground` near-white — the default button, active states, filled chat bubbles.
- **Destructive:** `--destructive` red — the *only* hue in the chrome, used for irreversible/failed/blocked actions and the “needs a human” signal.
- **Status palette (restrained):** `--success` green, `--warning` amber, `--destructive` red — used **only** in small state dots and diff lines, never as chrome or fills.
- **Borders:** `--border` `#E5E5E5` hairlines do most of the work. `--ring` neutral for focus.
- **Dark mode:** the same tokens inverted under a `.dark` class (near-black surfaces, off-white primary).
- **Imagery:** essentially none — the product is UI and diagrams. Where diagrams appear they’re flat neutral boxes with hairline strokes and dashed “boundary” rectangles.

### Type — Geist
- **Geist** (sans) for *everything* — headings, body, UI, small labels. Headings semibold with tight tracking (`-0.02em`); body 14px (`text-sm` is the workhorse); leads 18px.
- **Geist Mono** for code, IDs, paths and metadata only — never for labels (that mono-label habit is gone in this theme).
- No display/serif split. Quiet and legible.

### Radius, borders, shadow
- **`--radius: 0.625rem` (10px)** drives a derived scale — buttons/inputs `--radius-md` (8px), cards `--radius-xl` (14px), pills 999px. Nothing is sharp-square; nothing is heavily rounded.
- **Hairline borders** `1px solid var(--border)` are the primary separator.
- **shadcn shadow scale** — `--shadow-xs` on cards/buttons, up to `--shadow-lg` for dialogs/popovers. Subtle, neutral, never colored. **No gradients.**

### Motion & states
- **Minimal, functional** — 150–200ms, `cubic-bezier(0.4,0,0.2,1)`. No bounces, no infinite loops; reduced-motion respected. The product is event-driven — things appear/update as events arrive.
- **Hover:** `--accent` wash on ghost/outline; primary darkens ~10%; secondary darkens ~20%.
- **Press:** color steps darker; no large scale change.
- **Focus:** a visible neutral ring (`--shadow-focus`, 3px `--ring` at 50%). Accessibility is a quality floor (NFR-6).
- **Selection:** neutral-200 background.

### Layout
- 4px spacing grid. Dense, gridded tool surfaces (board columns, cockpit split); generous measure for prose. Default UI text 13–14px; never below 12px.

---

## 4 · Iconography

SpecOne is built on **shadcn/ui + Radix**, whose icon convention is **[Lucide](https://lucide.dev)** — clean ~1.75px-stroke, rounded line icons that match the hairline-and-neutral aesthetic. The UI kit and cards use Lucide.

> ⚠️ **Note:** no icon set was provided in the source material, but Lucide is the *correct, intended* set for the shadcn/Radix stack the product is built on (not a loose guess). If SpecOne adopts a different set, share it and I’ll swap it in.

Rules of use:
- **Line, not fill.** Stroke ~1.75px, `currentColor`, sized 16/18px to sit on the text baseline.
- Icons are **functional, never decorative** — no icon-bullet lists, no emoji-as-icon.
- The smallest “iconography” is the **status dot** (8px filled circle: foreground / green / amber / red). Prefer it for state.
- No logo image was provided; the **wordmark is typographic** — `//SpecOne` in Geist with a mono `//` mark. See `guidelines/brand-wordmark`.

---

## 5 · Fonts

Both families are **Google Fonts**, linked from the CDN in `tokens/fonts.css` (no binaries vendored), openly licensed (OFL):
- **Geist** (sans) — Vercel’s typeface, the shadcn default.
- **Geist Mono** (mono).

> ⚠️ **Flag:** fonts load from the Google Fonts CDN rather than self-hosted. If you need offline/self-hosted `.woff2` binaries committed to the repo, let me know.

---

## 6 · Index / manifest

**Root**
- `styles.css` — global entry point (links every token + font file). Consumers link this.
- `readme.md` — this guide. · `SKILL.md` — Agent-Skill manifest for Claude Code.

**`tokens/`** — `fonts.css` · `colors.css` (shadcn neutral, light + `.dark`) · `typography.css` (Geist) · `spacing.css` · `effects.css` (radius + shadcn shadows)

**`guidelines/`** — foundation specimen cards (Design System tab → Colors / Type / Spacing / Brand)

**`components/core/`** — reusable React primitives (group: Components)
- Button, IconButton, Input, Textarea, Badge, StatusDot, Card, Callout (Alert), Switch, Tabs, Avatar, plus domain pieces AgentMessage, SpecCard, KanbanCard

**`ui_kits/orchestrator/`** — interactive recreation of the Orchestrator app (picker → cockpit → review → board → session)

**`templates/spec-brief/`** — a copyable starting page (Design Component) styled with the system.

---

*Generated for SpecOne on the shadcn/ui neutral theme. The tokens are the contract — iterate freely.*
