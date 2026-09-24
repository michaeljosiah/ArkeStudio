# Developer orientation

Start with the root [AGENTS.md](../../AGENTS.md) and shared [operational rules](../../CLAUDE.md). Then read only the code-map area and capability spec relevant to the change.

| Question | Read |
|---|---|
| Where does this feature live, and what else changes with it? | [Code map and workflow traces](code-map.md) |
| Should the remaining large production screens be split? | [Module boundary decisions](production-module-boundaries.md) |
| How can another Node host use the engine? | [Engine services and host contracts](engine.md) |
| How does a host generate page artwork and narration? | [Story media API](story-media-engine.md) |
| Where are the portable publication contracts and file services? | [Publication contracts and implementation boundaries](publications.md) |
| How do I run Studio without Electron? | [Standalone Node server](standalone-server.md) |
| How do I run and validate it? | [Contributor setup](../../CONTRIBUTING.md#getting-set-up), [testing](testing.md) |
| What generates this file or ships this asset? | [Maintenance map](maintenance.md) |
| How do I add or replace a local generation recipe? | [ComfyUI recipe procedure](comfyui-recipes.md) |
| How do local Llama and Gemma models run? | [Local language models](local-language-models.md) |
| What is implemented versus planned? | [Bounded implementation status](status.md), then the relevant spec |
| Why is the product structured this way? | [Architecture guide](../architecture/index.html); for requirements, the master specification in the private document set (see below) |
| Which disk writes does an operation perform? | [Filesystem operations](../filesystem-operations.md) |

## How to interpret the documents

Some of these are **not published with the code** — they are the design record rather than an
explanation of the built product, and they live in the private document set, a sibling git
repository beside the main checkout. Nothing links it into a checkout: the paths below are where
they used to be and are simply absent now; the documents are read from that repository and cited
by id. See [CLAUDE.md](../../CLAUDE.md#the-specs-are-not-in-this-repository).

| Collection | Role |
|---|---|
| `specification.md`, `specifications/` (private repository) | *Private.* Product intent, requirements and capability-specific decisions. Check implementation/status notes before assuming a requirement is delivered. |
| `decisions/` (private repository) | *Private.* Decisions spanning capabilities. Accepted, Proposed and Superseded matter; a decision can accept only a bounded part of a design. |
| `docs/architecture/` | Explanations derived from source for a broad audience, including persistence, acceptance and generation. Public — it describes what is built. The one exception is `character-audio-foundation.md`, integration and recovery notes for a half-built subsystem, which is private. |
| `docs/development/` | Current implementation entry points, test selection and maintenance instructions. |
| `docs/system/`, `docs/features/`, `design-system/` | Product explanations, feature briefs and design references. A prototype affordance does not establish implementation. |
| `docs/code-analysis/` | Dated reviews and audits. Recommendations and measurements describe their stated baseline; check subsequent code and decisions. |
| `docs/issues/` | Issue context; verify the corresponding implementation before treating it as current behavior. |

Source and tests establish what is implemented; specifications establish intended behavior. A disagreement needs reconciliation, not a silent assumption that one universally overrides the other. Tests referenced here are navigation evidence, not a claim that they passed in your session.

When changing a boundary or entry point, update the relevant code-map row and trace. When changing a command, dependency requirement or generation script, update the testing/maintenance guide. Keep historical audits dated; link their follow-up rather than rewriting their original observations.
