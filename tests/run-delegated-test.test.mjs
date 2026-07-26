import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const skillRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const runner = path.join(skillRoot, "plugins/cursor/scripts/run-delegated-test.mjs")
const fakeAgent = path.join(skillRoot, "tests/fake-agent-delegated.mjs")
const realGitBin = (await execFileAsync("which", ["git"])).stdout.trim()

async function command(commandName, args, cwd) {
  return execFileAsync(commandName, args, { cwd })
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "delegated-test-runner-"))
  const workspace = path.join(root, "workspace")
  const artifactDir = path.join(root, "artifacts")
  await mkdir(path.join(workspace, "src"), { recursive: true })
  await mkdir(path.join(workspace, "tests"), { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  await writeFile(path.join(workspace, "src/product.ts"), "export const value = 1\n")
  await writeFile(path.join(workspace, "tests/sample.test.ts"), "export const testValue = 1\n")
  const promptFile = path.join(root, "prompt.md")
  await writeFile(promptFile, "Run the deterministic fake validation.")
  await command("git", ["init"], workspace)
  await command("git", ["config", "user.email", "test@example.com"], workspace)
  await command("git", ["config", "user.name", "Test User"], workspace)
  await command("git", ["add", "."], workspace)
  await command("git", ["commit", "-m", "fixture"], workspace)
  return { root, workspace, artifactDir, promptFile }
}

async function runFixture(mode, options = {}) {
  const current = await fixture()
  if (options.additionalWorkspace) {
    current.additionalWorkspace = path.join(current.root, "additional-workspace")
    await mkdir(path.join(current.additionalWorkspace, "src"), { recursive: true })
    await writeFile(path.join(current.additionalWorkspace, "src/product.ts"), "export const value = 1\n")
    await command("git", ["init"], current.additionalWorkspace)
    await command("git", ["config", "user.email", "test@example.com"], current.additionalWorkspace)
    await command("git", ["config", "user.name", "Test User"], current.additionalWorkspace)
    await command("git", ["add", "."], current.additionalWorkspace)
    await command("git", ["commit", "-m", "fixture"], current.additionalWorkspace)
  }
  if (options.preexistingProductionChange) {
    await writeFile(path.join(current.workspace, "src/product.ts"), "export const value = 2\n// user change\n")
  }
  const args = [
    runner,
    "--workspace",
    current.workspace,
    "--prompt-file",
    current.promptFile,
    "--artifact-dir",
    current.artifactDir,
    "--agent-bin",
    fakeAgent,
    "--required-check",
    options.requiredCheck ?? "fake-check",
    "--timeout-ms",
    String(options.timeoutMs ?? 5_000),
    "--no-progress-timeout-ms",
    String(options.noProgressTimeoutMs ?? 2_000),
    "--long-command-timeout-ms",
    String(options.longCommandTimeoutMs ?? 2_000),
    "--sandbox",
    options.sandbox ?? "enabled",
  ]
  if (current.additionalWorkspace) args.push("--add-dir", current.additionalWorkspace)
  let exitCode = 0
  let stdout = ""
  let stderr = ""
  try {
    const output = await execFileAsync(process.execPath, args, {
      env: {
        ...process.env,
        CURSOR_DELEGATION_DEPTH: "0",
        DELEGATED_TEST_GUARD_INTERVAL_MS: "25",
        FAKE_AGENT_MODE: mode,
        FAKE_REAL_GIT_BIN: realGitBin,
      },
    })
    stdout = output.stdout
    stderr = output.stderr
  } catch (error) {
    exitCode = error.code
    stdout = error.stdout
    stderr = error.stderr
  }
  const resultPath = path.join(current.artifactDir, "run-result.json")
  const result = JSON.parse(await readFile(resultPath, "utf8"))
  return { ...current, exitCode, stdout, stderr, result }
}

test("returns PASS for a clean delegated run", async () => {
  const output = await runFixture("pass")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.deepEqual(output.result.source.changes, [])
  assert.deepEqual(output.result.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
  })
  assert.match(await readFile(output.result.logs.progress, "utf8"), /"type":"cursor\.phase"/)
})

