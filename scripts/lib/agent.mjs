import process from "node:process"

import { binaryAvailable, runCommand } from "./process.mjs"

function isJsScript(bin) {
  return typeof bin === "string" && (bin.endsWith(".mjs") || bin.endsWith(".js"))
}

export function resolveAgentInvocation(bin) {
  if (!bin) return null
  if (isJsScript(bin)) {
    return { command: process.execPath, prefixArgs: [bin] }
  }
  return { command: bin, prefixArgs: [] }
}

export function resolveAgentBin(env = process.env) {
  if (env.CURSOR_COMPANION_AGENT_BIN) return env.CURSOR_COMPANION_AGENT_BIN
  if (binaryAvailable("agent", ["--help"]).available) return "agent"
  if (binaryAvailable("cursor-agent", ["--help"]).available) return "cursor-agent"
  return null
}

export function getAgentAvailability(env = process.env) {
  const bin = resolveAgentBin(env)
  if (!bin) return { available: false, bin: null, detail: "agent / cursor-agent not found on PATH" }
  const inv = resolveAgentInvocation(bin)
  const check = isJsScript(bin)
    ? runCommand(inv.command, [...inv.prefixArgs, "--help"], { env })
    : null
  if (isJsScript(bin)) {
    const available = !check.error && check.status === 0
    return {
      available,
      bin,
      detail: available ? (check.stdout.trim() || "ok") : (check.stderr || check.error?.message || "failed"),
    }
  }
  const avail = binaryAvailable(bin, ["--help"])
  return { available: avail.available, bin, detail: avail.detail }
}

export function getAgentAuthStatus(bin, env = process.env) {
  if (!bin) return { loggedIn: false, detail: "agent binary missing" }
  const inv = resolveAgentInvocation(bin)
  const result = runCommand(inv.command, [...inv.prefixArgs, "status"], { env })
  const text = `${result.stdout}\n${result.stderr}`
  if (result.error) return { loggedIn: false, detail: result.error.message }
  const loggedIn = /logged in|authenticated|Logged in/i.test(text) && !/not logged|unauthenticated|login required/i.test(text)
  const maybeOk = result.status === 0 && !/login required|please log in|not logged/i.test(text)
  return {
    loggedIn: loggedIn || maybeOk,
    detail: text.trim().slice(0, 500) || `exit ${result.status}`,
    status: result.status,
  }
}

export function buildAgentArgs({ prompt, workspace, model = null, readOnly = false, force = true }) {
  const args = ["-p", "--trust", "--workspace", workspace]
  if (model) args.push("--model", model)
  if (readOnly) args.push("--mode", "ask")
  else if (force) args.push("--force")
  args.push(prompt)
  return args
}
