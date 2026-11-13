import { crc32, deflateRawSync } from "node:zlib";

/**
 * A zip written by hand, for the archives a test has to forge. yazl, which writes every real
 * archive, refuses `../escape.txt`, `C:/escape.txt`, a file named `media/` and a backslash
 * left in a name, and those are exactly what extraction must be shown to refuse. Its fixed
 * layout — no extra fields, no data descriptors — is also what lets a test find a central
 * record and flip one field in it.
 */
export interface ZipEntry {
  /** The entry's path inside the zip, written as given. */
  name: string;
  data: Uint8Array;
  stored?: boolean;
}

// DOS time 00:00:00, 1980-01-01, so a fixture is the same bytes on every run.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

export function handZip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = entry.stored ? null : new Uint8Array(deflateRawSync(entry.data));
    const method = deflated !== null && deflated.byteLength < entry.data.byteLength ? 8 : 0;
    const payload = method === 8 ? deflated! : entry.data;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(0, 6); // no flags, so a test that sets the encrypted bit sets only that
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(new Uint8Array(local), payload);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0
    central.writeUInt16LE(20, 6); // needed: 2.0
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(new Uint8Array(central));

    offset += local.byteLength + payload.byteLength;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return concat([...locals, ...centrals, new Uint8Array(end)]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
