import { readFileSync } from "node:fs"

export interface ManifestInfo {
  name: string
  version: string
  depends: string[]
  author: string
  license: string
}

export function parseManifest(filePath: string, module: string): ManifestInfo {
  try {
    const src = readFileSync(filePath, "utf-8")

    // Extract name (handle both single and double quotes)
    let m = /"name"\s*:\s*"([^"]*)"/.exec(src)
    const name = m?.[1] ?? /'name'\s*:\s*'([^']*)'/.exec(src)?.[1] ?? module

    // Extract version
    m = /"version"\s*:\s*"([^"]*)"/.exec(src)
    const version = m?.[1] ?? /'version'\s*:\s*'([^']*)'/.exec(src)?.[1] ?? ""

    // Extract author
    m = /"author"\s*:\s*"([^"]*)"/.exec(src)
    const author = m?.[1] ?? /'author'\s*:\s*'([^']*)'/.exec(src)?.[1] ?? ""

    // Extract license
    m = /"license"\s*:\s*"([^"]*)"/.exec(src)
    const license_ = m?.[1] ?? /'license'\s*:\s*'([^']*)'/.exec(src)?.[1] ?? ""

    // Extract depends list using balanced-bracket scanner
    let dependsRaw = ""
    const dependsStartMatch = /"depends"\s*:\s*\[/.exec(src) ?? /'depends'\s*:\s*\[/.exec(src)
    if (dependsStartMatch) {
      let bracketDepth = 1
      let i = dependsStartMatch.index! + dependsStartMatch[0].length
      while (i < src.length && bracketDepth > 0) {
        if (src[i] === "[") bracketDepth++
        else if (src[i] === "]") bracketDepth--
        if (bracketDepth > 0) dependsRaw += src[i]
        i++
      }
    }
    const depends = [...dependsRaw.matchAll(/"([^"]+)"|'([^']+)'/g)]
      .map((m) => m[1] ?? m[2])
      .filter(Boolean)

    return { name, version, depends, author, license: license_ }
  } catch {
    return { name: module, version: "", depends: [], author: "", license: "" }
  }
}
