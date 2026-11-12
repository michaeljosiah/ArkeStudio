import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function stageDotnetNotices(root, depsName, packageCache) {
  const notices = join(root, "THIRD-PARTY-NOTICES");
  mkdirSync(notices, { recursive: true });
  const deps = JSON.parse(readFileSync(join(root, depsName), "utf8"));
  const packages = Object.entries(deps.libraries)
    .filter(([, value]) => value.type === "package")
    .map(([id, value]) => ({ id, path: value.path }));
  const rows = [];
  const mitText = `Permission is hereby granted, free of charge, to any person obtaining a copy\n` +
    `of this software and associated documentation files (the "Software"), to deal\n` +
    `in the Software without restriction, including without limitation the rights\n` +
    `to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n` +
    `copies of the Software, and to permit persons to whom the Software is\n` +
    `furnished to do so, subject to the following conditions:\n\n` +
    `The above copyright notice and this permission notice shall be included in all\n` +
    `copies or substantial portions of the Software.\n\n` +
    `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n` +
    `IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n` +
    `FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n` +
    `AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n` +
    `LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n` +
    `OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n` +
    `SOFTWARE.\n`;
  for (const item of packages) {
    const packageRoot = join(packageCache, ...item.path.split("/"));
    const nuspec = readdirSync(packageRoot).find((name) => name.endsWith(".nuspec"));
    if (!nuspec) throw new Error(`${item.id} has no restored NuGet metadata`);
    const xml = readFileSync(join(packageRoot, nuspec), "utf8");
    const license = /<license[^>]*type="([^"]+)"[^>]*>([^<]+)<\/license>/i.exec(xml);
    if (!license) throw new Error(`${item.id} has no declared NuGet licence`);
    rows.push(`${item.id} | ${license[1]}: ${license[2]}`);
    const candidates = readdirSync(packageRoot).filter((name) => /^(license|third.?party)/i.test(name));
    for (const candidate of candidates) {
      if (statSync(join(packageRoot, candidate)).isFile()) {
        cpSync(join(packageRoot, candidate), join(notices, `${item.id.replaceAll("/", "-")}--${candidate}`));
      }
    }
    if (license[1].toLowerCase() === "expression" && license[2].toUpperCase() === "MIT" && candidates.length === 0) {
      const authors = /<authors>([^<]+)<\/authors>/i.exec(xml)?.[1] ?? "the package authors";
      writeFileSync(
        join(notices, `${item.id.replaceAll("/", "-")}--LICENSE.txt`),
        `Copyright (c) ${authors}\n\n${mitText}`,
      );
    }
  }
  writeFileSync(join(notices, "PACKAGES.txt"), `${rows.sort().join("\n")}\n`);
  for (const [source, target] of [
    [join(process.env["ProgramFiles"], "dotnet", "LICENSE.txt"), "DOTNET-LICENSE.txt"],
    [join(process.env["ProgramFiles"], "dotnet", "ThirdPartyNotices.txt"), "DOTNET-THIRD-PARTY-NOTICES.txt"],
  ]) {
    if (!existsSync(source)) throw new Error(`${target} is unavailable from the pinned .NET SDK`);
    cpSync(source, join(notices, target));
  }
}
