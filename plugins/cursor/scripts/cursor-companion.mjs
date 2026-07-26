#!/usr/bin/env node

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import {
  agentSupportsSandbox,
  buildAgentArgs,
  getAgentAuthStatus,
  getAgentAvailability,
  resolveAgentInvocation,
} from "./lib/agent.mjs"
import { parseArgs, splitRawArgumentString } from "./lib/args.mjs"
import { resolveModel } from "./lib/model.mjs"
import {
  forceTerminateProcessTree,
  isProcessAlive,
  readProcessCommand,
  runCommand,
  terminateProcessTree,
} from "./lib/process.mjs"
import {
  renderCancelReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
} from "./lib/render.mjs"
import {
  createCursorStreamCollector,
  readCursorSession,
  readJsonIfPresent,
  resumePolicyFromResult,
  validCursorSessionId,
  validateResumeRequest,
} from "./lib/resume.mjs"
import {
  companionHomeDir,
  generateJobId,
  listJobs,
  loadGlobalConfig,
  readJobFile,
  resolveGlobalConfigPath,
  resolveJobFile,
  resolveJobsDir,
  resolveStateDir,
  saveGlobalConfig,
  upsertJob,
  writeJsonAtomic,
} from "./lib/state.mjs"
import { isSystemTemporaryPath } from "./lib/system-temp.mjs"
import { runTrackedJob } from "./lib/tracked-jobs.mjs"
import { assertAbsoluteWorkspace, resolveWorkspaceRoots } from "./lib/workspace.mjs"

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "cursor-companion.mjs")
const RUNNER_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "run-delegated-test.mjs")
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000
const MAX_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000
const MAX_LONG_COMMAND_TIMEOUT_MS = 30 * 60 * 1000
const TERMINATE_GRACE_MS = 1_000
const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout", "cancelled"])
const ARTIFACT_CLAIM_FILE = ".cursor-companion-job.json"

function printUsage() {
  console.log(`Usage:
  node scripts/cursor-companion.mjs setup [--json] [--set-model <slug|->]
  node scripts/cursor-companion.mjs task [--workspace <abs>] [--add-dir <abs>]...
    [--background] [--read-only] [--sandbox enabled|disabled] [--model <slug>]
    [--mode simple|e2e] [--timeout-ms <ms>] [--prompt-file <path>]
    [--artifact-dir <path>] [--required-check <id>]... [--optional-check <id>]...
    [--resume-job <job-id-or-prefix>]
    [--no-progress-timeout-ms <ms>] [--long-command-timeout-ms <ms>] -- <prompt>
  node scripts/cursor-companion.mjs status [job-id] [--workspace <abs>] [--json]
  node scripts/cursor-companion.mjs result [job-id] [--workspace <abs>] [--json]
  node scripts/cursor-companion.mjs cancel [job-id] [--workspace <abs>] [--json]
`)
}

function outputResult(value, asJson) {
  if (asJson) console.log(JSON.stringify(value, null, 2))
  else process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function normalizeArgv(argv) {
  if (argv.length !== 1) return argv
  const [raw] = argv
  return raw?.trim() ? splitRawArgumentString(raw) : []
}

function nowIso() {
  return new Date().toISOString()
}

function previewText(text, max = 4_000) {
  const trimmed = String(text ?? "").trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n...(truncated)`
}

function publicJob(job) {
  const { request: _request, ...visible } = job
  return visible
}

function parsePositiveNumber(value, optionName, fallback = null) {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`)
  }
  return parsed
}

function parseBoundedNumber(value, optionName, maximum, fallback = null) {
  const parsed = parsePositiveNumber(value, optionName, fallback)
  if (parsed != null && parsed > maximum) {
    throw new Error(`${optionName} cannot exceed ${maximum}ms`)
  }
  return parsed
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function resolveExistingParent(candidate) {
  let current = candidate
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`No existing parent for path: ${candidate}`)
    current = parent
  }
  return fs.realpathSync.native(current)
}

