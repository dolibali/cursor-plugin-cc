#!/usr/bin/env node

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs"
import { buildAgentArgs, getAgentAuthStatus, getAgentAvailability, resolveAgentInvocation } from "./lib/agent.mjs"
import { resolveModel } from "./lib/model.mjs"
import { terminateProcessTree } from "./lib/process.mjs"
import {
  companionHomeDir,
  generateJobId,
  listJobs,
  loadGlobalConfig,
  readJobFile,
  resolveGlobalConfigPath,
  resolveJobsDir,
  resolveStateDir,
  saveGlobalConfig,
  upsertJob,
} from "./lib/state.mjs"
import { assertAbsoluteWorkspace } from "./lib/workspace.mjs"
import {
  renderCancelReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
} from "./lib/render.mjs"

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const COMPANION_SCRIPT = path.join(ROOT_DIR, "scripts", "cursor-companion.mjs")
const RUNNER_SCRIPT = path.join(ROOT_DIR, "scripts", "run-delegated-test.mjs")
const DEFAULT_FOREGROUND_TIMEOUT_MS = 3 * 60 * 60 * 1000

function printUsage() {
  console.log(`Usage:
  node scripts/cursor-companion.mjs setup [--json] [--set-model <slug|->]
  node scripts/cursor-companion.mjs task [--workspace <abs>] [--background] [--read-only] [--model <slug>] [--mode simple|e2e] [--timeout-ms <ms>] [--prompt-file <path>] [--artifact-dir <path>] [--required-check <id>]... -- <prompt>
  node scripts/cursor-companion.mjs status [job-id] [--workspace <abs>] [--json]
  node scripts/cursor-companion.mjs result [job-id] [--workspace <abs>] [--json]
  node scripts/cursor-companion.mjs cancel [job-id] [--workspace <abs>] [--json]
  (task/status/result/cancel default --workspace to process.cwd() when omitted)
`)
}

function outputResult(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2))
  else process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv
    if (!raw || !raw.trim()) return []
    return splitRawArgumentString(raw)
  }
  return argv
}

function nowIso() {
  return new Date().toISOString()
}

function previewText(text, max = 4000) {
  const trimmed = String(text ?? "").trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n…(truncated)`
}

function ensureJobLog(cwd, jobId) {
  const dir = resolveJobsDir(cwd)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${jobId}.log`)
}

async function runForeground(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      terminateProcessTree(child.pid)
      settled = true
      resolve({ status: 124, stdout, stderr: `${stderr}\ncompanion timeout after ${timeoutMs}ms`, timedOut: true, pid: child.pid })
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (options.logFile) fs.appendFileSync(options.logFile, chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (options.logFile) fs.appendFileSync(options.logFile, chunk)
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: 1, stdout, stderr: error.message, timedOut: false, pid: child.pid })
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: code ?? (signal ? 1 : 0), stdout, stderr, timedOut: false, pid: child.pid, signal })
    })
  })
}

function commandSetup(argv) {
  const { options } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["json"],
    valueOptions: ["set-model"],
  })
  if (options["set-model"] != null) {
    const config = loadGlobalConfig()
    if (options["set-model"] === "-" || options["set-model"] === "") {
      delete config.model
    } else {
      config.model = String(options["set-model"]).trim()
    }
    config.companionScript = COMPANION_SCRIPT
    saveGlobalConfig(config)
  }

  const agent = getAgentAvailability()
  const auth = agent.available ? getAgentAuthStatus(agent.bin) : { loggedIn: false, detail: "missing" }
  const model = resolveModel(null)
  const config = loadGlobalConfig()
  const payload = {
    ok: Boolean(agent.available && auth.loggedIn),
    agent,
    auth,
    model,
    companionScript: config.companionScript || COMPANION_SCRIPT,
    configPath: resolveGlobalConfigPath(),
    stateHome: companionHomeDir(),
  }
  outputResult(options.json ? payload : renderSetupReport(payload), Boolean(options.json))
  return payload.ok ? 0 : 1
}

function collectRequiredChecks(positionals, options) {
  const checks = []
  if (options["required-check"]) {
    const value = options["required-check"]
    if (Array.isArray(value)) checks.push(...value)
    else checks.push(value)
  }
  return checks
}

