import { externalWebUrl } from "@arke-studio/contracts";

/** The shell is a privileged boundary even when an anchor came from the renderer's parser. */
export function webWindowOpenHandler(openExternal: (url: string) => Promise<void>) {
  return ({ url }: { url: string }): { action: "deny" } => {
    const webUrl = externalWebUrl(url);
    if (webUrl) void openExternal(webUrl);
    return { action: "deny" };
  };
}
