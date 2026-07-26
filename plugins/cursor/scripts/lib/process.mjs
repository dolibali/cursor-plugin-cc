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
    return { attempted: false, delivered: false, method: null }
  }
  if (process.platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"])
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" }
    }
    const detail = `${result.stderr}\n${result.stdout}`
    if (/not found|cannot find|does not exist|no running instance/i.test(detail)) {
      return { attempted: true, delivered: false, method: "taskkill" }
    }
    if (result.error) throw result.error
    throw new Error(detail.trim() || `taskkill failed with exit ${result.status}`)
  }
  try {
    process.kill(-pid, "SIGTERM")
    return { attempted: true, delivered: true, method: "process-group" }
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" }
    }
    try {
      process.kill(pid, "SIGTERM")
      return { attempted: true, delivered: true, method: "process" }
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process" }
      }
      throw innerError
    }
  }
}

export function forceTerminateProcessTree(pid) {
  if (!Number.isFinite(pid) || process.platform === "win32") return terminateProcessTree(pid)
  try {
    process.kill(-pid, "SIGKILL")
    return { attempted: true, delivered: true, method: "process-group-sigkill" }
  } catch (error) {
    if (error?.code === "ESRCH") return { attempted: true, delivered: false, method: "process-group-sigkill" }
    try {
      process.kill(pid, "SIGKILL")
      return { attempted: true, delivered: true, method: "process-sigkill" }
    } catch (innerError) {
      if (innerError?.code === "ESRCH") return { attempted: true, delivered: false, method: "process-sigkill" }
      throw innerError
    }
  }
}

export function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readProcessCommand(pid) {
  if (!Number.isFinite(pid)) return ""
  if (process.platform === "win32") {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    const result = runCommand("powershell.exe", ["-NoProfile", "-Command", script])
    return result.status === 0 ? result.stdout.trim() : ""
  }
  const result = runCommand("ps", ["-p", String(pid), "-o", "command="])
  return result.status === 0 ? result.stdout.trim() : ""
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