async function commandTask(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["background", "read-only", "json", "force"],
    valueOptions: [
      "workspace",
      "model",
      "mode",
      "timeout-ms",
      "prompt-file",
      "artifact-dir",
      "required-check",
      "agent-bin",
      "cwd",
    ],
  })

  // Allow repeated --required-check by rescanning argv
  const requiredChecks = []
  const raw = normalizeArgv(argv)
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "--required-check" && raw[i + 1]) {
      requiredChecks.push(raw[i + 1])
      i += 1
    }
  }

  const workspace = assertAbsoluteWorkspace(options.workspace || process.cwd())
  const mode = options.mode || "simple"
  const modelInfo = resolveModel(options.model)
  const background = Boolean(options.background)
  const readOnly = Boolean(options["read-only"])
  const timeoutMs = options["timeout-ms"]
    ? Number(options["timeout-ms"])
    : DEFAULT_FOREGROUND_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number")
  }

  let prompt = positionals.join(" ").trim()
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(options["prompt-file"], "utf8")
  }
  if (!prompt && mode !== "e2e") {
    throw new Error("task prompt is required (pass after -- or --prompt-file)")
  }

  const jobId = generateJobId()
  const logFile = ensureJobLog(workspace, jobId)
  const createdAt = nowIso()
  let job = upsertJob(workspace, {
    id: jobId,
    kind: "task",
    mode,
    status: "running",
    workspace,
    model: modelInfo.model,
    modelSource: modelInfo.source,
    readOnly,
    background,
    logFile,
    createdAt,
    promptPreview: previewText(prompt, 500),
  })

  if (mode === "e2e") {
    const artifactDir = options["artifact-dir"]
    const promptFile = options["prompt-file"]
    if (!artifactDir || !promptFile) {
      throw new Error("e2e mode requires --prompt-file and --artifact-dir")
    }
    if (!path.isAbsolute(artifactDir) || !path.isAbsolute(promptFile)) {
      throw new Error("--prompt-file and --artifact-dir must be absolute")
    }
    const runnerArgs = [
      RUNNER_SCRIPT,
      "--workspace",
      workspace,
      "--prompt-file",
      promptFile,
      "--artifact-dir",
      artifactDir,
    ]
    if (modelInfo.model) runnerArgs.push("--model", modelInfo.model)
    for (const check of requiredChecks) runnerArgs.push("--required-check", check)
    if (options["agent-bin"]) runnerArgs.push("--agent-bin", options["agent-bin"])

    if (background) {
      const out = fs.openSync(logFile, "a")
      const child = spawn(process.execPath, runnerArgs, {
        detached: true,
        stdio: ["ignore", out, out],
        env: process.env,
      })
      child.unref()
      job = upsertJob(workspace, {
        ...job,
        status: "running",
        pid: child.pid,
        resultFile: path.join(artifactDir, "run-result.json"),
      })
      const payload = { ...job, message: "e2e runner started in background" }
      outputResult(options.json ? payload : renderTaskResult(payload), Boolean(options.json))
      return 0
    }

    const result = await runForeground(process.execPath, runnerArgs, { timeoutMs, logFile })
    const resultFile = path.join(artifactDir, "run-result.json")
    job = upsertJob(workspace, {
      ...job,
      status: result.timedOut ? "timeout" : result.status === 0 ? "completed" : "failed",
      exitCode: result.status,
      stdoutPreview: previewText(result.stdout),
      error: result.status === 0 ? null : previewText(result.stderr || result.stdout),
      resultFile: fs.existsSync(resultFile) ? resultFile : null,
      finishedAt: nowIso(),
    })
    outputResult(options.json ? job : renderTaskResult(job), Boolean(options.json))
    return result.status === 0 ? 0 : result.status || 1
  }

  // simple mode
  const agent = getAgentAvailability()
  if (!agent.available) {
    job = upsertJob(workspace, { ...job, status: "failed", error: agent.detail, finishedAt: nowIso() })
    outputResult(options.json ? job : renderTaskResult(job), Boolean(options.json))
    return 1
  }
  const agentBin = options["agent-bin"] || agent.bin
  const inv = resolveAgentInvocation(agentBin)
  const args = [
    ...inv.prefixArgs,
    ...buildAgentArgs({
      prompt,
      workspace,
      model: modelInfo.model,
      readOnly,
      force: !readOnly,
    }),
  ]

  if (background) {
    const out = fs.openSync(logFile, "a")
    const child = spawn(inv.command, args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
      cwd: workspace,
    })
    child.unref()
    job = upsertJob(workspace, { ...job, status: "running", pid: child.pid, agentBin })
    outputResult(options.json ? job : renderTaskResult(job), Boolean(options.json))
    return 0
  }

  const result = await runForeground(inv.command, args, { timeoutMs, logFile, cwd: workspace })
  job = upsertJob(workspace, {
    ...job,
    status: result.timedOut ? "timeout" : result.status === 0 ? "completed" : "failed",
    exitCode: result.status,
    stdoutPreview: previewText(result.stdout),
    error: result.status === 0 ? null : previewText(result.stderr),
    finishedAt: nowIso(),
    agentBin,
  })
  // For parent agents: also print raw agent stdout after the report when not json
  if (options.json) {
    outputResult(job, true)
  } else {
    process.stdout.write(renderTaskResult(job))
    if (result.stdout?.trim()) {
      process.stdout.write("\n--- agent stdout ---\n")
      process.stdout.write(result.stdout)
      if (!result.stdout.endsWith("\n")) process.stdout.write("\n")
    }
  }
  return result.status === 0 ? 0 : result.status || 1
}

