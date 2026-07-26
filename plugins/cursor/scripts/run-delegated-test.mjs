#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import {
  access,
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import { cursorSessionFromInit, validCursorSessionId } from "./lib/resume.mjs"
import { isSystemTemporaryPath } from "./lib/system-temp.mjs"

const DEFAULT_MODEL = null // leave unset → Cursor CLI auto
const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_LONG_COMMAND_TIMEOUT_MS = 30 * 60 * 1000
const HEARTBEAT_MS = 30 * 1000
const PROCESS_GUARD_MS = 10 * 1000
const TERMINATE_GRACE_MS = 10 * 1000
const SHELL_FAILURE_LIMIT = 3
const CHECK_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "SKIP"])
const REPAIR_STATUSES = new Set(["NONE", "APPLIED_AND_VERIFIED", "ESCALATION_REQUIRED"])
const MEANINGFUL_PROGRESS_KINDS = new Set([
  "evidence",
  "hypothesis",
  "repair",
  "check-progress",
  "phase-complete",
])
const EXIT_CODES = { PASS: 0, FAIL: 2, BLOCKED: 3, PARTIAL: 4 }

function usage() {
  return `Usage:
  run-delegated-test.mjs --workspace <path> [--add-dir <path>]...
    --prompt-file <path> --artifact-dir <path> [--sandbox enabled|disabled]
    [--required-check <id>]... [--optional-check <id>]...
    [--model <slug>] [--timeout-ms <ms>]
    [--no-progress-timeout-ms <ms>] [--long-command-timeout-ms <ms>]
    [--resume-session-id <id>] [--resumed-from-job-id <job-id>]
    [--agent-bin <path>]`
}

function validateCursorSessionId(value, flag) {
  if (value == null) return null
  const sessionId = String(value).trim()
  if (!validCursorSessionId(sessionId)) {
    throw new Error(`${flag} contains an invalid Cursor session ID`)
  }
  return sessionId
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function parseArgs(argv) {
  const result = {
    workspace: "",
    addDirs: [],
    promptFile: "",
    artifactDir: "",
    model: DEFAULT_MODEL, // null unless --model
    timeoutMs: null,
    noProgressTimeoutMs: null,
    longCommandTimeoutMs: null,
    agentBin: "agent",
    requiredChecks: [],
    optionalChecks: [],
    sandbox: "enabled",
    resumeSessionId: null,
    resumedFromJobId: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${flag}\n${usage()}`)
    switch (flag) {
      case "--workspace":
        result.workspace = value
        break
      case "--add-dir":
        result.addDirs.push(value)
        break
      case "--prompt-file":
        result.promptFile = value
        break
      case "--artifact-dir":
        result.artifactDir = value
        break
      case "--model":
        result.model = value
        break
      case "--timeout-ms":
        result.timeoutMs = parsePositiveInteger(value, flag)
        break
      case "--no-progress-timeout-ms":
        result.noProgressTimeoutMs = parsePositiveInteger(value, flag)
        break
      case "--long-command-timeout-ms":
        result.longCommandTimeoutMs = parsePositiveInteger(value, flag)
        break
      case "--agent-bin":
        result.agentBin = value
        break
      case "--sandbox":
        result.sandbox = value
        break
      case "--required-check":
        result.requiredChecks.push(value)
        break
      case "--optional-check":
        result.optionalChecks.push(value)
        break
      case "--resume-session-id":
        result.resumeSessionId = validateCursorSessionId(value, flag)
        break
      case "--resumed-from-job-id":
        result.resumedFromJobId = String(value).trim()
        break
      default:
        throw new Error(`Unknown argument: ${flag}\n${usage()}`)
    }
    index += 1
  }
  for (const [name, value] of [
    ["--workspace", result.workspace],
    ["--prompt-file", result.promptFile],
    ["--artifact-dir", result.artifactDir],
  ]) {
    if (!value) throw new Error(`${name} is required\n${usage()}`)
  }
  result.requiredChecks = [...new Set(result.requiredChecks)]
  result.optionalChecks = [...new Set(result.optionalChecks)]
  if (result.sandbox !== "enabled" && result.sandbox !== "disabled") {
    throw new Error("--sandbox must be enabled or disabled")
  }
  const overlappingCheck = result.requiredChecks.find((id) => result.optionalChecks.includes(id))
  if (overlappingCheck) throw new Error(`Check cannot be both required and optional: ${overlappingCheck}`)
  if (Boolean(result.resumeSessionId) !== Boolean(result.resumedFromJobId)) {
    throw new Error("--resume-session-id and --resumed-from-job-id must be provided together")
  }
  result.timeoutMs ??= DEFAULT_TIMEOUT_MS
  result.noProgressTimeoutMs ??= DEFAULT_NO_PROGRESS_TIMEOUT_MS
  result.longCommandTimeoutMs ??= DEFAULT_LONG_COMMAND_TIMEOUT_MS
  if (result.timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error("--timeout-ms cannot exceed 3 hours")
  }
  if (result.noProgressTimeoutMs > DEFAULT_NO_PROGRESS_TIMEOUT_MS) {
    throw new Error("--no-progress-timeout-ms cannot exceed 30 minutes")
  }
  if (result.longCommandTimeoutMs > DEFAULT_LONG_COMMAND_TIMEOUT_MS) {
    throw new Error("--long-command-timeout-ms cannot exceed 30 minutes")
  }
  return result
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function nearestExistingPath(target) {
  let current = target
  while (!(await exists(current))) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`No existing parent for ${target}`)
    current = parent
  }
  return current
}

async function findUnsafeChangedSymlinks(workspace, changedPaths) {
  const unsafe = []
  for (const relativePath of changedPaths) {
    const target = path.join(workspace, relativePath)
    let info
    try {
      info = await lstat(target)
    } catch {
      continue
    }
    if (!info.isSymbolicLink()) continue
    try {
      const resolved = await realpath(target)
      if (!isInside(workspace, resolved)) unsafe.push(relativePath)
    } catch {
      unsafe.push(relativePath)
    }
  }
  return unsafe.sort()
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    )
  })
}

async function resolveExecutable(command) {
  if (command.includes(path.sep)) return realpath(path.resolve(command))
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, command)
    if (await exists(candidate)) return realpath(candidate)
  }
  throw new Error(`Executable not found on PATH: ${command}`)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

async function createRecursionGuard(artifactDir) {
  const guardDir = path.join(artifactDir, ".delegation-guard-bin")
  const attemptsPath = path.join(artifactDir, "recursion-attempts.log")
  const detachedAttemptsPath = path.join(artifactDir, "detached-process-attempts.log")
  await mkdir(guardDir, { recursive: true })
  await Promise.all([writeFile(attemptsPath, ""), writeFile(detachedAttemptsPath, "")])
  const script = `#!/bin/sh
printf '%s\\n' "Nested Cursor delegation blocked: delegated workers must execute the task directly." >&2
printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) $0 $*" >> "$CURSOR_RECURSION_ATTEMPT_LOG"
exit 126
`
  for (const name of ["agent", "cursor-agent", "cursor-sdk-agent", "run-delegated-test"]) {
    const target = path.join(guardDir, name)
    await writeFile(target, script)
    await chmod(target, 0o755)
  }
  const detachedScript = `#!/bin/sh
printf '%s\\n' "Detached process launch blocked: delegated workers must keep child processes attached." >&2
printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) $0 $*" >> "$CURSOR_DETACHED_ATTEMPT_LOG"
exit 126
`
  for (const name of ["nohup", "setsid", "systemd-run"]) {
    const target = path.join(guardDir, name)
    await writeFile(target, detachedScript)
    await chmod(target, 0o755)
  }
  if (process.platform === "darwin") {
    const realLaunchctl = await resolveExecutable("launchctl")
    const launchctlScript = `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    submit|bootstrap|load|kickstart)
      printf '%s\\n' "Detached launchctl operation blocked: $argument" >&2
      printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) $0 $*" >> "$CURSOR_DETACHED_ATTEMPT_LOG"
      exit 126
      ;;
  esac
