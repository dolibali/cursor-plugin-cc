import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { writeJobFile } from "../plugins/cursor/scripts/lib/state.mjs"

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const COMPANION = path.join(ROOT, "plugins", "cursor", "scripts", "cursor-companion.mjs")
const FAKE_AGENT = path.join(ROOT, "tests", "fake-agent.mjs")
const FAKE_DELEGATED_AGENT = path.join(ROOT, "tests", "fake-agent-delegated.mjs")
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-home-"))

function testEnvironment(home, env = {}) {
  const { CURSOR_COMPANION_TIMEOUT_MS: _ignoredTimeout, ...baseEnvironment } = process.env
  return {
    ...baseEnvironment,
    HOME: home,
    ...env,
    CURSOR_COMPANION_AGENT_BIN: FAKE_AGENT,
  }
}

function runWithHome(args, home, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    env: testEnvironment(home, env),
  })
}

function run(args, env = {}) {
  return runWithHome(args, TEST_HOME, env)
}

function runAsync(args, env = {}) {
  const child = spawn(process.execPath, [COMPANION, ...args], {
    env: testEnvironment(TEST_HOME, env),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  return {
    child,
    completed: new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ status: code, signal, stdout, stderr }))
    }),
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForJob(workspace, jobId, expectedStatuses, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = run(["status", jobId, "--workspace", workspace, "--json"])
    assert.equal(status.status, 0, status.stderr)
    const job = JSON.parse(status.stdout)
    if (expectedStatuses.includes(job.status)) return job
    wait(50)
  }
  assert.fail(`job ${jobId} did not reach ${expectedStatuses.join(" or ")}`)
}

function createGitWorkspace(parent, name) {
  const workspace = path.join(parent, name)
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "src", "product.ts"), "export const value = 1\n")
  for (const args of [
    ["init"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test User"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  return workspace
}

function writeResumeSourceJob(workspace, overrides = {}) {
  const canonicalWorkspace = fs.realpathSync(workspace)
  const artifactDir = overrides.artifactDir ?? fs.mkdtempSync(
    path.join(os.tmpdir(), "cursor-companion-resume-source-"),
  )
  const job = {
    id: overrides.id ?? "resume-source-job",
    kind: "task",
    mode: "e2e",
    status: "completed",
    workspace: canonicalWorkspace,
    workspaceRoots: [canonicalWorkspace],
    addDirs: [],
    model: null,
    modelSource: "unset",
    sandbox: "enabled",
    hostAccess: "workspace",
    artifactDir,
    resultFile: path.join(artifactDir, "run-result.json"),
    cursorSession: {
      id: "fake-resumable-session",
      resumed: false,
      resumedFromJobId: null,
    },
    resumePolicy: { allowed: true, blockedReasons: [] },
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  }
  const originalHome = process.env.HOME
  process.env.HOME = TEST_HOME
  try {
    writeJobFile(canonicalWorkspace, job)
  } finally {
    process.env.HOME = originalHome
  }
  return job
}

test("setup --json reports compact agent status and one-hour defaults", () => {
  const result = run(["setup", "--json"])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.agent.available, true)
  assert.equal(payload.agent.detail, "ok")
  assert.equal(payload.auth.detail, "ok")
  assert.doesNotMatch(result.stdout, /Usage: fake-agent/)
  assert.doesNotMatch(result.stdout, /fake-user/)
  assert.deepEqual(payload.model, { model: "auto", source: "default" })
  assert.deepEqual(payload.timeout, {
    timeoutMs: 60 * 60 * 1_000,
    source: "default",
  })
})

test("global timeout setup preserves config and task precedence is cli, env, config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-timeout-home-"))
  const configFile = path.join(home, ".cursor", "cursor-companion", "config.json")
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, `${JSON.stringify({ custom: "preserved" }, null, 2)}\n`)

  const configured = runWithHome(["setup", "--set-timeout-ms", "14400000", "--json"], home)
  assert.equal(configured.status, 0, configured.stderr)
  assert.deepEqual(JSON.parse(configured.stdout).timeout, {
    timeoutMs: 14_400_000,
    source: "config",
  })
  assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).custom, "preserved")

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-timeout-ws-"))
  const fromConfig = runWithHome(["task", "--workspace", workspace, "--json", "--", "config"], home)
  assert.equal(fromConfig.status, 0, fromConfig.stderr)
  assert.equal(JSON.parse(fromConfig.stdout).timeoutMs, 14_400_000)
  assert.equal(JSON.parse(fromConfig.stdout).timeoutSource, "config")

  const fromEnvironment = runWithHome(
    ["task", "--workspace", workspace, "--json", "--", "environment"],
    home,
    { CURSOR_COMPANION_TIMEOUT_MS: "12000" },
  )
  assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr)
  assert.equal(JSON.parse(fromEnvironment.stdout).timeoutMs, 12_000)
  assert.equal(JSON.parse(fromEnvironment.stdout).timeoutSource, "env")

  const fromCli = runWithHome(
    ["task", "--workspace", workspace, "--timeout-ms", "9000", "--json", "--", "cli"],
    home,
    { CURSOR_COMPANION_TIMEOUT_MS: "12000" },
  )
  assert.equal(fromCli.status, 0, fromCli.stderr)
  assert.equal(JSON.parse(fromCli.stdout).timeoutMs, 9_000)
  assert.equal(JSON.parse(fromCli.stdout).timeoutSource, "cli")

  const reset = runWithHome(["setup", "--set-timeout-ms", "-", "--json"], home)
  assert.equal(reset.status, 0, reset.stderr)
  assert.equal(JSON.parse(reset.stdout).timeout.source, "default")
  const resetConfig = JSON.parse(fs.readFileSync(configFile, "utf8"))
  assert.equal("timeoutMs" in resetConfig, false)
  assert.equal(resetConfig.custom, "preserved")
})

