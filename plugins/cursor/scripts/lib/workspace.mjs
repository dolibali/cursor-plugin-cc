import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const FORBIDDEN_BASENAMES = new Set([
  "Desktop",
  "Downloads",
  "Documents",
  "Movies",
  "Music",
  "Pictures",
])

export function assertAbsoluteWorkspace(workspace, optionName = "--workspace") {
  if (!workspace || typeof workspace !== "string") {
    throw new Error(`${optionName} is required and must be an absolute path to the target code directory`)
  }
  if (!path.isAbsolute(workspace)) {
    throw new Error(`${optionName} must be absolute, got: ${workspace}`)
  }

  let resolved = path.resolve(workspace)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {
    // keep resolved
  }

  const home = os.homedir()
  let homeResolved = path.resolve(home)
  try {
    homeResolved = fs.realpathSync.native(home)
  } catch {
    // keep
  }

  if (resolved === homeResolved) {
    throw new Error(`${optionName} must not be the user home directory`)
  }

  for (const name of FORBIDDEN_BASENAMES) {
    const candidate = path.join(homeResolved, name)
    if (resolved === candidate || resolved.startsWith(`${candidate}${path.sep}`)) {
      throw new Error(`${optionName} must not be under ~/${name}`)
    }
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`${optionName} does not exist: ${resolved}`)
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${optionName} is not a directory: ${resolved}`)
  }

  return resolved
}

export function resolveWorkspaceRoots(workspace, addDirs = []) {
  const primary = assertAbsoluteWorkspace(workspace)
  const seen = new Set([primary])
  const additional = []
  for (const candidate of addDirs) {
    const resolved = assertAbsoluteWorkspace(candidate, "--add-dir")
    if (seen.has(resolved)) continue
    seen.add(resolved)
    additional.push(resolved)
  }
  return { primary, additional, all: [primary, ...additional] }
}

export function resolveWorkspaceRoot(cwd) {
  return path.resolve(cwd || process.cwd())
}