test("allows verified source repairs", async () => {
  const output = await runFixture("autonomous-repair")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.repair.status, "APPLIED_AND_VERIFIED")
  assert.deepEqual(output.result.repair.changedFiles, [
    { workspace: fs.realpathSync(output.workspace), path: "src/product.ts" },
  ])
  assert.match(await readFile(output.result.attemptedRepairPatch, "utf8"), /autonomous repair/)
})

test("repair patches exclude pre-existing dirty worktree content", async () => {
  const output = await runFixture("autonomous-repair", {
    preexistingProductionChange: true,
  })
  assert.equal(output.exitCode, 0)
  const patch = await readFile(output.result.attemptedRepairPatch, "utf8")
  assert.match(patch, /autonomous repair/)
  assert.doesNotMatch(patch, /^\+\/\/ user change$/m)
})

test("rejects source changes that were not reported as verified repairs", async () => {
  const output = await runFixture("production-mutation")
  assert.equal(output.exitCode, 2)
  assert.equal(output.result.overall, "FAIL")
  assert.ok(output.result.reasons.includes("REPAIR_STATUS_MISMATCH"))
})

test("does not limit the number of meaningful repair iterations", async () => {
  const output = await runFixture("many-autonomous-repairs")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.repair.iterations.length, 4)
  assert.match(await readFile(output.result.logs.workerProgress, "utf8"), /completed repair iteration 3/)
})

test("returns BLOCKED when Cursor does not produce a structured result", async () => {
  const output = await runFixture("missing-result")
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("RESULT_INVALID"))
})

test("rejects a result that omits a parent-declared required check", async () => {
  const output = await runFixture("pass", { requiredCheck: "missing-check" })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.match(output.result.validation.reason, /omits required check: missing-check/)
})

test("rejects a result that references a missing artifact", async () => {
  const output = await runFixture("missing-artifact")
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.match(output.result.validation.reason, /agent artifact does not exist/)
})

test("terminates a worker only after no meaningful progress", async () => {
  const output = await runFixture("sleep", {
    timeoutMs: 2_000,
    noProgressTimeoutMs: 100,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("NO_MEANINGFUL_PROGRESS"))
})

test("meaningful progress keeps a worker alive", async () => {
  const output = await runFixture("meaningful-progress", {
    timeoutMs: 2_000,
    noProgressTimeoutMs: 200,
  })
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.match(await readFile(output.result.logs.progress, "utf8"), /worker\.meaningfulProgress/)
})

test("stream activity without meaningful progress does not keep a worker alive", async () => {
  const output = await runFixture("stream-without-progress", {
    timeoutMs: 2_000,
    noProgressTimeoutMs: 100,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("NO_MEANINGFUL_PROGRESS"))
})

test("terminates a declared long command at its bounded timeout", async () => {
  const output = await runFixture("long-command-timeout", {
    timeoutMs: 2_000,
    noProgressTimeoutMs: 100,
    longCommandTimeoutMs: 100,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("LONG_COMMAND_TIMEOUT"))
})

test("an active bounded long command is exempt from the no-progress timeout", async () => {
  const output = await runFixture("long-command-completes", {
    timeoutMs: 3_000,
    noProgressTimeoutMs: 500,
    longCommandTimeoutMs: 1_200,
  })
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.match(await readFile(output.result.logs.progress, "utf8"), /worker\.longCommand\.finish/)
})

test("rejects nested runner invocation before creating artifacts", async () => {
  const current = await fixture()
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        runner,
        "--workspace",
        current.workspace,
        "--prompt-file",
        current.promptFile,
        "--artifact-dir",
        current.artifactDir,
      ],
      { env: { ...process.env, CURSOR_DELEGATION_DEPTH: "1" } },
    ),
    /Nested Cursor delegation is not allowed/,
  )
})

