import { spawn, spawnSync } from "node:child_process"
import process from "node:process"

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    windowsHide: true,
  })

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  }
}

export function binaryAvailable(command, versionArgs = ["--version"]) {
  const result = runCommand(command, versionArgs)
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found" }
  }
  if (result.error) {
    return { available: false, detail: result.error.message }
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    return { available: false, detail }
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" }
}

export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false }
  }
  try {
    process.kill(-pid, "SIGTERM")
    return { attempted: true, delivered: true, method: "group-sigterm" }
  } catch {
    try {
      process.kill(pid, "SIGTERM")
      return { attempted: true, delivered: true, method: "sigterm" }
    } catch {
      return { attempted: true, delivered: false }
    }
  }
}

export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.stdio ?? "ignore",
  })
  child.unref()
  return child
}
