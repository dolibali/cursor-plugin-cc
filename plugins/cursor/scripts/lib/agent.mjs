import process from "node:process"

import { runCommand } from "./process.mjs"

const helpCache = new Map()

function isJsScript(bin) {
  return typeof bin === "string" && (bin.endsWith(".mjs") || bin.endsWith(".js"))
}

function getAgentHelp(bin, env = process.env) {
  if (helpCache.has(bin)) return helpCache.get(bin)
  const invocation = resolveAgentInvocation(bin)
  const result = runCommand(invocation.command, [...invocation.prefixArgs, "--help"], { env })
  helpCache.set(bin, result)
  return result
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
  if (getAgentHelp("agent", env).status === 0) return "agent"
  if (getAgentHelp("cursor-agent", env).status === 0) return "cursor-agent"
  return null
}

export function getAgentAvailability(env = process.env) {
  const bin = resolveAgentBin(env)
  if (!bin) return { available: false, bin: null, detail: "agent / cursor-agent not found on PATH" }
  const check = getAgentHelp(bin, env)
  const available = !check.error && check.status === 0
  return {
    available,
    bin,
    detail: available
      ? "ok"
      : (check.stderr || check.error?.message || `exit ${check.status}`),
  }
}

export function agentSupportsSandbox(bin, env = process.env) {
  if (!bin) return false
  const result = getAgentHelp(bin, env)
  return !result.error && result.status === 0 && /--sandbox\b/.test(`${result.stdout}\n${result.stderr}`)
}

export function getAgentAuthStatus(bin, env = process.env) {
  if (!bin) return { loggedIn: false, detail: "agent binary missing" }
  const inv = resolveAgentInvocation(bin)
  const result = runCommand(inv.command, [...inv.prefixArgs, "status"], { env })
  const text = `${result.stdout}\n${result.stderr}`
  if (result.error) return { loggedIn: false, detail: result.error.message }
  const loggedIn = /logged in|authenticated|Logged in/i.test(text) && !/not logged|unauthenticated|login required/i.test(text)
  const maybeOk = result.status === 0 && !/login required|please log in|not logged/i.test(text)
  const authenticated = loggedIn || maybeOk
  return {
    loggedIn: authenticated,
    detail: authenticated ? "ok" : (text.trim().slice(0, 500) || `exit ${result.status}`),
    status: result.status,
  }
}

export function buildAgentArgs({
  prompt,
  workspace,
  addDirs = [],
  model = null,
  readOnly = false,
  force = true,
  sandbox = "enabled",
  streamJson = false,
  resumeSessionId = null,
}) {
  const args = ["-p", "--trust", "--sandbox", sandbox, "--workspace", workspace]
  for (const directory of addDirs) args.push("--add-dir", directory)
  if (model) args.push("--model", model)
  if (readOnly) args.push("--mode", "ask")
  else if (force) args.push("--force")
  if (streamJson) args.push("--output-format", "stream-json", "--stream-partial-output")
  if (resumeSessionId) args.push("--resume", resumeSessionId)
  args.push(prompt)
  return args
}