function validateE2EPaths(workspaceRoots, artifactDir) {
  const artifactBoundary = fs.existsSync(artifactDir)
    ? fs.realpathSync.native(artifactDir)
    : resolveExistingParent(artifactDir)
  if (!isSystemTemporaryPath(artifactBoundary)) {
    throw new Error("--artifact-dir must be under the system temporary directory")
  }
  if (workspaceRoots.some((root) => isInside(root, artifactBoundary))) {
    throw new Error("--artifact-dir must be outside every workspace")
  }
  if (fs.existsSync(artifactDir) && !fs.statSync(artifactDir).isDirectory()) {
    throw new Error("--artifact-dir must be a directory")
  }
  for (const root of workspaceRoots) {
    const result = runCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"])
    if (result.error || result.status !== 0 || result.stdout.trim() !== "true") {
      throw new Error(`E2E workspace must be a Git worktree: ${root}`)
    }
  }
}

function ensureJobLog(workspace, jobId) {
  const directory = resolveJobsDir(workspace)
  fs.mkdirSync(directory, { recursive: true })
  return path.join(directory, `${jobId}.log`)
}

function artifactClaimPath(artifactDir) {
  return path.join(artifactDir, ARTIFACT_CLAIM_FILE)
}

function releaseArtifactClaim(artifactDir, jobId) {
  if (!artifactDir) return
  const claimFile = artifactClaimPath(artifactDir)
  try {
    const owner = JSON.parse(fs.readFileSync(claimFile, "utf8"))
    if (owner.jobId === jobId) fs.unlinkSync(claimFile)
  } catch (error) {
    if (error?.code === "ENOENT") return
  }
}

function claimArtifactDirectory(artifactDir, workspace, jobId) {
  if (!artifactDir) return
  fs.mkdirSync(artifactDir, { recursive: true })
  const claimFile = artifactClaimPath(artifactDir)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporaryClaim = `${claimFile}.${process.pid}.${jobId}.tmp`
    try {
      fs.writeFileSync(temporaryClaim, `${JSON.stringify({
        jobId,
        workspace,
        createdAt: nowIso(),
      }, null, 2)}\n`, { mode: 0o600 })
      fs.linkSync(temporaryClaim, claimFile)
      return
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      let owner
      try {
        owner = JSON.parse(fs.readFileSync(claimFile, "utf8"))
      } catch {
        throw new Error(`Artifact directory has an unreadable ownership claim: ${artifactDir}`)
      }
      let ownerJob = null
      try {
        ownerJob = owner?.workspace && owner?.jobId
          ? readJobFile(owner.workspace, owner.jobId)
          : null
      } catch {
        throw new Error(`Artifact directory has an invalid ownership claim: ${artifactDir}`)
      }
      if (ownerJob && !TERMINAL_STATUSES.has(ownerJob.status)) {
        throw new Error(
          `Artifact directory is already used by active job ${owner.jobId}; use a unique directory per delegation`,
        )
      }
      fs.unlinkSync(claimFile)
    } finally {
      fs.rmSync(temporaryClaim, { force: true })
    }
  }
  throw new Error(`Unable to claim artifact directory: ${artifactDir}`)
}

function validateSandbox(value) {
  const sandbox = value ?? "enabled"
  if (sandbox !== "enabled" && sandbox !== "disabled") {
    throw new Error("--sandbox must be enabled or disabled")
  }
  return sandbox
}

function validateMode(value) {
  const mode = value ?? "simple"
  if (mode !== "simple" && mode !== "e2e") {
    throw new Error("--mode must be simple or e2e")
  }
  return mode
}