test("stops immediately when Cursor starts an internal task tool call", async () => {
  const output = await runFixture("task-tool-call", {
    timeoutMs: 2_000,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("RECURSIVE_DELEGATION_TOOL_CALL"))
  assert.equal(output.result.recursionGuard.blockedAttempts, 1)
})

test("stops after three consecutive shell results have no exit status", async () => {
  const output = await runFixture("shell-unavailable", {
    timeoutMs: 2_000,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("WORKER_SHELL_UNAVAILABLE"))
  assert.equal(output.result.executionGuard.consecutiveShellFailures, 3)
})

test("a successful shell result resets the unavailable-shell sequence", async () => {
  const output = await runFixture("shell-failure-reset")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.executionGuard.consecutiveShellFailures, 2)
})

test("blocks detached process commands observed in the Cursor stream", async () => {
  const output = await runFixture("detached-process", {
    timeoutMs: 2_000,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("PROHIBITED_DETACHED_PROCESS"))
  assert.equal(output.result.executionGuard.blockedDetachedAttempts, 1)
})

test("blocks detached process binaries through the delegated PATH", async () => {
  const output = await runFixture("path-detached-process", {
    timeoutMs: 2_000,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("PROHIBITED_DETACHED_PROCESS"))
  assert.equal(output.result.executionGuard.blockedDetachedAttempts, 1)
})

test("blocks one PATH recursion attempt and lets the worker continue", async () => {
  const output = await runFixture("path-recursion")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.recursionGuard.blockedAttempts, 1)
})

test("stops repeated PATH recursion attempts", async () => {
  const output = await runFixture("repeated-path-recursion", {
    timeoutMs: 2_000,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("RECURSIVE_DELEGATION_REPEATED"))
})

test("terminates an absolute-path nested agent without killing the root worker", async () => {
  const output = await runFixture("nested-agent")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.recursionGuard.blockedAttempts, 1)
  assert.match(await readFile(output.result.logs.progress, "utf8"), /"source":"process-tree"/)
})

test("does not mistake an ordinary agent-named child for a Cursor worker", async () => {
  const output = await runFixture("ordinary-agent-named-process")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.recursionGuard.blockedAttempts, 0)
})

test("blocks destructive Git commands invoked through PATH", async () => {
  const output = await runFixture("git-destructive-attempt", {
    timeoutMs: 2_000,
  })
  assert.equal(output.exitCode, 3)
  assert.equal(output.result.overall, "BLOCKED")
  assert.ok(output.result.reasons.includes("PROHIBITED_GIT_OPERATION"))
  assert.equal(output.result.workspaceGuard.blockedAttempts, 1)
})

test("forwards read-only Git commands to the real executable", async () => {
  const output = await runFixture("git-read-only")
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.equal(output.result.workspaceGuard.blockedAttempts, 0)
  assert.deepEqual(output.result.workspaceGuard.violations, [])
})

test("detects repository metadata changes that bypass the PATH guard", async () => {
  const output = await runFixture("absolute-git-commit")
  assert.equal(output.exitCode, 2)
  assert.equal(output.result.overall, "FAIL")
  assert.ok(output.result.reasons.includes("PROHIBITED_GIT_STATE_CHANGE"))
  assert.ok(output.result.workspaceGuard.violations.includes("HEAD_CHANGED"))
  assert.equal(output.result.escalation.code, "PROHIBITED_GIT_STATE_CHANGE")
})

test("tracks repairs in an additional workspace", async () => {
  const output = await runFixture("additional-workspace-repair", { additionalWorkspace: true })
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.overall, "PASS")
  assert.deepEqual(output.result.workspaceRoots, [
    fs.realpathSync(output.workspace),
    fs.realpathSync(output.additionalWorkspace),
  ])
  assert.deepEqual(output.result.source.changes, [
    { workspace: fs.realpathSync(output.additionalWorkspace), path: "src/product.ts" },
  ])
})

test("detects protected Git metadata changes in an additional workspace", async () => {
  const output = await runFixture("additional-workspace-commit", { additionalWorkspace: true })
  assert.equal(output.exitCode, 2)
  assert.equal(output.result.overall, "FAIL")
  assert.ok(output.result.reasons.includes("PROHIBITED_GIT_STATE_CHANGE"))
  assert.ok(output.result.workspaceGuard.workspaces[1].violations.includes("HEAD_CHANGED"))
})

test("records unrestricted boundary metadata when sandbox is disabled", async () => {
  const output = await runFixture("pass", { sandbox: "disabled" })
  assert.equal(output.exitCode, 0)
  assert.equal(output.result.sandbox, "disabled")
  assert.equal(output.result.hostAccess, "unrestricted")
  assert.equal(output.result.filesystemBoundaryVerified, false)
})

