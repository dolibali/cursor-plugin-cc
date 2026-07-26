import fs from "node:fs"
import path from "node:path"

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout", "cancelled"])
const RESUME_BLOCKING_REASONS = new Set([
  "PROHIBITED_GIT_STATE_CHANGE",
  "PROHIBITED_GIT_OPERATION",
  "UNSAFE_CHANGED_SYMLINK",
  "RECURSIVE_DELEGATION_REPEATED",
  "RECURSIVE_DELEGATION_TOOL_CALL",
  "PROHIBITED_DETACHED_PROCESS",
  "RESULT_INVALID",
  "REPAIR_STATUS_MISMATCH",
])

function canonicalTargetPath(candidate) {
  const absolute = path.resolve(candidate)
  if (fs.existsSync(absolute)) return fs.realpathSync.native(absolute)
  const suffix = []
  let current = absolute
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current))
    current = path.dirname(current)
  }
  return path.join(fs.realpathSync.native(current), ...suffix)
}

export function validCursorSessionId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value)
}

export function readJsonIfPresent(file) {
  if (!file || !fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function artifactDirectoryForJob(job) {
  return job.artifactDir
    ?? job.request?.artifactDir
    ?? (job.resultFile ? path.dirname(job.resultFile) : null)
}

export function readCursorSession(job) {
  if (validCursorSessionId(job.cursorSession?.id)) return job.cursorSession
  const sessionFile = job.cursorSessionFile ?? job.request?.cursorSessionFile
  const direct = readJsonIfPresent(sessionFile)
  if (validCursorSessionId(direct?.id)) {
    return {
      id: direct.id,
      resumed: Boolean(direct.resumed),
      resumedFromJobId: direct.resumedFromJobId ?? null,
    }
  }
  const artifactDir = artifactDirectoryForJob(job)
  const stored = readJsonIfPresent(artifactDir && path.join(artifactDir, "cursor-session.json"))
  return validCursorSessionId(stored?.id)
    ? {
        id: stored.id,
        resumed: Boolean(stored.resumed),
        resumedFromJobId: stored.resumedFromJobId ?? null,
      }
    : null
}

export function cursorSessionFromInit(event, {
  expectedSessionId = null,
  resumedFromJobId = null,
  currentSession = null,
} = {}) {
  if (event?.type !== "system" || event?.subtype !== "init") return null
  if (!validCursorSessionId(event.session_id)) {
    return {
      cursorSession: null,
      failureCode: expectedSessionId
        ? "CURSOR_SESSION_RESUME_FAILED"
        : "CURSOR_SESSION_CAPTURE_FAILED",
    }
  }
  if (
    (expectedSessionId && event.session_id !== expectedSessionId)
    || (currentSession && currentSession.id !== event.session_id)
  ) {
    return {
      cursorSession: null,
      failureCode: expectedSessionId
        ? "CURSOR_SESSION_RESUME_MISMATCH"
        : "CURSOR_SESSION_CAPTURE_MISMATCH",
    }
  }
  return {
    cursorSession: {
      id: event.session_id,
      resumed: Boolean(expectedSessionId),
      resumedFromJobId,
    },
    failureCode: null,
  }
}

export function createCursorStreamCollector({
  expectedSessionId = null,
  resumedFromJobId = null,
  onSession = () => {},
} = {}) {
  let buffer = ""
  let cursorSession = null
  let stdout = ""
  let usage = null
  let failureCode = null

  const inspectLine = (line) => {
    if (!line.trim() || failureCode) return failureCode
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return null
    }
    const sessionResult = cursorSessionFromInit(event, {
      expectedSessionId,
      resumedFromJobId,
      currentSession: cursorSession,
    })
    if (sessionResult?.failureCode) {
      failureCode = sessionResult.failureCode
      return failureCode
    }
    if (sessionResult?.cursorSession) {
      cursorSession = sessionResult.cursorSession
      onSession(cursorSession)
    }
    if (event.type === "result") {
      if (typeof event.result === "string") stdout = event.result
      if (event.usage && typeof event.usage === "object") usage = event.usage
    }
    return null
  }

  return {
    consume(chunk) {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const failure = inspectLine(line)
        if (failure) return failure
      }
      return null
    },
    finish() {
      if (buffer) inspectLine(buffer)
      if (!cursorSession && !failureCode) {
        failureCode = expectedSessionId
          ? "CURSOR_SESSION_RESUME_FAILED"
          : "CURSOR_SESSION_CAPTURE_FAILED"
      }
      return { cursorSession, stdout, usage, failureCode }
    },
  }
}