function appendLog(logFile, chunk) {
  if (logFile && chunk?.length) fs.appendFileSync(logFile, chunk)
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let streamFailureCode = null
    let forceTimer = null
    let fallbackTimer = null
    let signalForceTimer = null
    const forwardSignal = () => {
      if (settled) return
      terminateProcessTree(child.pid)
      signalForceTimer ??= setTimeout(
        () => forceTerminateProcessTree(child.pid),
        TERMINATE_GRACE_MS,
      )
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(forceTimer)
      clearTimeout(fallbackTimer)
      clearTimeout(signalForceTimer)
      process.off("SIGINT", forwardSignal)
      process.off("SIGTERM", forwardSignal)
      resolve(value)
    }
    const timeoutTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      terminateProcessTree(child.pid)
      forceTimer = setTimeout(() => forceTerminateProcessTree(child.pid), TERMINATE_GRACE_MS)
      fallbackTimer = setTimeout(() => finish({
        exitCode: 124,
        stdout,
        stderr: `${stderr}\ncompanion timeout after ${timeoutMs}ms`,
        timedOut: true,
      }), TERMINATE_GRACE_MS * 2)
    }, timeoutMs)
    process.once("SIGINT", forwardSignal)
    process.once("SIGTERM", forwardSignal)

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      if (options.captureStdout !== false) stdout += text
      appendLog(options.logFile, chunk)
      if (!options.onStdout || streamFailureCode) return
      try {
        streamFailureCode = options.onStdout(text) ?? null
      } catch (error) {
        streamFailureCode = error instanceof Error ? error.message : String(error)
      }
      if (streamFailureCode) {
        terminateProcessTree(child.pid)
        forceTimer ??= setTimeout(
          () => forceTerminateProcessTree(child.pid),
          TERMINATE_GRACE_MS,
        )
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      appendLog(options.logFile, chunk)
    })
    child.on("error", (error) => finish({ exitCode: 1, stdout, stderr: error.message, timedOut: false }))
    child.on("close", (code, signal) => {
      finish({
        exitCode: timedOut ? 124 : streamFailureCode ? 1 : code ?? (signal ? 1 : 0),
        stdout,
        stderr: timedOut
          ? `${stderr}\ncompanion timeout after ${timeoutMs}ms`
          : streamFailureCode
            ? `${stderr}\n${streamFailureCode}`
            : stderr,
        timedOut,
        signal,
        failureCode: streamFailureCode,
      })
    })
  })
}

function commandSetup(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["json"],
    valueOptions: ["set-model"],
  })
  if (positionals.length) throw new Error(`Unexpected setup arguments: ${positionals.join(" ")}`)
  if (options["set-model"] != null) {
    const config = loadGlobalConfig()
    if (options["set-model"] === "-" || options["set-model"] === "") delete config.model
    else config.model = String(options["set-model"]).trim()
    config.companionScript = COMPANION_SCRIPT
    saveGlobalConfig(config)
  }

  const agent = getAgentAvailability()
  const auth = agent.available ? getAgentAuthStatus(agent.bin) : { loggedIn: false, detail: "missing" }
  const sandboxSupported = agent.available && agentSupportsSandbox(agent.bin)
  const config = loadGlobalConfig()
  const payload = {
    ok: Boolean(agent.available && auth.loggedIn && sandboxSupported),
    agent,
    auth,
    sandboxSupported,
    model: resolveModel(null),
    companionScript: config.companionScript || COMPANION_SCRIPT,
    configPath: resolveGlobalConfigPath(),
    stateHome: companionHomeDir(),
  }
  outputResult(options.json ? payload : renderSetupReport(payload), Boolean(options.json))
  return payload.ok ? 0 : 1
}