done
exec ${shellQuote(realLaunchctl)} "$@"
`
    const target = path.join(guardDir, "launchctl")
    await writeFile(target, launchctlScript)
    await chmod(target, 0o755)
  }
  return { guardDir, attemptsPath, detachedAttemptsPath }
}

async function createGitGuard(artifactDir, guardDir, realGitBin) {
  const attemptsPath = path.join(artifactDir, "git-guard-attempts.log")
  await writeFile(attemptsPath, "")
  const script = `#!/bin/sh
subcommand=""
skip_next=0
for argument in "$@"; do
  if [ "$skip_next" = "1" ]; then
    skip_next=0
    continue
  fi
  case "$argument" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)
      skip_next=1
      ;;
    -*)
      ;;
    *)
      subcommand="$argument"
      break
      ;;
  esac
done
case "$subcommand" in
  add|am|checkout|cherry-pick|clean|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|update-index|worktree)
    printf '%s\\n' "Destructive Git operation blocked in delegated Worker: git $subcommand" >&2
    printf '%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) git $*" >> "$CURSOR_GIT_GUARD_ATTEMPT_LOG"
    exit 126
    ;;
esac
exec ${shellQuote(realGitBin)} "$@"
`
  const target = path.join(guardDir, "git")
  await writeFile(target, script)
  await chmod(target, 0o755)
  return { attemptsPath, realGitBin }
}

async function recursionAttemptCount(attemptsPath) {
  try {
    return (await readFile(attemptsPath, "utf8")).split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

function taskToolCallPresent(toolCall) {
  return Boolean(
    toolCall
    && typeof toolCall === "object"
    && Object.keys(toolCall).some((key) => key.toLowerCase() === "tasktoolcall"),
  )
}

function shellToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null
  const entry = Object.entries(toolCall).find(([key]) => key.toLowerCase() === "shelltoolcall")
  return entry?.[1] && typeof entry[1] === "object" ? entry[1] : null
}

function isNoExitStatusFailure(shellCall) {
  const error = shellCall?.result?.spawnError?.error
  return typeof error === "string" && /returned no exit status/i.test(error)
}

function prohibitedDetachedCommand(shellCall) {
  const args = shellCall?.args
  if (!args || typeof args !== "object") return null
  const simpleCommands = Array.isArray(args.simpleCommands)
    ? args.simpleCommands.map((command) => String(command).toLowerCase())
    : []
  const command = typeof args.command === "string" ? args.command : ""
  for (const binary of ["nohup", "setsid", "systemd-run"]) {
    if (simpleCommands.includes(binary)) return binary
  }
  if (
    simpleCommands.includes("launchctl")
    && /\blaunchctl\b[\s\S]{0,200}\b(submit|bootstrap|load|kickstart)\b/i.test(command)
  ) {
    return "launchctl"
  }
  if (simpleCommands.includes("disown") || /(?:^|[;&|\n]\s*)disown(?:\s|$)/i.test(command)) {
    return "disown"
  }
  if (simpleCommands.includes("start-process") || /\bStart-Process\b/i.test(command)) {
    return "Start-Process"
  }
  return null
}

async function gitGuardAttemptCount(attemptsPath) {
  try {
    return (await readFile(attemptsPath, "utf8")).split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

async function listProcesses() {
  if (process.platform === "win32") return []
  const result = await runProcess("/bin/ps", ["-axo", "pid=,ppid=,command="])
  if (result.code !== 0) return []
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
}

function descendantProcesses(processes, rootPid) {
  const descendants = []
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.shift()
    for (const candidate of processes) {
      if (candidate.ppid !== parent || descendants.some(({ pid }) => pid === candidate.pid)) continue
      descendants.push(candidate)
      pending.push(candidate.pid)
    }
  }
  return descendants
}

function commandStartsAgent(command, agentPaths) {
  const tokens = command.trim().split(/\s+/).slice(0, 3)
  return agentPaths.some((agentPath) => tokens.includes(agentPath))
}

async function terminatePid(pid) {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    process.kill(pid, 0)
    process.kill(pid, "SIGKILL")
  } catch {
    // The nested process already exited.
  }
}

async function readWorkerProgress(progressFile, state, config, enqueueProgress) {
  let content = ""
  try {
    content = await readFile(progressFile, "utf8")
  } catch {
    return
  }
  const chunks = content.split("\n")
  if (!content.endsWith("\n")) chunks.pop()
  const lines = chunks.filter(Boolean)
  for (const line of lines.slice(state.workerProgressLines)) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      await enqueueProgress({ type: "worker.progress.invalid", line: line.slice(0, 500) })
      continue
    }
    const now = Date.now()
    if (
      event?.type === "meaningful-progress" &&
      MEANINGFUL_PROGRESS_KINDS.has(event.kind) &&
      typeof event.summary === "string" &&
      event.summary.trim()
    ) {
      state.lastMeaningfulProgressAt = now
      await enqueueProgress({
        type: "worker.meaningfulProgress",
        kind: event.kind,
        summary: event.summary.slice(0, 1_000),
      })
      continue
    }
    if (event?.type === "long-command" && event.state === "start" && typeof event.command === "string") {
      const requestedMaxMs = Number.isSafeInteger(event.expectedMaxMs) && event.expectedMaxMs > 0
        ? event.expectedMaxMs
        : config.longCommandTimeoutMs
      state.activeLongCommand = {
        command: event.command.slice(0, 1_000),
        startedAt: now,
        maxMs: Math.min(requestedMaxMs, config.longCommandTimeoutMs),
      }
      await enqueueProgress({ type: "worker.longCommand.start", ...state.activeLongCommand })
      continue
    }
    if (event?.type === "long-command" && event.state === "finish" && state.activeLongCommand) {
      await enqueueProgress({
        type: "worker.longCommand.finish",
        command: state.activeLongCommand.command,
        durationMs: now - state.activeLongCommand.startedAt,
      })
      state.activeLongCommand = null
      state.lastMeaningfulProgressAt = now
    }
  }
  state.workerProgressLines = lines.length
}

async function git(workspace, args, acceptedCodes = [0]) {
  const result = await runProcess("git", ["-C", workspace, ...args])
  if (!acceptedCodes.includes(result.code)) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`)
  }
  return result
}

