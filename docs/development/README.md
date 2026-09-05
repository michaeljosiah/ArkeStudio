# Developer orientation

Start with the root [AGENTS.md](../../AGENTS.md) and shared [operational rules](../../CLAUDE.md). Then read only the code-map area and capability spec relevant to the change.

| Question | Read |
|---|---|
| Where does this feature live, and what else changes with it? | [Code map and workflow traces](code-map.md) |
| How do I run and validate it? | [Contributor setup](../../CONTRIBUTING.md#getting-set-up), [testing](testing.md) |
| What generates this file or ships this asset? | [Maintenance map](maintenance.md) |
| What is implemented versus planned? | [Bounded implementation status](status.md), then the relevant spec |
| Why is the product structured this way? | [Architecture guide](../architecture/index.html) and [master specification](../specification.md) |
| Which disk writes does an operation perform? | [Filesystem operations](../filesystem-operations.md) |

## How to interpret the documents

| Collection | Role |
|---|---|
| `docs/specification.md`, `docs/specifications/` | Product intent, requirements and capability-specific decisions. Check implementation/status notes before assuming a requirement is delivered. |
| `docs/decisions/` | Decisions spanning capabilities. Accepted, Proposed and Superseded matter; a decision can accept only a bounded part of a design. |
| `docs/architecture/` | Explanations derived from source for a broad audience, including persistence, acceptance and generation. |
| `docs/development/` | Current implementation entry points, test selection and maintenance instructions. |
| `docs/system/`, `docs/features/`, `design-system/` | Product explanations, feature briefs and design references. A prototype affordance does not establish implementation. |
| `docs/code-analysis/` | Dated reviews and audits. Recommendations and measurements describe their stated baseline; check subsequent code and decisions. |
| `docs/issues/` | Issue context; verify the corresponding implementation before treating it as current behavior. |

Source and tests establish what is implemented; specifications establish intended behavior. A disagreement needs reconciliation, not a silent assumption that one universally overrides the other. Tests referenced here are navigation evidence, not a claim that they passed in your session.

When changing a boundary or entry point, update the relevant code-map row and trace. When changing a command, dependency requirement or generation script, update the testing/maintenance guide. Keep historical audits dated; link their follow-up rather than rewriting their original observations.