test("invalid global timeout does not mutate config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-invalid-timeout-home-"))
  const configFile = path.join(home, ".cursor", "cursor-companion", "config.json")
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const original = `${JSON.stringify({ custom: true }, null, 2)}\n`
  fs.writeFileSync(configFile, original)

  const result = runWithHome(["setup", "--set-timeout-ms", "0", "--json"], home)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /positive safe integer/)
  assert.equal(fs.readFileSync(configFile, "utf8"), original)
})

test("task rejects home workspace", () => {
  const result = run(["task", "--workspace", TEST_HOME, "--", "hello"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /home directory/i)
})

test("task foreground with fake agent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const argsLog = path.join(os.tmpdir(), `cursor-companion-default-model-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(path.join(workspace, "README.md"), "x\n")
  const result = run(
    ["task", "--workspace", workspace, "--json", "--", "fix the readme note"],
    { FAKE_AGENT_ARGV_LOG: argsLog },
  )
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const job = JSON.parse(result.stdout)
  assert.equal(job.status, "completed")
  assert.equal(job.model, "auto")
  assert.equal(job.modelSource, "default")
  const agentArgs = JSON.parse(fs.readFileSync(argsLog, "utf8"))
  assert.deepEqual(agentArgs.slice(agentArgs.indexOf("--model"), agentArgs.indexOf("--model") + 2), [
    "--model",
    "auto",
  ])
  assert.match(job.stdoutPreview || "", /FAKE_AGENT_OK/)
  assert.equal(job.cursorSession.id, "fake-simple-session")
})

test("simple task reaches the configured companion deadline", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-timeout-ws-"))
  const result = run(
    ["task", "--workspace", workspace, "--timeout-ms", "150", "--json", "--", "time out"],
    { FAKE_AGENT_MODE: "medium" },
  )
  assert.notEqual(result.status, 0)
  const job = JSON.parse(result.stdout)
  assert.equal(job.status, "timeout")
  assert.equal(job.timedOut, true)
  assert.equal(job.timeoutMs, 150)
  assert.equal(job.timeoutSource, "cli")
})

test("resumes a simple task in the same Cursor session with a new companion job", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-simple-resume-"))
  const first = run([
    "task",
    "--workspace",
    workspace,
    "--model",
    "cursor-test-model",
    "--json",
    "--",
    "remember the first request",
  ], { FAKE_CURSOR_SESSION_ID: "simple-resume-session" })
  assert.equal(first.status, 0, first.stderr + first.stdout)
  const firstJob = JSON.parse(first.stdout)
  const argsLog = path.join(os.tmpdir(), `cursor-simple-resume-${process.pid}-${Date.now()}.json`)

  const second = run([
    "task",
    "--workspace",
    workspace,
    "--resume-job",
    firstJob.id.slice(0, 12),
    "--timeout-ms",
    "7000",
    "--json",
    "--",
    "continue with the follow-up",
  ], { FAKE_AGENT_ARGV_LOG: argsLog })
  assert.equal(second.status, 0, second.stderr + second.stdout)
  const secondJob = JSON.parse(second.stdout)
  const agentArgs = JSON.parse(fs.readFileSync(argsLog, "utf8"))
  assert.notEqual(secondJob.id, firstJob.id)
  assert.equal(secondJob.resumedFromJobId, firstJob.id)
  assert.equal(secondJob.model, "cursor-test-model")
  assert.equal(secondJob.modelSource, "resume")
  assert.equal(secondJob.timeoutMs, 7_000)
  assert.equal(secondJob.timeoutSource, "cli")
  assert.deepEqual(secondJob.cursorSession, {
    id: "simple-resume-session",
    resumed: true,
    resumedFromJobId: firstJob.id,
  })
  assert.deepEqual(agentArgs.slice(agentArgs.indexOf("--resume"), agentArgs.indexOf("--resume") + 2), [
    "--resume",
    "simple-resume-session",
  ])
})

