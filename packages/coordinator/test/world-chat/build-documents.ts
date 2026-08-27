import { deflateRawSync } from "node:zlib";

/**
 * Building the files the extractor is asked to read (#70 §13.2).
 *
 * Built rather than committed, because what is under test is the reading of a format and a
 * format is a specification, not a sample. A hand-built file can be made to hold exactly the one
 * thing being tested — a two-byte font with a `ToUnicode` map, a page that is only a picture —
 * where a real document holds everything at once and proves whichever of them fails last.
 */

export function ascii(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
}

export interface PdfPart {
  dict: string;
  stream?: Uint8Array;
}

/** A PDF whose objects are numbered in the order given. Enough of one to be read, at least. */
export function pdf(parts: readonly PdfPart[]): Uint8Array {
  const chunks: Uint8Array[] = [ascii("%PDF-1.7\n")];
  parts.forEach((part, index) => {
    chunks.push(ascii(`${index + 1} 0 obj\n`));
    if (part.stream) {
      chunks.push(ascii(`${part.dict.replace(/>>$/, `/Length ${part.stream.byteLength}>>`)}\nstream\n`));
      chunks.push(part.stream);
      chunks.push(ascii("\nendstream\n"));
    } else {
      chunks.push(ascii(`${part.dict}\n`));
    }
    chunks.push(ascii("endobj\n"));
  });
  chunks.push(ascii("trailer<</Root 1 0 R>>\n%%EOF"));
  return concat(chunks);
}

/** A one-page PDF around one content stream, with whatever fonts it names. */
export function onePage(
  content: string,
  options: { fonts?: string; extra?: readonly PdfPart[] } = {},
): Uint8Array {
  const resources = options.fonts ? `/Resources<</Font<<${options.fonts}>>>>` : "";
  return pdf([
    { dict: "<</Type/Catalog/Pages 2 0 R>>" },
    { dict: "<</Type/Pages/Kids[3 0 R]/Count 1>>" },
    { dict: `<</Type/Page/Parent 2 0 R${resources}/Contents 4 0 R>>` },
    { dict: "<<>>", stream: ascii(content) },
    ...(options.extra ?? []),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** A real zip, because a .docx is a real zip and the reading of one is what is under test. */
export function zip(
  entries: ReadonlyArray<{ name: string; bytes: Uint8Array; store?: boolean }>,
): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "latin1");
    const data = entry.store
      ? Buffer.from(entry.bytes)
      : deflateRawSync(Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength));
    const crc = crc32(entry.bytes);

    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    locals.push(new Uint8Array(local), new Uint8Array(data));

    const dir = Buffer.alloc(46 + name.byteLength);
    dir.writeUInt32LE(0x0201_4b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(entry.store ? 0 : 8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.byteLength, 20);
    dir.writeUInt32LE(entry.bytes.byteLength, 24);
    dir.writeUInt16LE(name.byteLength, 28);
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);
    central.push(new Uint8Array(dir));

    offset += local.byteLength + data.byteLength;
  }

  const directory = Buffer.concat(central.map((c) => Buffer.from(c)));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return concat([...locals, new Uint8Array(directory), new Uint8Array(end)]);
}

export function docx(body: string): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zip([
    { name: "[Content_Types].xml", bytes: ascii("<Types/>"), store: true },
    { name: "word/document.xml", bytes: new Uint8Array(Buffer.from(document, "utf8")) },
  ]);
}

export function paragraph(...runs: string[]): string {
  return `<w:p><w:r>${runs.map((r) => `<w:t xml:space="preserve">${r}</w:t>`).join("")}</w:r></w:p>`;
}

/** A one-page PDF that says one thing. */
export function onePagePdf(line: string): Uint8Array {
  return onePage(`BT /F1 12 Tf (${line}) Tj ET`);
}

/** A .docx of one paragraph. */
export function oneParagraphDocx(line: string): Uint8Array {
  return docx(paragraph(line));
}

/** A page with a picture on it and not one word — a scan, as far as anything can tell. */
export function pictureOnlyPdf(): Uint8Array {
  return onePage("q 612 0 0 792 0 0 cm /X1 Do Q", {
    extra: [
      {
        dict: "<</Type/XObject/Subtype/Image/Width 8>>",
        stream: ascii("a picture, or near enough - it is never decoded"),
      },
    ],
  });
}
