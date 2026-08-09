import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Cipher } from "./store.js";

/**
 * The cipher for `npm run dev`, where Electron's `safeStorage` does not exist (issue #227).
 *
 * Without one the coordinator built no credential store at all, and every key pasted into
 * Settings was dropped on the floor — no error, no event, no log line — so the dev stack could
 * not generate anything and the failure was indistinguishable from a rejected key. This is what
 * makes dev a place work can happen.
 *
 * The key is 32 random bytes held in this process and written nowhere. That is deliberate, and
 * it is the whole security story: a key file beside the ciphertext would be obfuscation wearing
 * encryption's clothes, and a real provider key is real money. The cost is that a credential
 * lives for one coordinator run — the dev entry clears the stale file on start rather than
 * leaving Settings claiming a key it can no longer read.
 *
 * It is not, and must never become, the desktop's cipher: that one encrypts against a key the OS
 * holds, which is the only reason a key can survive a restart at rest.
 */
export function devCipher(): Cipher {
  const key = randomBytes(32);
  return {
    isAvailable: () => true,
    encryptString: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      // iv ‖ tag ‖ ciphertext — both fixed-width parts lead, so the split is arithmetic.
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: (buf) => {
      if (buf.length < 28) throw new Error("dev credential store: ciphertext is too short to be ours");
      const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