test("simple resume fails closed on a session mismatch", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-simple-mismatch-"))
  const first = run([
    "task",
    "--workspace",
    workspace,
    "--json",
    "--",
    "capture the initial session",
  ], { FAKE_CURSOR_SESSION_ID: "expected-simple-session" })
  assert.equal(first.status, 0, first.stderr + first.stdout)
  const firstJob = JSON.parse(first.stdout)

  const resumed = run([
    "task",
    "--workspace",
    workspace,
    "--resume-job",
    firstJob.id,
    "--json",
    "--",
    "continue",
  ], { FAKE_AGENT_MODE: "resume-mismatch" })
  assert.notEqual(resumed.status, 0)
  const resumedJob = JSON.parse(resumed.stdout)
  assert.equal(resumedJob.status, "failed")
  assert.equal(resumedJob.failureCode, "CURSOR_SESSION_RESUME_MISMATCH")
  assert.equal(resumedJob.cursorSession, null)
})

test("model cli override wins", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const result = run([
    "task",
    "--workspace",
    workspace,
    "--model",
    "cursor-grok-4.5-high-fast",
    "--json",
    "--",
    "hi",
  ])
  assert.equal(result.status, 0, result.stderr)
  const job = JSON.parse(result.stdout)
  assert.equal(job.model, "cursor-grok-4.5-high-fast")
  assert.equal(job.modelSource, "cli")
})

test("status lists jobs", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  run(["task", "--workspace", workspace, "--json", "--", "one"])
  const status = run(["status", "--workspace", workspace, "--json"])
  assert.equal(status.status, 0, status.stderr)
  const payload = JSON.parse(status.stdout)
  assert.ok(payload.jobs.length >= 1)
})

test("task defaults workspace to cwd when omitted", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  fs.writeFileSync(path.join(workspace, "README.md"), "x\n")
  const result = spawnSync(process.execPath, [COMPANION, "task", "--json", "--", "default cwd task"], {
    encoding: "utf8",
    cwd: workspace,
    env: { ...process.env, HOME: TEST_HOME, CURSOR_COMPANION_AGENT_BIN: FAKE_AGENT },
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const job = JSON.parse(result.stdout)
  assert.equal(job.status, "completed")
  assert.equal(fs.realpathSync(job.workspace), fs.realpathSync(workspace))
})

test("rejects unknown options before creating a job", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const result = run(["task", "--workspacee", workspace, "--", "hello"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown option: --workspacee/)
  const status = run(["status", "--workspace", workspace, "--json"])
  assert.deepEqual(JSON.parse(status.stdout).jobs, [])
})

test("forwards canonical multi-workspace roots and explicit sandbox mode", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const additional = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-add-"))
  const argsLog = path.join(os.tmpdir(), `cursor-companion-args-${process.pid}-${Date.now()}.json`)
  const result = run([
    "task",
    "--workspace",
    workspace,
    "--add-dir",
    additional,
    "--add-dir",
    additional,
    "--sandbox",
    "disabled",
    "--json",
    "--",
    "cross repository task",
  ], { FAKE_AGENT_ARGV_LOG: argsLog })
  assert.equal(result.status, 0, result.stderr)
  const job = JSON.parse(result.stdout)
  assert.deepEqual(job.workspaceRoots, [fs.realpathSync(workspace), fs.realpathSync(additional)])
  assert.equal(job.hostAccess, "unrestricted")
  const agentArgs = JSON.parse(fs.readFileSync(argsLog, "utf8"))
  assert.deepEqual(agentArgs.slice(agentArgs.indexOf("--sandbox"), agentArgs.indexOf("--sandbox") + 2), [
    "--sandbox",
    "disabled",
  ])
  assert.equal(agentArgs.filter((value) => value === "--add-dir").length, 1)
})

test("sandbox mode fails closed when Cursor CLI lacks support", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const result = run(
    ["task", "--workspace", workspace, "--json", "--", "hello"],
    { FAKE_AGENT_NO_SANDBOX: "1" },
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not support --sandbox/)
  const status = run(["status", "--workspace", workspace, "--json"])
  assert.deepEqual(JSON.parse(status.stdout).jobs, [])
})

