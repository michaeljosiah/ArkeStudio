import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AonikAccount, AonikPublishingApi, CreatorPublishingService, NoArkeCloud, parseAonikConfiguration,
  type Cipher, type CoordinatorOptions } from "@arke-studio/coordinator";

export interface DesktopCreatorPublishingOptions {
  appRoot: string;
  cipher: Cipher;
  openExternal: (url: string) => Promise<void>;
  secrets: { register(secret: string): void };
  configurationFile?: string;
}

/** Optional native host adapter. No cloud setup or storage failure can stop local Studio. */
export async function createDesktopCreatorPublishing(options: DesktopCreatorPublishingOptions): Promise<Pick<CoordinatorOptions, "account" | "creatorPublishing">> {
  const file = options.configurationFile ?? join(options.appRoot, "aonik-publishing.json");
  try {
    const text = await readFile(file, "utf8"); if (text.length > 16384) throw new Error("Configuration limit");
    const configuration = parseAonikConfiguration(JSON.parse(text));
    const root = join(options.appRoot, "creator-publishing");
    const account = new AonikAccount({ configuration, file: join(root, "account.dat"), cipher: options.cipher, openExternal: options.openExternal, secrets: options.secrets });
    await account.initialise();
    return { account, creatorPublishing: new CreatorPublishingService(root, account, new AonikPublishingApi(configuration, account)) };
  } catch {
    return { account: new NoArkeCloud("Cloud publishing is not configured on this device. Local Studio remains available.") };
  }
}
