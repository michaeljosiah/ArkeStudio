import { join } from "node:path";
import { AppLog } from "../app-log.js";
import { ChangeLog } from "../change-log.js";
import { CredentialStore, type Cipher } from "../credentials/store.js";
import { SecretRegistry } from "../redact.js";
import { LedgerFile } from "../spend/ledger.js";
import { AppSettingsFile } from "../app-settings.js";
import { FileEngineOperationStore } from "./local-operations.js";

export interface StudioStorageOptions {
  appRoot?: string;
  changeLogPath: string;
  cipher?: Cipher;
  credentialsFileName?: string;
  secretRegistry?: SecretRegistry;
}

/** Local infrastructure is selected once by desktop/dev startup, not by authoring services. */
export function createStudioStorage(options: StudioStorageOptions) {
  const secrets = options.secretRegistry ?? new SecretRegistry();
  let onLogChanged = () => {};
  return {
    secrets,
    changeLog: new ChangeLog(options.changeLogPath),
    appLog: options.appRoot ? new AppLog(join(options.appRoot, "logs", "app.jsonl"), secrets, () => onLogChanged()) : null,
    credentials: options.appRoot && options.cipher
      ? new CredentialStore(join(options.appRoot, options.credentialsFileName ?? "credentials.dat"), options.cipher, secrets) : null,
    ledger: options.appRoot ? new LedgerFile(join(options.appRoot, "ledger.jsonl")) : null,
    appSettings: options.appRoot ? new AppSettingsFile(join(options.appRoot, "settings.json")) : null,
    operations: new FileEngineOperationStore(options.appRoot
      ? join(options.appRoot, "engine", "operations.jsonl") : `${options.changeLogPath}.engine.jsonl`),
    onLogChanged(callback: () => void) { onLogChanged = callback; },
  };
}
export type StudioStorage = ReturnType<typeof createStudioStorage>;