test("rejects ignored E2E-only options and invalid timeout before creating a job", () => {
  for (const extraArgs of [
    ["--required-check", "fake-check"],
    ["--no-progress-timeout-ms", "1000"],
    ["--timeout-ms", String(Number.MAX_SAFE_INTEGER + 1)],
  ]) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
    const result = run([
      "task",
      "--workspace",
      workspace,
      ...extraArgs,
      "--",
      "hello",
    ])
    assert.notEqual(result.status, 0)
    const status = run(["status", "--workspace", workspace, "--json"])
    assert.deepEqual(JSON.parse(status.stdout).jobs, [])
  }
})

test("rejects invalid E2E artifact boundaries before creating a job", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-e2e-invalid-"))
  const workspace = createGitWorkspace(root, "workspace")
  const promptFile = path.join(root, "prompt.md")
  fs.writeFileSync(promptFile, "test\n")
  const result = run([
    "task",
    "--workspace",
    workspace,
    "--mode",
    "e2e",
    "--prompt-file",
    promptFile,
    "--artifact-dir",
    path.join(workspace, "artifacts"),
    "--required-check",
    "fake-check",
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /outside every workspace/)
  const status = run(["status", "--workspace", workspace, "--json"])
  assert.deepEqual(JSON.parse(status.stdout).jobs, [])
})

test("accepts the POSIX /tmp system temporary root for E2E artifacts", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-e2e-posix-tmp-"))
  const workspace = createGitWorkspace(root, "workspace")
  const promptFile = path.join(root, "prompt.md")
  const artifactRoot = fs.mkdtempSync("/tmp/cursor-companion-e2e-artifacts-")
  const artifactDir = path.join(artifactRoot, "artifacts")
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(artifactRoot, { recursive: true, force: true })
  })
  fs.writeFileSync(promptFile, "Run the deterministic fake validation.\n")
  const result = run([
    "task",
    "--workspace",
    workspace,
    "--mode",
    "e2e",
    "--prompt-file",
    promptFile,
    "--artifact-dir",
    artifactDir,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--json",
  ], { FAKE_AGENT_MODE: "pass" })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(JSON.parse(result.stdout).status, "completed")
})

test("background jobs write a terminal result that status and result can read", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const queued = run([
    "task",
    "--workspace",
    workspace,
    "--background",
    "--json",
    "--",
    "background task",
  ], { FAKE_AGENT_MODE: "slow" })
  assert.equal(queued.status, 0, queued.stderr)
  const jobId = JSON.parse(queued.stdout).id
  const job = waitForJob(workspace, jobId, ["completed"])
  assert.equal(job.status, "completed")
  assert.equal(job.pid, null)
  assert.equal(job.timeoutMs, 60 * 60 * 1_000)
  assert.equal(job.timeoutSource, "default")
  assert.equal("request" in job, false)
  const result = run(["result", jobId, "--workspace", workspace, "--json"])
  assert.equal(result.status, 0, result.stderr)
  const resultJob = JSON.parse(result.stdout).job
  assert.equal(resultJob.status, "completed")
  assert.match(resultJob.stdoutPreview, /FAKE_AGENT_OK/)
  assert.doesNotMatch(resultJob.stdoutPreview, /"type":"system"/)
})

test("background failures reach a stable failed terminal state", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const queued = run([
    "task",
    "--workspace",
    workspace,
    "--background",
    "--json",
    "--",
    "background failure",
  ], { FAKE_AGENT_MODE: "fail" })
  assert.equal(queued.status, 0, queued.stderr)
  const queuedJob = JSON.parse(queued.stdout)
  assert.equal("request" in queuedJob, false)
  const job = waitForJob(workspace, queuedJob.id, ["failed"])
  assert.equal(job.exitCode, 2)
  assert.equal(job.pid, null)
})

test("worker startup failures replace queued state with a failed terminal result", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const jobId = "worker-start-failure"
  const originalHome = process.env.HOME
  process.env.HOME = TEST_HOME
  try {
    writeJobFile(workspace, {
      id: jobId,
      kind: "task",
      workspace,
      background: true,
      status: "queued",
      phase: "queued",
      createdAt: new Date().toISOString(),
    })
  } finally {
    process.env.HOME = originalHome
  }
  const worker = run([
    "task-worker",
    "--workspace",
    workspace,
    "--job-id",
    jobId,
  ])
  assert.notEqual(worker.status, 0)
  const job = waitForJob(workspace, jobId, ["failed"])
  assert.equal(job.failureCode, "WORKER_START_FAILED")
  assert.equal(job.pid, null)
})