function parseTaskRequest(argv) {
  const normalized = normalizeArgv(argv)
  const { options, positionals } = parseArgs(normalized, {
    booleanOptions: ["background", "read-only", "json"],
    valueOptions: [
      "workspace",
      "add-dir",
      "model",
      "mode",
      "sandbox",
      "timeout-ms",
      "prompt-file",
      "artifact-dir",
      "required-check",
      "optional-check",
      "no-progress-timeout-ms",
      "long-command-timeout-ms",
      "agent-bin",
      "resume-job",
    ],
    repeatableOptions: ["add-dir", "required-check", "optional-check"],
  })
  const workspaceRoots = resolveWorkspaceRoots(options.workspace || process.cwd(), options["add-dir"] ?? [])
  const mode = validateMode(options.mode)
  const sandbox = validateSandbox(options.sandbox)
  const timeoutMs = parseBoundedNumber(
    options["timeout-ms"],
    "--timeout-ms",
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  )
  const noProgressTimeoutMs = parseBoundedNumber(
    options["no-progress-timeout-ms"],
    "--no-progress-timeout-ms",
    MAX_PROGRESS_TIMEOUT_MS,
  )
  const longCommandTimeoutMs = parseBoundedNumber(
    options["long-command-timeout-ms"],
    "--long-command-timeout-ms",
    MAX_LONG_COMMAND_TIMEOUT_MS,
  )
  const promptFile = options["prompt-file"] ? path.resolve(options["prompt-file"]) : null
  if (promptFile && (!path.isAbsolute(options["prompt-file"]) || !fs.existsSync(promptFile))) {
    throw new Error("--prompt-file must be an existing absolute path")
  }
  let prompt = positionals.join(" ").trim()
  if (promptFile && prompt) throw new Error("Do not pass prompt text together with --prompt-file")
  if (promptFile) prompt = fs.readFileSync(promptFile, "utf8")

  let artifactDir = null
  if (mode === "e2e") {
    if (!promptFile || !options["artifact-dir"]) {
      throw new Error("e2e mode requires --prompt-file and --artifact-dir")
    }
    if (!path.isAbsolute(options["artifact-dir"])) throw new Error("--artifact-dir must be absolute")
    artifactDir = path.resolve(options["artifact-dir"])
    if (options["read-only"]) throw new Error("--read-only is not supported with --mode e2e")
    validateE2EPaths(workspaceRoots.all, artifactDir)
  } else {
    if (!prompt) {
      throw new Error("task prompt is required (pass after -- or use --prompt-file)")
    }
    if (
      options["artifact-dir"]
      || options["required-check"]?.length
      || options["optional-check"]?.length
      || noProgressTimeoutMs
      || longCommandTimeoutMs
    ) {
      throw new Error("--artifact-dir, check options, and progress timeouts require --mode e2e")
    }
  }

  const request = {
    mode,
    sandbox,
    hostAccess: sandbox === "disabled" ? "unrestricted" : "workspace",
    workspace: workspaceRoots.primary,
    addDirs: workspaceRoots.additional,
    workspaceRoots: workspaceRoots.all,
    background: Boolean(options.background),
    readOnly: Boolean(options["read-only"]),
    timeoutMs,
    noProgressTimeoutMs,
    longCommandTimeoutMs,
    prompt,
    promptFile,
    artifactDir,
    requiredChecks: options["required-check"] ?? [],
    optionalChecks: options["optional-check"] ?? [],
    agentBin: options["agent-bin"] ?? null,
    resumeJobId: null,
    resumeSessionId: null,
  }
  let modelInfo
  if (options["resume-job"]) {
    const oldJob = reconcileJob(
      request.workspace,
      resolveTargetJob(request.workspace, options["resume-job"]),
    )
    const resume = validateResumeRequest({
      oldJob,
      request,
      explicitModel: options.model,
    })
    request.resumeJobId = oldJob.id
    request.resumeSessionId = resume.cursorSession.id
    modelInfo = {
      model: oldJob.model ?? null,
      source: options.model == null ? "resume" : "cli",
    }
  } else {
    modelInfo = resolveModel(options.model)
  }
  request.model = modelInfo.model
  request.modelSource = modelInfo.source
  return {
    outputJson: Boolean(options.json),
    request,
  }
}

function resolveAgentForRequest(request) {
  if (request.agentValidated && request.agentBin) return request.agentBin
  const available = request.agentBin
    ? { available: true, bin: request.agentBin, detail: "explicit" }
    : getAgentAvailability()
  if (!available.available) throw new Error(available.detail)
  if (request.sandbox === "enabled" && !agentSupportsSandbox(available.bin)) {
    throw new Error("Cursor Agent CLI does not support --sandbox; upgrade Cursor CLI before using sandbox mode")
  }
  return available.bin
}

