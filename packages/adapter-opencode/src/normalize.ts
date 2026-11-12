/** Render a tool invocation as a product-language progress line (R-15). */
export function toolSummary(tool: string, input: Record<string, unknown> | undefined, title: string | undefined): string {
  if (tool.includes("search_canon")) {
    const q = typeof input?.["query"] === "string" ? ` — "${input["query"]}"` : "";
    return `checked canon${q}`;
  }
  if (tool.includes("get_entry")) {
    return `read canon entry ${String(input?.["id"] ?? "")}`.trim();
  }
  if (tool.includes("get_sheet")) {
    return `read sheet ${String(input?.["id"] ?? "")}`.trim();
  }
  if (tool.includes("list_entities")) {
    return `listed ${String(input?.["kind"] ?? "entities")}`;
  }
  if (tool.includes("related")) {
    return `followed citations from ${String(input?.["id"] ?? "")}`.trim();
  }
  if (tool === "edit" || tool === "write" || tool === "patch") {
    const path = typeof input?.["filePath"] === "string" ? (input["filePath"] as string) : undefined;
    const name = path ? (path.split(/[\\/]/).pop() ?? path) : "a file";
    return `${tool === "write" ? "wrote" : "edited"} ${name}`;
  }
  if (tool === "read") {
    const path = typeof input?.["filePath"] === "string" ? (input["filePath"] as string) : undefined;
    return `read ${path ? (path.split(/[\\/]/).pop() ?? path) : "a file"}`;
  }
  return title && title.length > 0 ? title : `used ${tool}`;
}