test("cancel terminates the background worker and active Cursor process tree", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const pidFile = path.join(os.tmpdir(), `cursor-companion-agent-${process.pid}-${Date.now()}.pid`)
  const queued = run([
    "task",
    "--workspace",
    workspace,
    "--background",
    "--json",
    "--",
    "long background task",
  ], { FAKE_AGENT_MODE: "very-slow", FAKE_AGENT_PID_FILE: pidFile })
  assert.equal(queued.status, 0, queued.stderr)
  const jobId = JSON.parse(queued.stdout).id
  const running = waitForJob(workspace, jobId, ["running"])
  assert.ok(running.pid)
  for (let attempt = 0; attempt < 40 && !fs.existsSync(pidFile); attempt += 1) wait(25)
  assert.equal(fs.existsSync(pidFile), true)
  const agentPid = Number(fs.readFileSync(pidFile, "utf8").trim())
  assert.equal(isProcessAlive(agentPid), true)

  const cancelled = run(["cancel", jobId, "--workspace", workspace, "--json"])
  assert.equal(cancelled.status, 0, cancelled.stderr)
  const cancelledJob = JSON.parse(cancelled.stdout)
  assert.equal(cancelledJob.status, "cancelled")
  assert.equal(cancelledJob.cursorSession.id, "fake-simple-session")
  assert.equal(cancelledJob.resumePolicy.allowed, true)
  for (let attempt = 0; attempt < 80 && isProcessAlive(agentPid); attempt += 1) wait(25)
  assert.equal(isProcessAlive(agentPid), false)
  const terminal = waitForJob(workspace, jobId, ["cancelled"])
  assert.equal(terminal.status, "cancelled")
  assert.equal("request" in terminal, false)
})

test("same-workspace foreground jobs run independently and cancel requires an unambiguous job", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const first = runAsync(
    ["task", "--workspace", workspace, "--json", "--", "foreground-a"],
    { FAKE_AGENT_MODE: "very-slow" },
  )
  const second = runAsync(
    ["task", "--workspace", workspace, "--json", "--", "foreground-b"],
    { FAKE_AGENT_MODE: "medium" },
  )

  let active = []
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = run(["status", "--workspace", workspace, "--all", "--json"])
    assert.equal(status.status, 0, status.stderr)
    active = JSON.parse(status.stdout).jobs.filter((job) => !["completed", "failed", "timeout", "cancelled"].includes(job.status))
    if (active.length === 2) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(active.length, 2)
  const firstJob = active.find((job) => job.promptPreview === "foreground-a")
  const secondJob = active.find((job) => job.promptPreview === "foreground-b")
  assert.ok(firstJob?.pid)
  assert.ok(secondJob?.pid)
  assert.notEqual(firstJob.id, secondJob.id)
  assert.notEqual(firstJob.pid, secondJob.pid)

  const ambiguous = run(["cancel", "--workspace", workspace, "--json"])
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /AMBIGUOUS_ACTIVE_JOBS/)

  const cancelled = run(["cancel", firstJob.id, "--workspace", workspace, "--json"])
  assert.equal(cancelled.status, 0, cancelled.stderr)
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled")

  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed])
  assert.notEqual(firstResult.status, 0)
  assert.equal(secondResult.status, 0, secondResult.stderr + secondResult.stdout)
  assert.equal(JSON.parse(firstResult.stdout).status, "cancelled")
  assert.equal(JSON.parse(secondResult.stdout).status, "completed")
})

test("different workspaces can run foreground jobs concurrently", async () => {
  const firstWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-a-"))
  const secondWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-b-"))
  const first = runAsync(
    ["task", "--workspace", firstWorkspace, "--json", "--", "workspace-a"],
    { FAKE_AGENT_MODE: "medium" },
  )
  const second = runAsync(
    ["task", "--workspace", secondWorkspace, "--json", "--", "workspace-b"],
    { FAKE_AGENT_MODE: "medium" },
  )
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed])
  assert.equal(firstResult.status, 0, firstResult.stderr)
  assert.equal(secondResult.status, 0, secondResult.stderr)
  const firstJob = JSON.parse(firstResult.stdout)
  const secondJob = JSON.parse(secondResult.stdout)
  assert.equal(firstJob.status, "completed")
  assert.equal(secondJob.status, "completed")
  assert.notEqual(firstJob.id, secondJob.id)
})