async function executeSimple(request, logFile) {
  const agentBin = resolveAgentForRequest(request)
  const invocation = resolveAgentInvocation(agentBin)
  const args = [
    ...invocation.prefixArgs,
    ...buildAgentArgs({
      prompt: request.prompt,
      workspace: request.workspace,
      addDirs: request.addDirs,
      model: request.model,
      readOnly: request.readOnly,
      force: !request.readOnly,
      sandbox: request.sandbox,
      streamJson: true,
      resumeSessionId: request.resumeSessionId,
    }),
  ]
  const stream = createCursorStreamCollector({
    expectedSessionId: request.resumeSessionId,
    resumedFromJobId: request.resumeJobId,
    onSession(cursorSession) {
      writeJsonAtomic(request.cursorSessionFile, {
        ...cursorSession,
        capturedAt: nowIso(),
      })
    },
  })
  const result = await runProcess(invocation.command, args, {
    cwd: request.workspace,
    timeoutMs: request.timeoutMs,
    logFile,
    captureStdout: false,
    onStdout: (chunk) => stream.consume(chunk),
  })
  const output = stream.finish()
  const failureCode = result.failureCode ?? output.failureCode
  const exitCode = failureCode && result.exitCode === 0 ? 1 : result.exitCode
  return {
    ...result,
    exitCode,
    stdoutPreview: previewText(output.stdout),
    error: exitCode === 0
      ? null
      : previewText(result.stderr || failureCode || output.stdout),
    failureCode,
    cursorSession: output.cursorSession,
    resumePolicy: output.cursorSession
      ? { allowed: true, blockedReasons: [] }
      : { allowed: false, blockedReasons: ["CURSOR_SESSION_UNAVAILABLE"] },
    usage: output.usage,
    agentBin,
    request: undefined,
  }
}

async function executeE2E(request, logFile) {
  const agentBin = resolveAgentForRequest(request)
  const args = [
    RUNNER_SCRIPT,
    "--workspace",
    request.workspace,
    "--prompt-file",
    request.promptFile,
    "--artifact-dir",
    request.artifactDir,
    "--sandbox",
    request.sandbox,
    "--timeout-ms",
    String(request.timeoutMs),
    "--agent-bin",
    agentBin,
  ]
  for (const directory of request.addDirs) args.push("--add-dir", directory)
  for (const check of request.requiredChecks) args.push("--required-check", check)
  for (const check of request.optionalChecks) args.push("--optional-check", check)
  if (request.noProgressTimeoutMs) {
    args.push("--no-progress-timeout-ms", String(request.noProgressTimeoutMs))
  }
  if (request.longCommandTimeoutMs) {
    args.push("--long-command-timeout-ms", String(request.longCommandTimeoutMs))
  }
  if (request.model) args.push("--model", request.model)
  if (request.resumeSessionId) {
    args.push(
      "--resume-session-id",
      request.resumeSessionId,
      "--resumed-from-job-id",
      request.resumeJobId,
    )
  }

  const result = await runProcess(process.execPath, args, {
    cwd: request.workspace,
    timeoutMs: request.timeoutMs + TERMINATE_GRACE_MS * 2,
    logFile,
  })
  const resultFile = path.join(request.artifactDir, "run-result.json")
  const delegatedResult = readJsonIfPresent(resultFile)
  const cursorSession = delegatedResult?.cursorSession
    ?? readJsonIfPresent(path.join(request.artifactDir, "cursor-session.json"))
  return {
    ...result,
    stdoutPreview: previewText(result.stdout),
    error: result.exitCode === 0 ? null : previewText(result.stderr || result.stdout),
    resultFile: fs.existsSync(resultFile) ? resultFile : null,
    cursorSession: validCursorSessionId(cursorSession?.id)
      ? {
          id: cursorSession.id,
          resumed: Boolean(cursorSession.resumed),
          resumedFromJobId: cursorSession.resumedFromJobId ?? null,
        }
      : null,
    resumePolicy: delegatedResult
      ? resumePolicyFromResult(delegatedResult)
      : validCursorSessionId(cursorSession?.id) && result.timedOut
        ? { allowed: true, blockedReasons: [] }
        : { allowed: false, blockedReasons: ["RESULT_UNAVAILABLE"] },
    agentBin,
    request: undefined,
  }
}

function executeRequest(request, logFile) {
  return request.mode === "e2e" ? executeE2E(request, logFile) : executeSimple(request, logFile)
}

function markCancelled(workspace, job, error = "Cancelled by user") {
  const cursorSession = readCursorSession(job)
  return upsertJob(workspace, {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    error,
    finishedAt: nowIso(),
    cursorSession,
    resumePolicy: cursorSession
      ? (job.resumePolicy ?? { allowed: true, blockedReasons: [] })
      : { allowed: false, blockedReasons: ["CURSOR_SESSION_UNAVAILABLE"] },
    request: undefined,
  })
}