function resolveTargetJob(cwd, jobId) {
  if (jobId) {
    const fromFile = readJobFile(cwd, jobId)
    if (fromFile) return fromFile
    const fromList = listJobs(cwd).find((j) => j.id === jobId || j.id.startsWith(jobId))
    if (fromList) return fromList
    throw new Error(`Job not found: ${jobId}`)
  }
  const jobs = listJobs(cwd)
  if (!jobs.length) throw new Error("No jobs for this workspace")
  return jobs[0]
}

function commandStatus(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["json", "all"],
    valueOptions: ["workspace"],
  })
  const workspace = assertAbsoluteWorkspace(options.workspace || process.cwd())
  const jobs = listJobs(workspace)
  if (positionals[0]) {
    const job = resolveTargetJob(workspace, positionals[0])
    // refresh running pid
    if (job.status === "running" && job.pid) {
      try {
        process.kill(job.pid, 0)
      } catch {
        const refreshed = upsertJob(workspace, { ...job, status: "unknown", finishedAt: nowIso() })
        outputResult(options.json ? refreshed : renderTaskResult(refreshed), Boolean(options.json))
        return 0
      }
    }
    outputResult(options.json ? job : renderTaskResult(job), Boolean(options.json))
    return 0
  }
  const list = options.all ? jobs : jobs.slice(0, 8)
  outputResult(options.json ? { workspace, jobs: list, stateDir: resolveStateDir(workspace) } : renderStatusReport(list), Boolean(options.json))
  return 0
}

function commandResult(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["json"],
    valueOptions: ["workspace"],
  })
  const workspace = assertAbsoluteWorkspace(options.workspace || process.cwd())
  const job = resolveTargetJob(workspace, positionals[0])
  if (job.resultFile && fs.existsSync(job.resultFile)) {
    const raw = fs.readFileSync(job.resultFile, "utf8")
    if (options.json) {
      outputResult({ job, result: JSON.parse(raw) }, true)
    } else {
      process.stdout.write(renderTaskResult(job))
      process.stdout.write("\n--- result file ---\n")
      process.stdout.write(raw)
      if (!raw.endsWith("\n")) process.stdout.write("\n")
    }
    return job.status === "completed" ? 0 : 1
  }
  if (job.logFile && fs.existsSync(job.logFile)) {
    const log = fs.readFileSync(job.logFile, "utf8")
    job.stdoutPreview = previewText(log)
  }
  outputResult(options.json ? job : renderTaskResult(job), Boolean(options.json))
  return job.status === "completed" ? 0 : 1
}

function commandCancel(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["json"],
    valueOptions: ["workspace"],
  })
  const workspace = assertAbsoluteWorkspace(options.workspace || process.cwd())
  const job = resolveTargetJob(workspace, positionals[0])
  if (job.pid) terminateProcessTree(job.pid)
  const next = upsertJob(workspace, { ...job, status: "cancelled", finishedAt: nowIso() })
  outputResult(options.json ? next : renderCancelReport(next), Boolean(options.json))
  return 0
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const rest = argv.slice(1)
  if (!command || command === "-h" || command === "--help") {
    printUsage()
    process.exit(command ? 0 : 1)
  }
  try {
    let code = 0
    switch (command) {
      case "setup":
        code = commandSetup(rest)
        break
      case "task":
        code = await commandTask(rest)
        break
      case "status":
        code = commandStatus(rest)
        break
      case "result":
        code = commandResult(rest)
        break
      case "cancel":
        code = commandCancel(rest)
        break
      default:
        printUsage()
        code = 1
    }
    process.exit(code)
  } catch (error) {
    console.error(error?.message || error)
    process.exit(1)
  }
}

await main()