async function hashPath(target) {
  if (!(await exists(target))) return "missing"
  const info = await lstat(target)
  if (info.isSymbolicLink()) return `symlink:${await realpath(target)}`
  if (!info.isFile()) return `other:${info.mode}`
  const content = await readFile(target)
  return createHash("sha256").update(content).digest("hex")
}

function parsePorcelain(output) {
  const records = []
  const parts = output.split("\0").filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    const status = entry.slice(0, 2)
    const relativePath = entry.slice(3)
    records.push({ status, path: relativePath })
    if (status.includes("R") || status.includes("C")) {
      const originalPath = parts[index + 1]
      if (originalPath) records.push({ status: `${status}:source`, path: originalPath })
      index += 1
    }
  }
  return records
}

async function workspaceFingerprint(workspace) {
  const head = (await git(workspace, ["rev-parse", "HEAD"])).stdout.trim()
  const statusOutput = (await git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout
  const records = []
  for (const record of parsePorcelain(statusOutput)) {
    records.push({
      ...record,
      hash: await hashPath(path.join(workspace, record.path)),
    })
  }
  records.sort((left, right) => `${left.path}:${left.status}`.localeCompare(`${right.path}:${right.status}`))
  const digest = createHash("sha256").update(JSON.stringify({ head, records })).digest("hex")
  return {
    head,
    digest,
    records,
  }
}

async function repositoryGuardState(workspace) {
  const head = (await git(workspace, ["rev-parse", "HEAD"])).stdout.trim()
  const indexPathOutput = (await git(workspace, ["rev-parse", "--git-path", "index"])).stdout.trim()
  const indexPath = path.isAbsolute(indexPathOutput)
    ? indexPathOutput
    : path.resolve(workspace, indexPathOutput)
  const stashResult = await git(workspace, ["rev-parse", "--verify", "refs/stash"], [0, 1, 128])
  return {
    head,
    indexHash: await hashPath(indexPath),
    stash: stashResult.code === 0 ? stashResult.stdout.trim() : null,
  }
}

function repositoryGuardViolations(before, after) {
  const violations = []
  if (before.head !== after.head) violations.push("HEAD_CHANGED")
  if (before.indexHash !== after.indexHash) violations.push("INDEX_CHANGED")
  if (before.stash !== after.stash) violations.push("STASH_CHANGED")
  return violations
}

function snapshotFilter(source) {
  const name = path.basename(source)
  return name !== ".git" && name !== "node_modules"
}

async function snapshotRecordPaths(workspace, relativePaths, destination) {
  await mkdir(destination, { recursive: true })
  for (const relativePath of [...new Set(relativePaths)]) {
    const source = path.join(workspace, relativePath)
    if (!(await exists(source))) continue
    const target = path.join(destination, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, dereference: false, force: true, filter: snapshotFilter })
  }
}

async function materializeCleanBaselines(workspace, beforeRecords, changedPaths, destination) {
  const knownBefore = new Set(beforeRecords.map(({ path: relativePath }) => relativePath))
  for (const relativePath of changedPaths) {
    if (knownBefore.has(relativePath)) continue
    const blob = await git(workspace, ["show", `HEAD:${relativePath}`], [0, 128])
    if (blob.code !== 0) continue
    const target = path.join(destination, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, blob.stdout)
  }
}

async function createRepairPatch(artifactDir, beforeDir, afterDir) {
  const result = await git(artifactDir, [
    "diff",
    "--no-index",
    "--binary",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    beforeDir,
    afterDir,
  ], [0, 1])
  const beforeName = `${path.basename(beforeDir)}/`
  const afterName = `${path.basename(afterDir)}/`
  const patch = result.stdout
    .replaceAll(`a${beforeDir}/`, "a/")
    .replaceAll(`b${afterDir}/`, "b/")
    .replaceAll(`a/${beforeName}`, "a/")
    .replaceAll(`b/${afterName}`, "b/")
  const patchPath = path.join(artifactDir, "attempted-repair.patch")
  if (patch.trim()) await writeFile(patchPath, patch)
  return patch.trim() ? patchPath : null
}

function changedRecordPaths(before, after) {
  const serialize = (record) => `${record.status}\0${record.hash}`
  const beforeMap = new Map(before.map((record) => [record.path, serialize(record)]))
  const afterMap = new Map(after.map((record) => [record.path, serialize(record)]))
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .filter((file) => beforeMap.get(file) !== afterMap.get(file))
    .sort()
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, target)
}