function spawnTaskWorker(job, outputJson) {
  const output = fs.openSync(job.logFile, "a")
  const child = spawn(
    process.execPath,
    [COMPANION_SCRIPT, "task-worker", "--workspace", job.workspace, "--job-id", job.id],
    {
      cwd: job.workspace,
      env: process.env,
      detached: true,
      stdio: ["ignore", output, output],
      windowsHide: true,
    },
  )
  fs.closeSync(output)
  if (!child.pid) throw new Error(`Failed to start task worker for job ${job.id}`)
  const started = upsertJob(job.workspace, {
    ...job,
    phase: "starting",
    pid: child.pid,
  })
  if (job.background) {
    child.once("error", (error) => {
      const current = readJobFile(job.workspace, job.id) ?? started
      if (TERMINAL_STATUSES.has(current.status)) return
      releaseArtifactClaim(current.request?.artifactDir, current.id)
      upsertJob(job.workspace, {
        ...current,
        status: "failed",
        phase: "failed",
        pid: null,
        error: error.message,
        failureCode: "WORKER_START_FAILED",
        finishedAt: nowIso(),
        request: undefined,
      })
    })
    child.unref()
    const payload = {
      ...publicJob(started),
      message: "Cursor task queued for background execution",
    }
    outputResult(outputJson ? payload : renderTaskResult(payload), outputJson)
    return Promise.resolve({ background: true, job: started })
  }

  return new Promise((resolve) => {
    let forceTimer = null
    let settled = false
    const forwardSignal = (signal) => {
      const current = readJobFile(job.workspace, job.id) ?? started
      if (!TERMINAL_STATUSES.has(current.status)) {
        markCancelled(job.workspace, current, `Parent received ${signal}`)
      }
      terminateProcessTree(child.pid)
      forceTimer ??= setTimeout(() => forceTerminateProcessTree(child.pid), TERMINATE_GRACE_MS)
    }
    const handleSigint = () => forwardSignal("SIGINT")
    const handleSigterm = () => forwardSignal("SIGTERM")
    process.once("SIGINT", handleSigint)
    process.once("SIGTERM", handleSigterm)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceTimer)
      process.off("SIGINT", handleSigint)
      process.off("SIGTERM", handleSigterm)
      const latest = readJobFile(job.workspace, job.id) ?? started
      resolve({ background: false, job: reconcileJob(job.workspace, latest) })
    }
    child.once("error", (error) => {
      const current = readJobFile(job.workspace, job.id) ?? started
      releaseArtifactClaim(current.request?.artifactDir, current.id)
      upsertJob(job.workspace, {
        ...current,
        status: "failed",
        phase: "failed",
        pid: null,
        error: error.message,
        failureCode: "WORKER_START_FAILED",
        finishedAt: nowIso(),
        request: undefined,
      })
      finish()
    })
    child.once("close", finish)
  })
}

async function commandTask(argv) {
  const { outputJson, request } = parseTaskRequest(argv)
  request.agentBin = resolveAgentForRequest(request)
  request.agentValidated = true

  const id = generateJobId()
  const logFile = ensureJobLog(request.workspace, id)
  request.cursorSessionFile = path.join(resolveJobsDir(request.workspace), `${id}.cursor-session`)
  const job = upsertJob(request.workspace, {
    id,
    kind: "task",
    mode: request.mode,
    status: "queued",
    phase: "queued",
    workspace: request.workspace,
    workspaceRoots: request.workspaceRoots,
    addDirs: request.addDirs,
    model: request.model,
    modelSource: request.modelSource,
    sandbox: request.sandbox,
    hostAccess: request.hostAccess,
    readOnly: request.readOnly,
    background: request.background,
    logFile,
    resultFile: request.artifactDir ? path.join(request.artifactDir, "run-result.json") : null,
    artifactDir: request.artifactDir,
    cursorSessionFile: request.cursorSessionFile,
    resumedFromJobId: request.resumeJobId,
    createdAt: nowIso(),
    promptPreview: previewText(request.prompt, 500),
    request,
  })
  try {
    claimArtifactDirectory(request.artifactDir, request.workspace, id)
  } catch (error) {
    fs.rmSync(resolveJobFile(request.workspace, id), { force: true })
    fs.rmSync(logFile, { force: true })
    throw error
  }

  let worker
  try {
    worker = await spawnTaskWorker(job, outputJson)
  } catch (error) {
    releaseArtifactClaim(request.artifactDir, id)
    throw error
  }
  if (worker.background) return 0
  const completed = worker.job
  outputResult(outputJson ? completed : renderTaskResult(completed), outputJson)
  if (!outputJson && completed.stdoutPreview) {
    process.stdout.write("\n--- agent stdout ---\n")
    process.stdout.write(`${completed.stdoutPreview}\n`)
  }
  return completed.status === "completed" ? 0 : completed.exitCode || 1
}