export function resumePolicyFromResult(result) {
  if (!result || typeof result !== "object") {
    return { allowed: false, blockedReasons: ["RESULT_UNAVAILABLE"] }
  }
  const blockedReasons = new Set(
    (Array.isArray(result.reasons) ? result.reasons : [])
      .filter((reason) => RESUME_BLOCKING_REASONS.has(reason)),
  )
  if (result.validation?.valid === false) blockedReasons.add("RESULT_INVALID")
  if (result.source?.unsafeChangedSymlinks?.length > 0) blockedReasons.add("UNSAFE_CHANGED_SYMLINK")
  if (result.workspaceGuard?.violations?.length > 0) blockedReasons.add("PROHIBITED_GIT_STATE_CHANGE")
  if (result.workspaceGuard?.blockedAttempts > 0) blockedReasons.add("PROHIBITED_GIT_OPERATION")
  if (result.recursionGuard?.blockedAttempts > 0) blockedReasons.add("RECURSIVE_DELEGATION")
  if (result.executionGuard?.blockedDetachedAttempts > 0) {
    blockedReasons.add("PROHIBITED_DETACHED_PROCESS")
  }
  return {
    allowed: blockedReasons.size === 0,
    blockedReasons: [...blockedReasons],
  }
}

function resolveResumePolicy(job) {
  if (job.resumePolicy && typeof job.resumePolicy.allowed === "boolean") return job.resumePolicy
  const artifactDir = artifactDirectoryForJob(job)
  const result = readJsonIfPresent(artifactDir && path.join(artifactDir, "run-result.json"))
  if (result) return resumePolicyFromResult(result)
  if (job.status === "cancelled" && !job.failureCode) {
    return { allowed: true, blockedReasons: [] }
  }
  return { allowed: false, blockedReasons: ["RESULT_UNAVAILABLE"] }
}

function sameStringSet(left, right) {
  return [...left].sort().join("\0") === [...right].sort().join("\0")
}

export function validateResumeRequest({ oldJob, request, explicitModel }) {
  if (!TERMINAL_STATUSES.has(oldJob.status)) {
    throw new Error(`Resume source job is still active: ${oldJob.id}`)
  }
  if (oldJob.mode !== request.mode) {
    throw new Error(`Resume source mode ${oldJob.mode} does not match --mode ${request.mode}`)
  }
  const cursorSession = readCursorSession(oldJob)
  if (!cursorSession) {
    throw new Error(`Resume source job ${oldJob.id} has no recoverable Cursor session`)
  }
  if (oldJob.workspace !== request.workspace) {
    throw new Error("Resume source workspace does not match --workspace")
  }
  if (!sameStringSet(oldJob.addDirs ?? [], request.addDirs)) {
    throw new Error("Resume source add-dir set does not match the new request")
  }
  if ((oldJob.sandbox ?? "enabled") !== request.sandbox) {
    throw new Error("Resume source sandbox mode does not match the new request")
  }
  if (explicitModel != null && String(explicitModel).trim() !== (oldJob.model ?? "")) {
    throw new Error("Explicit --model conflicts with the resume source job")
  }
  if (oldJob.mode === "simple" && Boolean(oldJob.readOnly) !== request.readOnly) {
    throw new Error("Resume source read-only mode does not match the new request")
  }
  if (oldJob.mode === "simple") {
    return {
      cursorSession,
      policy: { allowed: true, blockedReasons: [] },
    }
  }
  const policy = resolveResumePolicy(oldJob)
  if (!policy.allowed) {
    throw new Error(
      `Resume source job ${oldJob.id} is not safe to resume: ${policy.blockedReasons.join(", ")}`,
    )
  }
  const oldArtifactDir = artifactDirectoryForJob(oldJob)
  if (oldArtifactDir && canonicalTargetPath(oldArtifactDir) === canonicalTargetPath(request.artifactDir)) {
    throw new Error("Resumed E2E task requires a new artifact directory")
  }
  for (const name of ["delegation.json", "run-result.json", "cursor-session.json"]) {
    if (fs.existsSync(path.join(request.artifactDir, name))) {
      throw new Error("Resumed E2E task requires an unused artifact directory")
    }
  }
  return { cursorSession, policy }
}