async function validateAgentResult(value, requiredChecks, optionalChecks, artifactDir) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || !Array.isArray(value.checks)) {
    return { valid: false, reason: "agent-result.json is missing schemaVersion 1 or checks[]" }
  }
  if (value.checks.length === 0) return { valid: false, reason: "agent-result.json contains no checks" }
  const checkIds = new Set()
  for (const check of value.checks) {
    if (
      !check ||
      typeof check.id !== "string" ||
      !CHECK_STATUSES.has(check.status) ||
      typeof check.required !== "boolean" ||
      typeof check.evidence !== "string"
    ) {
      return { valid: false, reason: "agent-result.json contains an invalid check" }
    }
    if (checkIds.has(check.id)) return { valid: false, reason: `agent-result.json repeats check id: ${check.id}` }
    checkIds.add(check.id)
  }
  for (const id of requiredChecks) {
    const check = value.checks.find((candidate) => candidate.id === id)
    if (!check) return { valid: false, reason: `agent-result.json omits required check: ${id}` }
    if (!check.required) return { valid: false, reason: `agent-result.json marks required check optional: ${id}` }
  }
  for (const id of optionalChecks) {
    const check = value.checks.find((candidate) => candidate.id === id)
    if (!check) return { valid: false, reason: `agent-result.json omits optional check: ${id}` }
    if (check.required) return { valid: false, reason: `agent-result.json marks optional check required: ${id}` }
  }
  if (
    !value.cleanup ||
    typeof value.cleanup !== "object" ||
    !CHECK_STATUSES.has(value.cleanup.status) ||
    typeof value.cleanup.details !== "string"
  ) {
    return { valid: false, reason: "agent-result.json contains an invalid cleanup status" }
  }
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.blockers)) {
    return { valid: false, reason: "agent-result.json must contain artifacts[] and blockers[]" }
  }
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact.path !== "string" || typeof artifact.kind !== "string") {
      return { valid: false, reason: "agent-result.json contains an invalid artifact" }
    }
    if (!path.isAbsolute(artifact.path)) {
      return { valid: false, reason: `agent artifact path must be absolute: ${artifact.path}` }
    }
    let resolvedArtifact
    try {
      resolvedArtifact = await realpath(artifact.path)
    } catch {
      return { valid: false, reason: `agent artifact does not exist: ${artifact.path}` }
    }
    if (!isInside(artifactDir, resolvedArtifact)) {
      return { valid: false, reason: `agent artifact must be inside artifact directory: ${artifact.path}` }
    }
  }
  if (
    !value.repair ||
    typeof value.repair !== "object" ||
    !REPAIR_STATUSES.has(value.repair.status) ||
    !Array.isArray(value.repair.iterations)
  ) {
    return { valid: false, reason: "agent-result.json contains an invalid repair object" }
  }
  for (const iteration of value.repair.iterations) {
    if (
      !iteration ||
      typeof iteration !== "object" ||
      typeof iteration.evidence !== "string" ||
      typeof iteration.hypothesis !== "string" ||
      !Array.isArray(iteration.changedFiles) ||
      !iteration.changedFiles.every((item) => typeof item === "string") ||
      !Array.isArray(iteration.verification) ||
      !iteration.verification.every((item) => typeof item === "string")
    ) {
      return { valid: false, reason: "agent-result.json contains an invalid repair iteration" }
    }
  }
  if (
    !value.recursionGuard ||
    typeof value.recursionGuard !== "object" ||
    value.recursionGuard.depth !== 1 ||
    !Number.isSafeInteger(value.recursionGuard.blockedAttempts) ||
    value.recursionGuard.blockedAttempts < 0
  ) {
    return { valid: false, reason: "agent-result.json contains an invalid recursionGuard object" }
  }
  if (
    !value.progress ||
    typeof value.progress !== "object" ||
    typeof value.progress.lastMeaningfulProgressAt !== "string" ||
    !Number.isFinite(value.progress.elapsedMs)
  ) {
    return { valid: false, reason: "agent-result.json contains an invalid progress object" }
  }
  if (
    value.repair.status === "ESCALATION_REQUIRED" &&
    (!value.escalation ||
      typeof value.escalation !== "object" ||
      typeof value.escalation.code !== "string" ||
      typeof value.escalation.summary !== "string")
  ) {
    return { valid: false, reason: "escalation result is missing code or summary" }
  }
  return { valid: true }
}

function deriveStatus({
  timedOut,
  sessionFailure,
  exitCode,
  agentResult,
  validation,
  sourceChanges,
  unsafeChangedSymlinks,
  recursionGuard,
  workspaceGuard,
}) {
  const reasons = []
  if (unsafeChangedSymlinks.length > 0) {
    reasons.push("UNSAFE_CHANGED_SYMLINK")
    return { overall: "FAIL", reasons }
  }
  if (workspaceGuard.violations.length > 0) {
    reasons.push("PROHIBITED_GIT_STATE_CHANGE", ...workspaceGuard.violations)
    return { overall: "FAIL", reasons }
  }
  if (sessionFailure) {
    reasons.push(sessionFailure)
    return { overall: "BLOCKED", reasons }
  }
  if (timedOut) {
    reasons.push(timedOut)
    return { overall: "BLOCKED", reasons }
  }
  if (workspaceGuard.blockedAttempts > 0) {
    reasons.push("PROHIBITED_GIT_OPERATION")
    return { overall: "BLOCKED", reasons }
  }
  if (!validation.valid) {
    reasons.push("RESULT_INVALID", validation.reason)
    return { overall: "BLOCKED", reasons }
  }
  const required = agentResult.checks.filter((check) => check.required)
  if (
    sourceChanges.length > 0 &&
    agentResult.repair.status !== "APPLIED_AND_VERIFIED" &&
    required.every((check) => check.status === "PASS")
  ) {
    reasons.push("REPAIR_STATUS_MISMATCH")
    return { overall: "FAIL", reasons }
  }
  if (recursionGuard.blockedAttempts > 1) {
    reasons.push("RECURSIVE_DELEGATION_REPEATED")
    return { overall: "BLOCKED", reasons }
  }
  if (required.some((check) => check.status === "FAIL")) {
    reasons.push("REQUIRED_CHECK_FAILED")
    return { overall: "FAIL", reasons }
  }
  const blocked = required.filter((check) => check.status === "BLOCKED")
  const skipped = required.filter((check) => check.status === "SKIP")
  const passed = required.filter((check) => check.status === "PASS")
  if (blocked.length > 0 && passed.length === 0) {
    reasons.push("REQUIRED_CHECK_BLOCKED")
    return { overall: "BLOCKED", reasons }
  }
  if (blocked.length > 0 || skipped.length > 0) reasons.push("REQUIRED_CHECKS_UNVERIFIED")
  if (exitCode !== 0) reasons.push("AGENT_EXIT_NONZERO")
  if (agentResult.cleanup.status !== "PASS") reasons.push("CLEANUP_INCOMPLETE")
  if (reasons.length > 0) return { overall: "PARTIAL", reasons }
  return { overall: "PASS", reasons }
}