async function commandTaskWorker(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["workspace", "job-id"],
  })
  if (positionals.length) throw new Error(`Unexpected task-worker arguments: ${positionals.join(" ")}`)
  const workspace = assertAbsoluteWorkspace(options.workspace)
  if (!options["job-id"]) throw new Error("task-worker requires --job-id")
  const jobId = options["job-id"]
  const jobFile = resolveJobFile(workspace, jobId)
  if (!fs.existsSync(jobFile)) throw new Error(`Stored job ${jobId} does not exist`)
  try {
    const job = readJobFile(workspace, jobId)
    if (!job?.request) throw new Error(`Stored job ${jobId} has no request`)
    try {
      await runTrackedJob(workspace, job.id, () => executeRequest(job.request, job.logFile), {
        pid: process.pid,
      })
    } finally {
      releaseArtifactClaim(job.request.artifactDir, job.id)
    }
    return 0
  } catch (error) {
    const existing = readJobFile(workspace, jobId) ?? {
      id: jobId,
      kind: "task",
      workspace,
      createdAt: nowIso(),
    }
    if (!TERMINAL_STATUSES.has(existing.status)) {
      upsertJob(workspace, {
        ...existing,
        status: "failed",
        phase: "failed",
        pid: null,
        error: error instanceof Error ? error.message : String(error),
        failureCode: "WORKER_START_FAILED",
        finishedAt: nowIso(),
        request: undefined,
      })
    }
    throw error
  }
}

