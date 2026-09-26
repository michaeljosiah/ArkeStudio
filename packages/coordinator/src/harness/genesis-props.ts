import { createHash } from "node:crypto";
import type { GenesisProp, Prop } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { createProp } from "../references/props.js";

/** IDs derive from the original draft identity, never a prop's editable display name. */
function stableId(prefix: string, ...parts: string[]): string {
  let value = BigInt("0x" + createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32));
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let index = 0; index < 26; index++) { encoded = alphabet[Number(value & 31n)] + encoded; value >>= 5n; }
  return prefix + "_" + encoded;
}
export const genesisPropId = (genesisId: string, slug: string) => stableId("prop", genesisId, slug);
export const genesisPropStateId = (genesisId: string, slug: string, stateSlug: string) => stableId("pst", genesisId, slug, stateSlug);
export async function installGenesisProp(store: WorldStore, genesisId: string, prop: GenesisProp): Promise<Prop> {
  const saved = await createProp(store, prop.name, { id: genesisPropId(genesisId, prop.slug),
    states: prop.states.map(state => ({ id: genesisPropStateId(genesisId, prop.slug, state.slug), name: state.name })),
    requestId: "founding-prop:" + prop.slug, source: "founding",
  });
  if (!saved) throw new Error("The approved prop name conflicts with another world entity.");
  return saved;
}
