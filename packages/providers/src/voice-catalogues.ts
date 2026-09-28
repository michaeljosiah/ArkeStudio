import type { ProviderId } from "@arke-studio/contracts";
import type { ProviderClient, VoiceCatalogueClient } from "./types.js";

/** Every host lists the same presets through its captured clients, only after a key is set. */
export function cloudVoiceSources(clients: Partial<Record<ProviderId, ProviderClient>>) {
  return (["google", "elevenlabs", "mistral", "breezeblue", "fishaudio"] as const).flatMap(provider => {
    const client = clients[provider] as VoiceCatalogueClient | undefined;
    return typeof client?.listVoicesCatalog === "function"
      ? [{ provider, list: (key: string) => client.listVoicesCatalog(key) }] : [];
  });
}