function resolveTargetJob(workspace, reference) {
  const jobs = listJobs(workspace)
  if (!reference) {
    if (!jobs.length) throw new Error("No jobs for this workspace")
    return jobs[0]
  }
  const exact = readJobFile(workspace, reference)
  if (exact) return exact
  const matches = jobs.filter((job) => job.id === reference || job.id.startsWith(reference))
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous job ID: ${reference}` : `Job not found: ${reference}`)
  return matches[0]
}

function reconcileJob(workspace, job) {
  if (
    !["queued", "running"].includes(job.status)
    || !job.pid
    || isProcessAlive(job.pid)
  ) {
    return job
  }
  releaseArtifactClaim(job.request?.artifactDir, job.id)
  const cursorSession = readCursorSession(job)
  return upsertJob(workspace, {
    ...job,
    status: "failed",
    phase: "failed",
    pid: null,
    error: "Task worker exited without writing a terminal result",
    failureCode: "WORKER_EXITED_WITHOUT_RESULT",
    finishedAt: nowIso(),
    cursorSession,
    resumePolicy: cursorSession
      ? { allowed: false, blockedReasons: ["RESULT_UNAVAILABLE"] }
      : { allowed: false, blockedReasons: ["CURSOR_SESSION_UNAVAILABLE"] },
    request: undefined,
  })
}

function parseQuery(argv, booleanOptions = []) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    booleanOptions: ["json", ...booleanOptions],
    valueOptions: ["workspace"],
  })
  if (positionals.length > 1) throw new Error(`Unexpected arguments: ${positionals.slice(1).join(" ")}`)
  return {
    options,
    reference: positionals[0] ?? null,
    workspace: assertAbsoluteWorkspace(options.workspace || process.cwd()),
  }
}

function commandStatus(argv) {
  const { options, reference, workspace } = parseQuery(argv, ["all"])
  if (reference) {
    const job = reconcileJob(workspace, resolveTargetJob(workspace, reference))
    outputResult(options.json ? publicJob(job) : renderTaskResult(job), Boolean(options.json))
    return 0
  }
  const jobs = listJobs(workspace).map((job) => reconcileJob(workspace, job))
  const visible = options.all ? jobs : jobs.slice(0, 8)
  outputResult(
    options.json
      ? { workspace, jobs: visible.map(publicJob), stateDir: resolveStateDir(workspace) }
      : renderStatusReport(visible),
    Boolean(options.json),
  )
  return 0
}

function commandResult(argv) {
  const { options, reference, workspace } = parseQuery(argv)
  const job = reconcileJob(workspace, resolveTargetJob(workspace, reference))
  let result = null
  if (job.resultFile && fs.existsSync(job.resultFile)) {
    result = JSON.parse(fs.readFileSync(job.resultFile, "utf8"))
  } else if (!job.stdoutPreview && job.logFile && fs.existsSync(job.logFile)) {
    job.stdoutPreview = previewText(fs.readFileSync(job.logFile, "utf8"))
  }
  if (options.json) outputResult({ job: publicJob(job), result }, true)
  else {
    process.stdout.write(renderTaskResult(job))
    if (result) {
      const { cursorSession: _cursorSession, ...humanResult } = result
      process.stdout.write(`\n--- result file ---\n${JSON.stringify(humanResult, null, 2)}\n`)
    }
  }
  return job.status === "completed" ? 0 : 1
}

async function commandCancel(argv) {
  const { options, reference, workspace } = parseQuery(argv)
  let job
  if (reference) {
    job = resolveTargetJob(workspace, reference)
  } else {
    const jobs = listJobs(workspace).map((candidate) => reconcileJob(workspace, candidate))
    const active = jobs.filter((candidate) => !TERMINAL_STATUSES.has(candidate.status))
    if (active.length > 1) {
      throw new Error(
        `AMBIGUOUS_ACTIVE_JOBS: ${active.length} jobs are active; pass an explicit job ID`,
      )
    }
    job = active[0] ?? resolveTargetJob(workspace, null)
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    outputResult(options.json ? publicJob(job) : renderCancelReport(job), Boolean(options.json))
    return 0
  }
  let verifiedPid = null
  const artifactDir = job.request?.artifactDir
  if (job.pid) {
    const command = readProcessCommand(job.pid)
    const expected = command.includes(path.basename(COMPANION_SCRIPT))
      && command.includes("task-worker")
      && command.includes(job.id)
    if (!expected) throw new Error(`Refusing to terminate PID ${job.pid}: process identity does not match job ${job.id}`)
    verifiedPid = job.pid
  }
  const cancelled = markCancelled(workspace, job)
  if (verifiedPid) {
    terminateProcessTree(verifiedPid)
    const waitStepMs = 50
    for (
      let waitedMs = 0;
      waitedMs < TERMINATE_GRACE_MS && isProcessAlive(verifiedPid);
      waitedMs += waitStepMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, waitStepMs))
    }
    if (isProcessAlive(verifiedPid)) {
      const command = readProcessCommand(verifiedPid)
      if (
        command.includes(path.basename(COMPANION_SCRIPT))
        && command.includes("task-worker")
        && command.includes(job.id)
      ) {
        forceTerminateProcessTree(verifiedPid)
      }
    }
  }
  releaseArtifactClaim(artifactDir, job.id)
  outputResult(options.json ? publicJob(cancelled) : renderCancelReport(cancelled), Boolean(options.json))
  return 0
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (!command || command === "-h" || command === "--help" || command === "help") {
    printUsage()
    return command ? 0 : 1
  }
  switch (command) {
    case "setup":
      return commandSetup(argv)
    case "task":
      return commandTask(argv)
    case "task-worker":
      return commandTaskWorker(argv)
    case "status":
      return commandStatus(argv)
    case "result":
      return commandResult(argv)
    case "cancel":
      return commandCancel(argv)
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