test("defaults to three hours and thirty-minute progress boundaries", async () => {
  const current = await fixture()
  await execFileAsync(
    process.execPath,
    [
      runner,
      "--workspace",
      current.workspace,
      "--prompt-file",
      current.promptFile,
      "--artifact-dir",
      current.artifactDir,
      "--agent-bin",
      fakeAgent,
      "--required-check",
      "fake-check",
    ],
    {
      env: {
        ...process.env,
        CURSOR_DELEGATION_DEPTH: "0",
        DELEGATED_TEST_GUARD_INTERVAL_MS: "25",
        FAKE_AGENT_MODE: "pass",
      },
    },
  )
  const delegation = JSON.parse(await readFile(path.join(current.artifactDir, "delegation.json"), "utf8"))
  assert.equal(delegation.timeoutMs, 3 * 60 * 60 * 1_000)
  assert.equal(delegation.noProgressTimeoutMs, 30 * 60 * 1_000)
  assert.equal(delegation.longCommandTimeoutMs, 30 * 60 * 1_000)
  assert.equal(delegation.processGuardMs, 10 * 1_000)
})

test("rejects timeout overrides above their safety ceilings", async () => {
  const cases = [
    ["--timeout-ms", String(3 * 60 * 60 * 1_000 + 1), /cannot exceed 3 hours/],
    ["--no-progress-timeout-ms", String(30 * 60 * 1_000 + 1), /cannot exceed 30 minutes/],
    ["--long-command-timeout-ms", String(30 * 60 * 1_000 + 1), /cannot exceed 30 minutes/],
  ]
  for (const [flag, value, expected] of cases) {
    const current = await fixture()
    await assert.rejects(
      execFileAsync(process.execPath, [
        runner,
        "--workspace",
        current.workspace,
        "--prompt-file",
        current.promptFile,
        "--artifact-dir",
        current.artifactDir,
        "--agent-bin",
        fakeAgent,
        flag,
        value,
      ]),
      expected,
    )
  }
})

test("rejects removed verify-mode arguments", async () => {
  const cases = [
    ["--mode", "verify"],
    ["--writable-test-path", "tests"],
    ["--idle-timeout-ms", "1000"],
  ]
  for (const [flag, value] of cases) {
    const current = await fixture()
    await assert.rejects(
      execFileAsync(process.execPath, [
        runner,
        "--workspace",
        current.workspace,
        "--prompt-file",
        current.promptFile,
        "--artifact-dir",
        current.artifactDir,
        flag,
        value,
      ]),
      new RegExp(`Unknown argument: ${flag}`),
    )
  }
})

test("rejects an artifact directory inside the workspace without creating it", async () => {
  const current = await fixture()
  const insideArtifactDir = path.join(current.workspace, "generated-artifacts")
  await assert.rejects(
    execFileAsync(process.execPath, [
      runner,
      "--workspace",
      current.workspace,
      "--prompt-file",
      current.promptFile,
      "--artifact-dir",
      insideArtifactDir,
      "--agent-bin",
      fakeAgent,
      "--required-check",
      "fake-check",
    ]),
    /Artifact directory must be outside every workspace/,
  )
  await assert.rejects(access(insideArtifactDir))
})

test("accepts the POSIX /tmp system temporary root for runner artifacts", {
  skip: process.platform === "win32",
}, async (t) => {
  const current = await fixture()
  const artifactRoot = await mkdtemp("/tmp/delegated-test-runner-artifacts-")
  const artifactDir = path.join(artifactRoot, "artifacts")
  t.after(async () => {
    await Promise.all([
      rm(current.root, { recursive: true, force: true }),
      rm(artifactRoot, { recursive: true, force: true }),
    ])
  })
  await mkdir(artifactDir)
  const output = await execFileAsync(process.execPath, [
    runner,
    "--workspace",
    current.workspace,
    "--prompt-file",
    current.promptFile,
    "--artifact-dir",
    artifactDir,
    "--agent-bin",
    fakeAgent,
    "--required-check",
    "fake-check",
  ], {
    env: {
      ...process.env,
      CURSOR_DELEGATION_DEPTH: "0",
      DELEGATED_TEST_GUARD_INTERVAL_MS: "25",
      FAKE_AGENT_MODE: "pass",
      FAKE_REAL_GIT_BIN: realGitBin,
    },
  })
  assert.equal(output.stderr, "")
  const result = JSON.parse(await readFile(path.join(artifactDir, "run-result.json"), "utf8"))
  assert.equal(result.overall, "PASS")
})