test("parent interruption cancels its foreground worker and Cursor process tree", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  const pidFile = path.join(os.tmpdir(), `cursor-companion-foreground-agent-${process.pid}-${Date.now()}.pid`)
  const foreground = runAsync(
    ["task", "--workspace", workspace, "--json", "--", "interrupt foreground"],
    { FAKE_AGENT_MODE: "very-slow", FAKE_AGENT_PID_FILE: pidFile },
  )
  let job = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = run(["status", "--workspace", workspace, "--json"])
    assert.equal(status.status, 0, status.stderr)
    job = JSON.parse(status.stdout).jobs[0] ?? null
    if (job?.status === "running" && fs.existsSync(pidFile)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(job?.status, "running")
  const agentPid = Number(fs.readFileSync(pidFile, "utf8").trim())
  assert.equal(isProcessAlive(agentPid), true)

  foreground.child.kill("SIGTERM")
  const completed = await foreground.completed
  assert.notEqual(completed.status, 0)
  assert.equal(JSON.parse(completed.stdout).status, "cancelled")
  for (let attempt = 0; attempt < 80 && isProcessAlive(agentPid); attempt += 1) wait(25)
  assert.equal(isProcessAlive(agentPid), false)
})

test("atomically rejects a shared artifact directory used by concurrent E2E jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-e2e-conflict-"))
  const workspace = createGitWorkspace(root, "workspace")
  const promptFile = path.join(root, "prompt.md")
  const artifactDir = path.join(root, "artifacts")
  fs.mkdirSync(artifactDir)
  fs.writeFileSync(promptFile, "Run the deterministic fake validation.\n")
  const common = [
    "task",
    "--workspace",
    workspace,
    "--mode",
    "e2e",
    "--prompt-file",
    promptFile,
    "--artifact-dir",
    artifactDir,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--background",
    "--json",
  ]
  const first = runAsync(common, { FAKE_AGENT_MODE: "sleep" })
  const second = runAsync(common, { FAKE_AGENT_MODE: "sleep" })
  const attempts = await Promise.all([first.completed, second.completed])
  const accepted = attempts.find((attempt) => attempt.status === 0)
  const rejected = attempts.find((attempt) => attempt.status !== 0)
  assert.ok(accepted)
  assert.ok(rejected)
  assert.match(rejected.stderr, /Artifact directory is already used by active job/)
  const acceptedJob = JSON.parse(accepted.stdout)
  waitForJob(workspace, acceptedJob.id, ["running"])

  const cancelled = run(["cancel", acceptedJob.id, "--workspace", workspace, "--json"])
  assert.equal(cancelled.status, 0, cancelled.stderr)
})

test("e2e mode forwards roots, checks, sandbox, and timeout boundaries to the runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-e2e-"))
  const workspace = createGitWorkspace(root, "primary")
  const additional = createGitWorkspace(root, "additional")
  const artifactDir = path.join(root, "artifacts")
  const promptFile = path.join(root, "prompt.md")
  fs.mkdirSync(artifactDir)
  fs.writeFileSync(promptFile, "Run the deterministic fake validation.\n")
  const result = run([
    "task",
    "--workspace",
    workspace,
    "--add-dir",
    additional,
    "--mode",
    "e2e",
    "--prompt-file",
    promptFile,
    "--artifact-dir",
    artifactDir,
    "--required-check",
    "fake-check",
    "--optional-check",
    "optional-smoke",
    "--timeout-ms",
    "5000",
    "--no-progress-timeout-ms",
    "2000",
    "--long-command-timeout-ms",
    "1500",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--json",
  ], { FAKE_AGENT_MODE: "pass" })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const job = JSON.parse(result.stdout)
  assert.equal(job.status, "completed")
  assert.equal(job.timeoutMs, 5_000)
  assert.equal(job.timeoutSource, "cli")
  const delegation = JSON.parse(fs.readFileSync(path.join(artifactDir, "delegation.json"), "utf8"))
  assert.deepEqual(delegation.workspaceRoots, [
    fs.realpathSync(workspace),
    fs.realpathSync(additional),
  ])
  assert.deepEqual(delegation.requiredChecks, ["fake-check"])
  assert.deepEqual(delegation.optionalChecks, ["optional-smoke"])
  assert.equal(delegation.sandbox, "enabled")
  assert.equal(delegation.timeoutMs, 5000)
  assert.equal(delegation.noProgressTimeoutMs, 2000)
  assert.equal(delegation.longCommandTimeoutMs, 1500)
})

