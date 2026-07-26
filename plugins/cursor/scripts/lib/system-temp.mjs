import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const SYSTEM_TEMPORARY_ROOTS = (() => {
  const candidates = [os.tmpdir()]
  if (process.platform !== "win32") candidates.push("/tmp")
  return [...new Set(
    candidates
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => fs.realpathSync.native(candidate)),
  )]
})()

export function isSystemTemporaryPath(candidate) {
  const resolved = fs.realpathSync.native(candidate)
  return SYSTEM_TEMPORARY_ROOTS.some((root) => isInside(root, resolved))
}
