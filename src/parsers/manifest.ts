import { readFileSync } from "node:fs";

export interface ManifestInfo {
  name: string;
  version: string;
  depends: string[];
  author: string;
  license: string;
}

function extractStringField(src: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(src);
  return m?.[1] ?? new RegExp(`'${key}'\\s*:\\s*'([^']*)'`).exec(src)?.[1];
}

export function parseManifest(filePath: string, module: string): ManifestInfo {
  try {
    const src = readFileSync(filePath, "utf-8");

    // Extract name, version, author, license (handle both single and double quotes)
    const name = extractStringField(src, "name") ?? module;
    const version = extractStringField(src, "version") ?? "";
    const author = extractStringField(src, "author") ?? "";
    const license = extractStringField(src, "license") ?? "";

    // Extract depends list using balanced-bracket scanner
    let dependsRaw = "";
    const dependsStartMatch = /"depends"\s*:\s*\[/.exec(src) ?? /'depends'\s*:\s*\[/.exec(src);
    if (dependsStartMatch) {
      let bracketDepth = 1;
      let i = dependsStartMatch.index! + dependsStartMatch[0].length;
      while (i < src.length && bracketDepth > 0) {
        if (src[i] === "[") bracketDepth++;
        else if (src[i] === "]") bracketDepth--;
        if (bracketDepth > 0) dependsRaw += src[i];
        i++;
      }
    }
    const depends = [...dependsRaw.matchAll(/"([^"]+)"|'([^']+)'/g)]
      .map((m) => m[1] ?? m[2])
      .filter(Boolean);

    return { name, version, depends, author, license };
  } catch (err) {
    console.warn(`[manifest] Failed to parse ${filePath}:`, err);
    return { name: module, version: "", depends: [], author: "", license: "" };
  }
}