test("resumes an explicit E2E job into a new job and artifact directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-resume-"))
  const workspace = createGitWorkspace(root, "workspace")
  const additional = createGitWorkspace(root, "additional")
  const firstPrompt = path.join(root, "first.md")
  const secondPrompt = path.join(root, "second.md")
  const firstArtifact = path.join(root, "first-artifacts")
  const secondArtifact = path.join(root, "second-artifacts")
  fs.writeFileSync(firstPrompt, "Run the first deterministic validation.\n")
  fs.writeFileSync(secondPrompt, "Re-read the worktree and rerun the affected check.\n")

  const first = run([
    "task",
    "--workspace",
    workspace,
    "--add-dir",
    additional,
    "--mode",
    "e2e",
    "--prompt-file",
    firstPrompt,
    "--artifact-dir",
    firstArtifact,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--model",
    "cursor-test-model",
    "--json",
  ], { FAKE_AGENT_MODE: "pass", FAKE_CURSOR_SESSION_ID: "live-resume-session" })
  assert.equal(first.status, 0, first.stderr + first.stdout)
  const firstJob = JSON.parse(first.stdout)
  assert.equal(firstJob.cursorSession.id, "live-resume-session")
  assert.equal(firstJob.resumePolicy.allowed, true)
  const firstResultBefore = fs.readFileSync(path.join(firstArtifact, "run-result.json"), "utf8")

  const second = run([
    "task",
    "--workspace",
    workspace,
    "--add-dir",
    additional,
    "--mode",
    "e2e",
    "--resume-job",
    firstJob.id.slice(0, 12),
    "--timeout-ms",
    "7000",
    "--prompt-file",
    secondPrompt,
    "--artifact-dir",
    secondArtifact,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--json",
  ], { FAKE_AGENT_MODE: "pass" })
  assert.equal(second.status, 0, second.stderr + second.stdout)
  const secondJob = JSON.parse(second.stdout)
  assert.notEqual(secondJob.id, firstJob.id)
  assert.equal(secondJob.resumedFromJobId, firstJob.id)
  assert.deepEqual(secondJob.cursorSession, {
    id: "live-resume-session",
    resumed: true,
    resumedFromJobId: firstJob.id,
  })
  assert.equal(secondJob.artifactDir, secondArtifact)
  assert.equal(secondJob.model, "cursor-test-model")
  assert.equal(secondJob.modelSource, "resume")
  assert.equal(secondJob.timeoutMs, 7_000)
  assert.equal(secondJob.timeoutSource, "cli")
  assert.equal(fs.readFileSync(path.join(firstArtifact, "run-result.json"), "utf8"), firstResultBefore)
  const status = run(["status", secondJob.id, "--workspace", workspace, "--json"])
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).cursorSession.id, "live-resume-session")
  const result = run(["result", secondJob.id, "--workspace", workspace, "--json"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result.cursorSession.id, "live-resume-session")
  const humanResult = run(["result", secondJob.id, "--workspace", workspace])
  assert.equal(humanResult.status, 0, humanResult.stderr)
  assert.match(humanResult.stdout, new RegExp(`resumedFrom: ${firstJob.id}`))
  assert.doesNotMatch(humanResult.stdout, /live-resume-session/)
})

test("accepts every safely terminated E2E status as an explicit resume source", () => {
  for (const status of ["completed", "failed", "timeout", "cancelled"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `cursor-companion-resume-${status}-`))
    const workspace = createGitWorkspace(root, "workspace")
    const promptFile = path.join(root, "prompt.md")
    const artifactDir = path.join(root, "new-artifacts")
    fs.writeFileSync(promptFile, "Continue the deterministic validation.\n")
    const source = writeResumeSourceJob(workspace, {
      id: `source-${status}`,
      status,
      cursorSession: {
        id: `session-${status}`,
        resumed: false,
        resumedFromJobId: null,
      },
    })
    const resumed = run([
      "task",
      "--workspace",
      workspace,
      "--mode",
      "e2e",
      "--resume-job",
      source.id,
      "--prompt-file",
      promptFile,
      "--artifact-dir",
      artifactDir,
      "--required-check",
      "fake-check",
      "--agent-bin",
      FAKE_DELEGATED_AGENT,
      "--json",
    ], { FAKE_AGENT_MODE: "pass" })
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout)
    assert.equal(JSON.parse(resumed.stdout).cursorSession.id, `session-${status}`)
  }
})

