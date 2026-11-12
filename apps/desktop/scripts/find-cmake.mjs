import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function findCmake(override) {
  if (override) return override;
  const onPath = spawnSync("where.exe", ["cmake.exe"], { encoding: "utf8", windowsHide: true });
  const candidates = (onPath.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "CMake/bin/cmake.exe"));
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
  if (existsSync(vswhere)) {
    const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.CMake.Project", "-property", "installationPath"],
      { encoding: "utf8", windowsHide: true });
    if (found.status === 0 && found.stdout.trim()) candidates.push(join(found.stdout.trim(), "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"));
  }
  const selected = candidates.find(path => existsSync(path));
  if (!selected) throw new Error("Install CMake on PATH or Visual Studio C++ CMake tools, or pass --cmake <executable>.");
  return selected;
}