function contractPrompt({
  taskPrompt,
  artifactDir,
  sourceFingerprint,
  requiredChecks,
  optionalChecks,
  workerProgressFile,
  workspaceRoots,
  resumedFromJobId,
}) {
  const required = requiredChecks.length > 0 ? requiredChecks.map((item) => `- ${item}`).join("\n") : "- supplied by task prompt"
  const optional = optionalChecks.length > 0 ? optionalChecks.map((item) => `- ${item}`).join("\n") : "- none"
  const continuation = resumedFromJobId
    ? `This run resumes Cursor context from companion job ${resumedFromJobId}. Re-read the current worktree and treat its on-disk state, current diff, checks, and fresh artifact directory as authoritative. The task prompt below contains only this continuation's incremental instructions.\n\n`
    : ""
  return `${continuation}${taskPrompt.trim()}

---

You are the single autonomous test and repair worker for this run. Follow this generic contract:

1. Test the requested behavior and do not redesign product expectations.
2. You may edit production code, tests, fixtures, and test infrastructure only inside these declared workspaces:
${workspaceRoots.map((root) => `   - ${root}`).join("\n")}
3. Continue diagnosing, repairing, and rerunning from the earliest affected phase while you are making meaningful progress.
4. Do not delegate to another Cursor CLI worker, invoke agent/cursor-agent/Cursor SDK, or run this delegated-test runner.
5. Do not commit, push, reset, checkout, clean, rebase, stash, or edit any undeclared repository.
6. Never weaken an assertion or locator to hide broken product behavior.
7. Clean up only resources created by this delegated run.

Record meaningful progress by appending one JSON object per line to ${workerProgressFile}. Valid events are:
{"type":"meaningful-progress","kind":"evidence|hypothesis|repair|check-progress|phase-complete","summary":"specific new evidence or completed work"}
{"type":"long-command","state":"start","command":"exact command","expectedMaxMs":1800000}
{"type":"long-command","state":"finish"}

Heartbeat, repeated logs, unchanged command retries, unsupported timeout increases, and plans without evidence are not meaningful progress.

Before exiting, atomically write ${path.join(artifactDir, "agent-result.json")} using this exact shape:

{
  "schemaVersion": 1,
  "summary": "short factual summary",
  "checks": [
    {
      "id": "stable-check-id",
      "status": "PASS",
      "required": true,
      "evidence": "observable result or artifact path"
    }
  ],
  "cleanup": {
    "status": "PASS",
    "details": "what suite-owned resources were released, or that none were created"
  },
  "artifacts": [
    {
      "path": "/absolute/path/inside/artifact-directory",
      "kind": "screenshot"
    }
  ],
  "blockers": [],
  "repair": {
    "status": "NONE",
    "iterations": [
      {
        "evidence": "failure evidence",
        "hypothesis": "root cause hypothesis",
        "changedFiles": [],
        "verification": ["command and observable result"]
      }
    ]
  },
  "progress": {
    "lastMeaningfulProgressAt": "ISO-8601 timestamp",
    "elapsedMs": 0
  },
  "recursionGuard": {
    "depth": 1,
    "blockedAttempts": 0
  },
  "escalation": null
}

The only valid check status strings are PASS, FAIL, BLOCKED, and SKIP. cleanup is always an object, even when no cleanup was needed. artifacts and blockers are always arrays. Every artifact entry is an object with string path and kind fields, never a bare path string. Use an empty artifacts array when there are no artifacts to report. repair.status is NONE, APPLIED_AND_VERIFIED, or ESCALATION_REQUIRED. Use APPLIED_AND_VERIFIED only after every required check and the affected baseline checks pass.

Required check IDs:
${required}

Optional check IDs:
${optional}

Report every listed check exactly once and preserve whether it is required or optional.

Invocation source fingerprint: ${sourceFingerprint}
Artifact directory: ${artifactDir}
`
}

