import { browserMediaSelectionProblem, BrowserMediaFilesSchema, type BrowserMediaFile } from "@arke-studio/contracts";

/** Called directly by the user gesture so browsers allow the native file chooser. */
export function pickBrowserMedia(): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.hidden = true;
    document.body.append(input);
    let finished = false;
    const finish = (files: File[]) => {
      if (finished) return; finished = true;
      input.remove(); resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener("cancel", () => finish([]), { once: true });
    try { input.click(); } catch (error) { input.remove(); reject(error); }
  });
}

export async function readBrowserMedia(files: readonly File[], stillCurrent: () => boolean): Promise<BrowserMediaFile[]> {
  const problem = browserMediaSelectionProblem(files);
  if (problem) throw new Error(problem);
  const result: BrowserMediaFile[] = [];
  for (const file of files) {
    if (!stillCurrent()) throw new Error("The studio or world changed. Choose the files again after reconnecting.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new Error(`${file.name}: the file changed while it was being read.`);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    result.push({ name: file.name, data: btoa(chunks.join("")) });
  }
  if (!stillCurrent()) throw new Error("The studio or world changed. Choose the files again after reconnecting.");
  return BrowserMediaFilesSchema.parse(result);
}