test("captures a cancelled E2E session so a later job can resume it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-resume-cancel-"))
  const workspace = createGitWorkspace(root, "workspace")
  const firstPrompt = path.join(root, "first.md")
  const secondPrompt = path.join(root, "second.md")
  const firstArtifact = path.join(root, "first-artifacts")
  const secondArtifact = path.join(root, "second-artifacts")
  fs.writeFileSync(firstPrompt, "Wait for cancellation after initializing.\n")
  fs.writeFileSync(secondPrompt, "Continue after the parent-side repair.\n")
  const queued = run([
    "task",
    "--workspace",
    workspace,
    "--mode",
    "e2e",
    "--prompt-file",
    firstPrompt,
    "--artifact-dir",
    firstArtifact,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--background",
    "--json",
  ], { FAKE_AGENT_MODE: "sleep", FAKE_CURSOR_SESSION_ID: "cancelled-session" })
  assert.equal(queued.status, 0, queued.stderr)
  const firstJob = JSON.parse(queued.stdout)
  const sessionFile = path.join(firstArtifact, "cursor-session.json")
  for (let attempt = 0; attempt < 60 && !fs.existsSync(sessionFile); attempt += 1) wait(50)
  assert.equal(fs.existsSync(sessionFile), true)

  const cancelled = run(["cancel", firstJob.id, "--workspace", workspace, "--json"])
  assert.equal(cancelled.status, 0, cancelled.stderr)
  const cancelledJob = JSON.parse(cancelled.stdout)
  assert.equal(cancelledJob.cursorSession.id, "cancelled-session")
  assert.equal(cancelledJob.resumePolicy.allowed, true)

  const resumed = run([
    "task",
    "--workspace",
    workspace,
    "--mode",
    "e2e",
    "--resume-job",
    firstJob.id,
    "--prompt-file",
    secondPrompt,
    "--artifact-dir",
    secondArtifact,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
    "--json",
  ], { FAKE_AGENT_MODE: "pass" })
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout)
  assert.equal(JSON.parse(resumed.stdout).cursorSession.id, "cancelled-session")
})

test("rejects unsafe or incompatible resume sources before creating a new job", () => {
  const cases = [
    {
      name: "active job",
      source: { status: "running", pid: process.pid },
      expected: /still active/,
    },
    {
      name: "legacy job without session",
      source: { cursorSession: null },
      expected: /no recoverable Cursor session/,
    },
    {
      name: "unsafe prior result",
      source: {
        resumePolicy: {
          allowed: false,
          blockedReasons: ["PROHIBITED_GIT_OPERATION"],
        },
      },
      expected: /not safe to resume: PROHIBITED_GIT_OPERATION/,
    },
    {
      name: "sandbox mismatch",
      source: { sandbox: "disabled" },
      expected: /sandbox mode does not match/,
    },
    {
      name: "additional workspace mismatch",
      source: { addDirs: ["/different/additional-workspace"] },
      expected: /add-dir set does not match/,
    },
    {
      name: "model mismatch",
      source: { model: "cursor-old-model" },
      extraArgs: ["--model", "cursor-new-model"],
      expected: /Explicit --model conflicts/,
    },
  ]
  for (const [index, current] of cases.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `cursor-companion-resume-reject-${index}-`))
    const workspace = createGitWorkspace(root, "workspace")
    const promptFile = path.join(root, "prompt.md")
    const artifactDir = path.join(root, "new-artifacts")
    fs.writeFileSync(promptFile, "Continue the deterministic validation.\n")
    const source = writeResumeSourceJob(workspace, {
      id: `source-${index}`,
      ...current.source,
    })
    const resumed = run([
      "task",
      "--workspace",
      workspace,
      "--mode",
      "e2e",
      "--resume-job",
      source.id,
      "--prompt-file",
      promptFile,
      "--artifact-dir",
      artifactDir,
      "--required-check",
      "fake-check",
      "--agent-bin",
      FAKE_DELEGATED_AGENT,
      ...(current.extraArgs ?? []),
      "--json",
    ])
    assert.notEqual(resumed.status, 0, current.name)
    assert.match(resumed.stderr, current.expected)
    assert.equal(fs.existsSync(path.join(artifactDir, "delegation.json")), false)
  }
})

test("rejects cross-mode resume and refuses to reuse an E2E artifact directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-resume-boundary-"))
  const workspace = createGitWorkspace(root, "workspace")
  const sourceArtifact = path.join(root, "source-artifacts")
  fs.mkdirSync(sourceArtifact)
  const source = writeResumeSourceJob(workspace, { artifactDir: sourceArtifact })

  const simple = run([
    "task",
    "--workspace",
    workspace,
    "--resume-job",
    source.id,
    "--",
    "continue",
  ])
  assert.notEqual(simple.status, 0)
  assert.match(simple.stderr, /source mode e2e does not match --mode simple/)

  const promptFile = path.join(root, "prompt.md")
  fs.writeFileSync(promptFile, "Continue the deterministic validation.\n")
  const reused = run([
    "task",
    "--workspace",
    workspace,
    "--mode",
    "e2e",
    "--resume-job",
    source.id,
    "--prompt-file",
    promptFile,
    "--artifact-dir",
    sourceArtifact,
    "--required-check",
    "fake-check",
    "--agent-bin",
    FAKE_DELEGATED_AGENT,
  ])
  assert.notEqual(reused.status, 0)
  assert.match(reused.stderr, /requires a new artifact directory/)
})