async function runAgent({ config, workspace, artifactDir, prompt, environment }) {
  const stdoutPath = path.join(artifactDir, "stdout.log")
  const stderrPath = path.join(artifactDir, "stderr.log")
  const eventsPath = path.join(artifactDir, "events.jsonl")
  const progressPath = path.join(artifactDir, "progress.jsonl")
  const workerProgressPath = path.join(artifactDir, "worker-progress.jsonl")
  const cursorSessionPath = path.join(artifactDir, "cursor-session.json")
  await Promise.all([
    writeFile(stdoutPath, ""),
    writeFile(stderrPath, ""),
    writeFile(eventsPath, ""),
    writeFile(progressPath, ""),
    writeFile(workerProgressPath, ""),
  ])

  const appendProgress = async (event) => {
    await appendFile(progressPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  }
  await appendProgress({ type: "runner.start" })

  const args = [
    "-p",
    "--trust",
    "--force",
    "--sandbox",
    config.sandbox,
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    ...(config.model ? ["--model", config.model] : []),
    ...(config.resumeSessionId ? ["--resume", config.resumeSessionId] : []),
    "--workspace",
    workspace,
  ]
  for (const directory of config.addDirs) args.push("--add-dir", directory)
  args.push(prompt)
  const startedAt = Date.now()
  let lastActivityAt = startedAt
  let closed = false
  let timedOut = null
  let terminationTimer
  let stdoutBuffer = ""
  let lastPhase = ""
  let usage = null
  let cursorSession = null
  let sessionFailure = null
  const autonomousState = {
    lastMeaningfulProgressAt: startedAt,
    workerProgressLines: 0,
    activeLongCommand: null,
    blockedAttempts: 0,
    blockedGitAttempts: 0,
    blockedDetachedAttempts: 0,
    shellFailureCount: 0,
    killedNestedPids: new Set(),
  }
  const writeQueues = new Map([
    [stdoutPath, Promise.resolve()],
    [stderrPath, Promise.resolve()],
    [eventsPath, Promise.resolve()],
  ])
  let progressQueue = Promise.resolve()
  let sessionWriteQueue = Promise.resolve()
  const enqueueWrite = (target, chunk) => {
    const next = writeQueues.get(target).then(() => appendFile(target, chunk))
    writeQueues.set(target, next.catch(() => {}))
  }
  const enqueueProgress = (event) => {
    progressQueue = progressQueue.then(() =>
      appendFile(progressPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`),
    )
    return progressQueue
  }
  let terminate = async () => {}
  const inspectStreamLine = (line) => {
    try {
      const event = JSON.parse(line)
      const sessionResult = cursorSessionFromInit(event, {
        expectedSessionId: config.resumeSessionId,
        resumedFromJobId: config.resumedFromJobId,
        currentSession: cursorSession,
      })
      if (sessionResult?.failureCode) {
        sessionFailure = sessionResult.failureCode
        terminate(sessionFailure).catch(() => {})
        return
      }
      if (sessionResult?.cursorSession) {
        cursorSession = sessionResult.cursorSession
        sessionWriteQueue = sessionWriteQueue.then(() =>
          writeJsonAtomic(cursorSessionPath, {
            ...cursorSession,
            capturedAt: new Date().toISOString(),
          }),
        )
      }
      if (event.type === "result" && event.usage && typeof event.usage === "object") {
        usage = {
          inputTokens: Number(event.usage.inputTokens) || 0,
          outputTokens: Number(event.usage.outputTokens) || 0,
          cacheReadTokens: Number(event.usage.cacheReadTokens) || 0,
          cacheWriteTokens: Number(event.usage.cacheWriteTokens) || 0,
        }
      }
      if (event.type !== "tool_call") return
      const toolCall = event.tool_call
      if (event.subtype === "started" && taskToolCallPresent(toolCall)) {
        autonomousState.blockedAttempts += 1
        enqueueProgress({
          type: "runner.recursionBlocked",
          source: "task-tool-call",
          attempts: autonomousState.blockedAttempts,
        }).catch(() => {})
        terminate("RECURSIVE_DELEGATION_TOOL_CALL").catch(() => {})
        return
      }
      const shellCall = shellToolCall(toolCall)
      if (event.subtype === "completed" && shellCall?.result) {
        if (isNoExitStatusFailure(shellCall)) {
          autonomousState.shellFailureCount += 1
          enqueueProgress({
            type: "runner.shellUnavailable",
            consecutiveFailures: autonomousState.shellFailureCount,
          }).catch(() => {})
          if (autonomousState.shellFailureCount >= SHELL_FAILURE_LIMIT) {
            terminate("WORKER_SHELL_UNAVAILABLE").catch(() => {})
          }
        } else {
          autonomousState.shellFailureCount = 0
        }
      }
      if (event.subtype !== "started") return
      const detachedCommand = prohibitedDetachedCommand(shellCall)
      if (detachedCommand) {
        autonomousState.blockedDetachedAttempts += 1
        enqueueProgress({
          type: "runner.detachedProcessBlocked",
          source: "stream",
          command: detachedCommand,
          attempts: autonomousState.blockedDetachedAttempts,
        }).catch(() => {})
        terminate("PROHIBITED_DETACHED_PROCESS").catch(() => {})
        return
      }
      const nestedToolCall = toolCall && typeof toolCall === "object"
        ? Object.entries(toolCall).find(
            ([key, value]) =>
              key.endsWith("ToolCall") &&
              value &&
              typeof value === "object" &&
              typeof value.description === "string",
          )?.[1]
        : null
      const phase = toolCall?.description ?? nestedToolCall?.description
      if (typeof phase !== "string" || !phase.trim() || phase === lastPhase) return
      lastPhase = phase
      enqueueProgress({ type: "cursor.phase", phase: phase.slice(0, 500) }).catch(() => {})
    } catch {
      // The raw stream is retained even when a line is not valid JSON.
    }
  }

  const child = spawn(config.resolvedAgentBin, args, {
    cwd: workspace,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const handleSigint = () => terminate("PARENT_SIGINT").catch(() => {})
  const handleSigterm = () => terminate("PARENT_SIGTERM").catch(() => {})
  process.once("SIGINT", handleSigint)
  process.once("SIGTERM", handleSigterm)

  terminate = async (reason) => {
    if (closed || timedOut) return
    timedOut = reason
    await enqueueProgress({ type: "runner.terminate", reason })
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
    terminationTimer = setTimeout(() => {
      if (closed) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, TERMINATE_GRACE_MS)
  }

  const record = (targetFiles, chunk) => {
    lastActivityAt = Date.now()
    for (const target of targetFiles) enqueueWrite(target, chunk)
  }
  child.stdout.on("data", (chunk) => {
    record([stdoutPath, eventsPath], chunk)
    stdoutBuffer += chunk.toString("utf8")
    const lines = stdoutBuffer.split("\n")
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) inspectStreamLine(line)
  })
  child.stderr.on("data", (chunk) => record([stderrPath], chunk))

  const heartbeatIntervalMs = Math.min(
    HEARTBEAT_MS,
    Math.max(50, Math.floor(Math.min(config.timeoutMs, config.noProgressTimeoutMs) / 2)),
  )
  const heartbeatMonitor = setInterval(() => {
    const now = Date.now()
    const elapsedMs = now - startedAt
    const idleMs = now - lastActivityAt
    enqueueProgress({
      type: "runner.heartbeat",
      elapsedMs,
      idleMs,
      meaningfulProgressIdleMs: now - autonomousState.lastMeaningfulProgressAt,
    }).catch(() => {})
    if (elapsedMs >= config.timeoutMs) terminate("TOTAL_TIMEOUT").catch(() => {})
  }, heartbeatIntervalMs)

  let guardRunning = false
  const configuredGuardInterval = Number.parseInt(process.env.DELEGATED_TEST_GUARD_INTERVAL_MS ?? "", 10)
  const guardIntervalMs = Number.isSafeInteger(configuredGuardInterval) && configuredGuardInterval > 0
    ? configuredGuardInterval
    : PROCESS_GUARD_MS
  const guardMonitor = setInterval(async () => {
    if (guardRunning || closed || timedOut) return
    guardRunning = true
    try {
      await readWorkerProgress(workerProgressPath, autonomousState, config, enqueueProgress)
      const now = Date.now()
      if (
        autonomousState.activeLongCommand &&
        now - autonomousState.activeLongCommand.startedAt >= autonomousState.activeLongCommand.maxMs
      ) {
        await terminate("LONG_COMMAND_TIMEOUT")
        return
      }
      if (
        !autonomousState.activeLongCommand &&
        now - autonomousState.lastMeaningfulProgressAt >= config.noProgressTimeoutMs
      ) {
        await terminate("NO_MEANINGFUL_PROGRESS")
        return
      }

      const pathAttempts = await recursionAttemptCount(config.recursionGuard.attemptsPath)
      if (pathAttempts > autonomousState.blockedAttempts) {
        autonomousState.blockedAttempts = pathAttempts
        await enqueueProgress({ type: "runner.recursionBlocked", source: "path", attempts: pathAttempts })
      }

      const nestedAgents = descendantProcesses(await listProcesses(), child.pid).filter(
        ({ pid, command }) =>
          !autonomousState.killedNestedPids.has(pid) &&
          commandStartsAgent(command, config.agentIdentityPaths),
      )
      for (const nested of nestedAgents) {
        autonomousState.killedNestedPids.add(nested.pid)
        autonomousState.blockedAttempts += 1
        await enqueueProgress({
          type: "runner.recursionBlocked",
          source: "process-tree",
          pid: nested.pid,
          command: nested.command.slice(0, 1_000),
          attempts: autonomousState.blockedAttempts,
        })
        await terminatePid(nested.pid)
      }
      if (autonomousState.blockedAttempts > 1) await terminate("RECURSIVE_DELEGATION_REPEATED")

      const detachedAttempts = await recursionAttemptCount(
        config.recursionGuard.detachedAttemptsPath,
      )
      if (detachedAttempts > autonomousState.blockedDetachedAttempts) {
        autonomousState.blockedDetachedAttempts = detachedAttempts
        await enqueueProgress({
          type: "runner.detachedProcessBlocked",
          source: "path",
          attempts: detachedAttempts,
        })
        await terminate("PROHIBITED_DETACHED_PROCESS")
        return
      }

      const blockedGitAttempts = await gitGuardAttemptCount(config.workspaceGuard.attemptsPath)
      if (blockedGitAttempts > autonomousState.blockedGitAttempts) {
        autonomousState.blockedGitAttempts = blockedGitAttempts
        await enqueueProgress({
          type: "runner.gitOperationBlocked",
          attempts: blockedGitAttempts,
        })
        await terminate("PROHIBITED_GIT_OPERATION")
      }
    } finally {
      guardRunning = false
    }
  }, Math.max(50, guardIntervalMs))

  const processResult = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: 1, signal: null, error: error.message }))
    child.on("close", (code, signal) => {
      closed = true
      resolve({ code: code ?? 1, signal, error: null })
    })
  })
  clearInterval(heartbeatMonitor)
  clearInterval(guardMonitor)
  clearTimeout(terminationTimer)
  process.off("SIGINT", handleSigint)
  process.off("SIGTERM", handleSigterm)
  if (stdoutBuffer) inspectStreamLine(stdoutBuffer)
  if (!cursorSession && !timedOut) {
    sessionFailure = config.resumeSessionId
      ? "CURSOR_SESSION_RESUME_FAILED"
      : "CURSOR_SESSION_CAPTURE_FAILED"
  }
  await readWorkerProgress(workerProgressPath, autonomousState, config, enqueueProgress)
  autonomousState.blockedAttempts = Math.max(
    autonomousState.blockedAttempts,
    await recursionAttemptCount(config.recursionGuard.attemptsPath),
  )
  autonomousState.blockedDetachedAttempts = Math.max(
    autonomousState.blockedDetachedAttempts,
    await recursionAttemptCount(config.recursionGuard.detachedAttemptsPath),
  )
  autonomousState.blockedGitAttempts = Math.max(
    autonomousState.blockedGitAttempts,
    await gitGuardAttemptCount(config.workspaceGuard.attemptsPath),
  )
  await Promise.all([...writeQueues.values(), sessionWriteQueue])
  await enqueueProgress({
    type: "runner.agentExit",
    code: processResult.code,
    signal: processResult.signal,
    timedOut,
  })
  return {
    ...processResult,
    timedOut,
    durationMs: Date.now() - startedAt,
    stdoutPath,
    stderrPath,
    eventsPath,
    progressPath,
    workerProgressPath,
    progress: {
      lastMeaningfulProgressAt: new Date(autonomousState.lastMeaningfulProgressAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      activeLongCommand: autonomousState.activeLongCommand,
    },
    recursionGuard: {
      depth: 1,
      blockedAttempts: autonomousState.blockedAttempts,
    },
    executionGuard: {
      blockedDetachedAttempts: autonomousState.blockedDetachedAttempts,
      consecutiveShellFailures: autonomousState.shellFailureCount,
    },
    workspaceGuard: {
      blockedAttempts: autonomousState.blockedGitAttempts,
    },
    usage,
    cursorSession,
    sessionFailure,
  }
}

async function normalizeWorkspaceRoots(primary, additional) {
  const roots = []
  for (const candidate of [primary, ...additional]) {
    if (!path.isAbsolute(candidate)) throw new Error(`Workspace path must be absolute: ${candidate}`)
    const workspace = await realpath(path.resolve(candidate))
    if (roots.includes(workspace)) continue
    const workspaceInfo = await stat(workspace)
    if (!workspaceInfo.isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`)
    await git(workspace, ["rev-parse", "--is-inside-work-tree"])
    roots.push(workspace)
  }
  return roots
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  const inheritedDepth = Number.parseInt(process.env.CURSOR_DELEGATION_DEPTH ?? "0", 10)
  if (Number.isFinite(inheritedDepth) && inheritedDepth >= 1) {
    throw new Error("Nested Cursor delegation is not allowed when CURSOR_DELEGATION_DEPTH >= 1")
  }
  const requestedAgentBin = config.agentBin
  config.resolvedAgentBin = await resolveExecutable(requestedAgentBin)
  config.realGitBin = await resolveExecutable("git")
  config.agentIdentityPaths = [...new Set([path.resolve(requestedAgentBin), config.resolvedAgentBin])]
  config.runId = randomUUID()
  const workspaceRoots = await normalizeWorkspaceRoots(config.workspace, config.addDirs)
  const [workspace, ...addDirs] = workspaceRoots
  config.addDirs = addDirs

  const promptFile = await realpath(path.resolve(config.promptFile))
  const taskPrompt = await readFile(promptFile, "utf8")
  const requestedArtifactDir = path.resolve(config.artifactDir)
  const existingArtifactParent = await realpath(await nearestExistingPath(requestedArtifactDir))
  if (!isSystemTemporaryPath(existingArtifactParent)) {
    throw new Error("Artifact directory must be under the system temporary directory")
  }
  if (workspaceRoots.some((root) => existingArtifactParent === root || isInside(root, existingArtifactParent))) {
    throw new Error("Artifact directory must be outside every workspace")
  }
  await mkdir(requestedArtifactDir, { recursive: true })
  const artifactDir = await realpath(requestedArtifactDir)
  if (workspaceRoots.some((root) => artifactDir === root || isInside(root, artifactDir))) {
    throw new Error("Artifact directory must be outside every workspace")
  }
  await Promise.all(
    ["agent-result.json", "run-result.json", "attempted-repair.patch"].map((name) =>
      rm(path.join(artifactDir, name), { force: true }),
    ),
  )
  config.recursionGuard = await createRecursionGuard(artifactDir)
  config.workspaceGuard = await createGitGuard(
    artifactDir,
    config.recursionGuard.guardDir,
    config.realGitBin,
  )

  const beforeSnapshotDir = path.join(artifactDir, ".source-before")
  const afterSnapshotDir = path.join(artifactDir, ".source-after")
  await rm(beforeSnapshotDir, { recursive: true, force: true })
  await rm(afterSnapshotDir, { recursive: true, force: true })
  const beforeWorkspaces = await Promise.all(
    workspaceRoots.map(async (root, index) => {
      const fingerprint = await workspaceFingerprint(root)
      const repository = await repositoryGuardState(root)
      await snapshotRecordPaths(
        root,
        fingerprint.records.map(({ path: relativePath }) => relativePath),
        path.join(beforeSnapshotDir, `root-${index}`),
      )
      return { workspace: root, fingerprint, repository }
    }),
  )
  const before = beforeWorkspaces[0].fingerprint
  const repositoryGuardBefore = beforeWorkspaces[0].repository
  const combinedSourceFingerprint = createHash("sha256")
    .update(JSON.stringify(beforeWorkspaces.map(({ workspace: root, fingerprint }) => [root, fingerprint.digest])))
    .digest("hex")

  const delegation = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    workspace,
    workspaceRoots,
    sandbox: config.sandbox,
    hostAccess: config.sandbox === "disabled" ? "unrestricted" : "workspace",
    filesystemBoundaryVerified: config.sandbox === "enabled",
    promptFile,
    artifactDir,
    runId: config.runId,
    model: config.model,
    timeoutMs: config.timeoutMs,
    noProgressTimeoutMs: config.noProgressTimeoutMs,
    longCommandTimeoutMs: config.longCommandTimeoutMs,
    processGuardMs: PROCESS_GUARD_MS,
    requiredChecks: config.requiredChecks,
    optionalChecks: config.optionalChecks,
    cursorSession: config.resumeSessionId
      ? {
          resumed: true,
          resumedFromJobId: config.resumedFromJobId,
        }
      : {
          resumed: false,
          resumedFromJobId: null,
        },
    source: before,
    sources: beforeWorkspaces,
    workspaceGuard: {
      repository: repositoryGuardBefore,
      blockedAttempts: 0,
    },
  }
  await writeJsonAtomic(path.join(artifactDir, "delegation.json"), delegation)

  const prompt = contractPrompt({
    taskPrompt,
    artifactDir,
    sourceFingerprint: combinedSourceFingerprint,
    requiredChecks: config.requiredChecks,
    optionalChecks: config.optionalChecks,
    workerProgressFile: path.join(artifactDir, "worker-progress.jsonl"),
    workspaceRoots,
    resumedFromJobId: config.resumedFromJobId,
  })
  const processResult = await runAgent({
    config,
    workspace,
    artifactDir,
    prompt,
    environment: {
      ...process.env,
      DELEGATED_TEST_ARTIFACT_DIR: artifactDir,
      DELEGATED_TEST_WORKSPACE: workspace,
      DELEGATED_TEST_WORKSPACES: JSON.stringify(workspaceRoots),
      DELEGATED_TEST_PROGRESS_FILE: path.join(artifactDir, "worker-progress.jsonl"),
      CURSOR_DELEGATED_WORKER: "1",
      CURSOR_DELEGATION_DEPTH: "1",
      CURSOR_DELEGATION_RUN_ID: config.runId,
      CURSOR_RECURSION_ATTEMPT_LOG: config.recursionGuard.attemptsPath,
      CURSOR_DETACHED_ATTEMPT_LOG: config.recursionGuard.detachedAttemptsPath,
      CURSOR_GIT_GUARD_ATTEMPT_LOG: config.workspaceGuard.attemptsPath,
      PATH: `${config.recursionGuard.guardDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  })

  const afterWorkspaces = await Promise.all(
    workspaceRoots.map(async (root) => ({
      workspace: root,
      fingerprint: await workspaceFingerprint(root),
      repository: await repositoryGuardState(root),
    })),
  )
  const after = afterWorkspaces[0].fingerprint
  const repositoryGuardAfter = afterWorkspaces[0].repository
  const guardedWorkspaces = beforeWorkspaces.map((entry, index) => {
    const next = afterWorkspaces[index]
    const violations = repositoryGuardViolations(entry.repository, next.repository)
    return {
      workspace: entry.workspace,
      before: entry.repository,
      after: next.repository,
      violations,
    }
  })
  const workspaceGuard = {
    blockedAttempts: processResult.workspaceGuard.blockedAttempts,
    before: repositoryGuardBefore,
    after: repositoryGuardAfter,
    workspaces: guardedWorkspaces,
    violations: guardedWorkspaces.flatMap(({ workspace: root, violations }, index) =>
      violations.map((violation) => index === 0 ? violation : `${root}:${violation}`),
    ),
  }
  const sourceWorkspaces = []
  for (let index = 0; index < beforeWorkspaces.length; index += 1) {
    const previous = beforeWorkspaces[index]
    const next = afterWorkspaces[index]
    const changes = changedRecordPaths(previous.fingerprint.records, next.fingerprint.records)
    const unsafeChangedSymlinks = await findUnsafeChangedSymlinks(previous.workspace, changes)
    const beforeRoot = path.join(beforeSnapshotDir, `root-${index}`)
    const afterRoot = path.join(afterSnapshotDir, `root-${index}`)
    await materializeCleanBaselines(previous.workspace, previous.fingerprint.records, changes, beforeRoot)
    await snapshotRecordPaths(previous.workspace, changes, afterRoot)
    sourceWorkspaces.push({
      workspace: previous.workspace,
      before: previous.fingerprint,
      after: next.fingerprint,
      changes,
      unsafeChangedSymlinks,
    })
  }
  const sourceChanges = sourceWorkspaces.flatMap(({ workspace: root, changes }) =>
    changes.map((relativePath) => ({ workspace: root, path: relativePath })),
  )
  const unsafeChangedSymlinks = sourceWorkspaces.flatMap(({ workspace: root, unsafeChangedSymlinks: paths }) =>
    paths.map((relativePath) => ({ workspace: root, path: relativePath })),
  )
  const repairPatch = sourceChanges.length > 0
    ? await createRepairPatch(artifactDir, beforeSnapshotDir, afterSnapshotDir)
    : null

  let agentResult = null
  let parseError = null
  try {
    agentResult = JSON.parse(await readFile(path.join(artifactDir, "agent-result.json"), "utf8"))
  } catch (error) {
    parseError = error.message
  }
  const validation = agentResult
    ? await validateAgentResult(agentResult, config.requiredChecks, config.optionalChecks, artifactDir)
    : { valid: false, reason: `agent-result.json unavailable: ${parseError}` }
  const derived = deriveStatus({
    timedOut: processResult.timedOut,
    sessionFailure: processResult.sessionFailure,
    exitCode: processResult.code,
    agentResult,
    validation,
    sourceChanges,
    unsafeChangedSymlinks,
    recursionGuard: processResult.recursionGuard,
    workspaceGuard,
  })
  const repair = {
    status:
      agentResult?.repair?.status ??
      (derived.overall === "PASS" && sourceChanges.length > 0 ? "APPLIED_AND_VERIFIED" : "ESCALATION_REQUIRED"),
    iterations: agentResult?.repair?.iterations ?? [],
    changedFiles: sourceChanges,
    patch: repairPatch,
  }
  const result = {
    schemaVersion: 1,
    overall: derived.overall,
    reasons: derived.reasons,
    finishedAt: new Date().toISOString(),
    durationMs: processResult.durationMs,
    process: {
      exitCode: processResult.code,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
    },
    usage: processResult.usage,
    cursorSession: processResult.cursorSession,
    source: {
      before,
      after,
      changes: sourceChanges,
      unsafeChangedSymlinks,
      workspaces: sourceWorkspaces,
    },
    workspaceRoots,
    sandbox: config.sandbox,
    hostAccess: config.sandbox === "disabled" ? "unrestricted" : "workspace",
    filesystemBoundaryVerified: config.sandbox === "enabled",
    attemptedRepairPatch: repairPatch,
    repair,
    progress: processResult.progress,
    recursionGuard: processResult.recursionGuard,
    executionGuard: processResult.executionGuard,
    workspaceGuard,
    escalation:
      agentResult?.escalation ??
      (processResult.timedOut
        ? {
            code: processResult.timedOut,
            summary: "The autonomous worker stopped at a configured execution boundary.",
          }
        : workspaceGuard.violations.length > 0
          ? {
              code: "PROHIBITED_GIT_STATE_CHANGE",
              summary: `The delegated Worker changed protected Git metadata: ${workspaceGuard.violations.join(", ")}.`,
            }
          : null),
    agentResult,
    validation,
    logs: {
      stdout: processResult.stdoutPath,
      stderr: processResult.stderrPath,
      events: processResult.eventsPath,
      progress: processResult.progressPath,
      workerProgress: processResult.workerProgressPath,
    },
  }
  await writeJsonAtomic(path.join(artifactDir, "run-result.json"), result)
  await rm(beforeSnapshotDir, { recursive: true, force: true })
  await rm(afterSnapshotDir, { recursive: true, force: true })
  process.stdout.write(`[delegated-test] ${derived.overall} ${derived.reasons.join(",") || "all required checks passed"}\n`)
  process.exitCode = EXIT_CODES[derived.overall]
}

main().catch((error) => {
  process.stderr.write(`[delegated-test] ${error.stack || error.message}\n`)
  process.exitCode = 1
})
