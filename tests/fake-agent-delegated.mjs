#!/usr/bin/env node

import { spawn } from "node:child_process"
import { appendFile, readFile, utimes, writeFile } from "node:fs/promises"
import path from "node:path"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  process.stdout.write("Usage: fake-agent --sandbox enabled|disabled --add-dir <path>\n")
  process.exit(0)
}
if (args.includes("status")) {
  process.stdout.write("Logged in as fake-user\n")
  process.exit(0)
}

const artifactDir = process.env.DELEGATED_TEST_ARTIFACT_DIR
const workspace = process.env.DELEGATED_TEST_WORKSPACE
const workspaces = JSON.parse(process.env.DELEGATED_TEST_WORKSPACES ?? `["${workspace}"]`)
const mode = process.env.FAKE_AGENT_MODE ?? "pass"
const progressFile = process.env.DELEGATED_TEST_PROGRESS_FILE
if (process.env.FAKE_AGENT_ENV_LOG) {
  await writeFile(
    process.env.FAKE_AGENT_ENV_LOG,
    `${JSON.stringify({
      artifactDir,
      delegatedTempDir: process.env.DELEGATED_TEST_TMP_DIR,
      tmpdir: process.env.TMPDIR,
      tmp: process.env.TMP,
      temp: process.env.TEMP,
    })}\n`,
  )
}
const resumeIndex = args.indexOf("--resume")
const requestedSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null
const defaultSessionId = process.env.FAKE_CURSOR_SESSION_ID ?? "fake-cursor-session"
const emittedSessionId = mode === "resume-mismatch"
  ? "different-fake-cursor-session"
  : requestedSessionId ?? defaultSessionId

if (process.env.FAKE_AGENT_ARGV_LOG) {
  await writeFile(process.env.FAKE_AGENT_ARGV_LOG, `${JSON.stringify(args, null, 2)}\n`)
}

async function progress(event) {
  if (progressFile) await appendFile(progressFile, `${JSON.stringify(event)}\n`)
}

async function childExit(command, args) {
  const child = spawn(command, args, { env: process.env, stdio: "ignore" })
  return new Promise((resolve) => child.once("exit", resolve))
}

if (mode !== "resume-missing") {
  process.stdout.write(`${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: emittedSessionId,
  })}\n`)
}
process.stdout.write(`${JSON.stringify({
  type: "tool_call",
  subtype: "started",
  tool_call: { shellToolCall: { description: "Run fake validation" } },
})}\n`)

if (mode === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  process.exit(0)
}

if (mode === "meaningful-progress") {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    await progress({
      type: "meaningful-progress",
      kind: index === 3 ? "phase-complete" : "evidence",
      summary: `new evidence ${index}`,
    })
  }
}
if (mode === "stream-without-progress") {
  for (let index = 0; index < 20; index += 1) {
    process.stdout.write(`${JSON.stringify({
      type: "tool_call",
      subtype: "started",
      tool_call: { shellToolCall: { description: `Repeated activity ${index}` } },
    })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
if (mode === "task-tool-call") {
  process.stdout.write(`${JSON.stringify({
    type: "tool_call",
    subtype: "started",
    tool_call: { taskToolCall: { args: { description: "Nested delegated task" } } },
  })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  process.exit(0)
}
if (mode === "shell-unavailable" || mode === "shell-failure-reset") {
  const emitShellResult = (failed) => {
    const result = failed
      ? {
          spawnError: {
            error: "The shell command returned no exit status, so its result is unknown.",
          },
        }
      : { exitCode: 0, stdout: "ok", stderr: "" }
    process.stdout.write(`${JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      tool_call: { shellToolCall: { result } },
    })}\n`)
  }
  if (mode === "shell-unavailable") {
    for (let index = 0; index < 3; index += 1) emitShellResult(true)
    await new Promise((resolve) => setTimeout(resolve, 30_000))
    process.exit(0)
  }
  emitShellResult(true)
  emitShellResult(false)
  emitShellResult(true)
  emitShellResult(true)
}
if (mode === "detached-process") {
  process.stdout.write(`${JSON.stringify({
    type: "tool_call",
    subtype: "started",
    tool_call: {
      shellToolCall: {
        args: {
          command: "nohup node server.mjs >/tmp/server.log 2>&1 &",
          simpleCommands: ["nohup", "node"],
        },
      },
    },
  })}\n`)
}
if (mode === "path-detached-process") {
  const exitCode = await childExit("nohup", [process.execPath, "-e", ""])
  if (exitCode !== 0) process.exit(exitCode ?? 1)
}
if (mode === "long-command-timeout") {
  await progress({ type: "long-command", state: "start", command: "fake long command", expectedMaxMs: 100 })
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  process.exit(0)
}
if (mode === "long-command-completes") {
  await progress({ type: "long-command", state: "start", command: "fake bounded command", expectedMaxMs: 1_200 })
  await new Promise((resolve) => setTimeout(resolve, 700))
  await progress({ type: "long-command", state: "finish" })
}
if (mode === "path-recursion") {
  const nested = spawn("agent", ["nested"], { env: process.env, stdio: "ignore" })
  await new Promise((resolve) => nested.once("exit", resolve))
}
if (mode === "repeated-path-recursion") {
  for (let index = 0; index < 2; index += 1) {
    const nested = spawn("agent", ["nested"], { env: process.env, stdio: "ignore" })
    await new Promise((resolve) => nested.once("exit", resolve))
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000))
}
if (mode === "nested-agent") {
  const nested = spawn(process.argv[1], [], {
    env: { ...process.env, FAKE_AGENT_MODE: "sleep" },
    stdio: "ignore",
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (nested.exitCode === null) nested.kill("SIGKILL")
}
if (mode === "ordinary-agent-named-process") {
  const ordinary = spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)", "agent-helper"], {
    stdio: "ignore",
  })
  await new Promise((resolve) => ordinary.once("exit", resolve))
}
if (mode === "git-destructive-attempt") {
  await childExit("git", ["reset", "--hard", "HEAD"])
  await new Promise((resolve) => setTimeout(resolve, 150))
}
if (mode === "git-read-only") {
  const exitCode = await childExit("git", ["-C", workspace, "status", "--short"])
  if (exitCode !== 0) process.exit(exitCode ?? 1)
}

if (mode === "production-mutation") {
  await appendFile(path.join(workspace, "src/product.ts"), "\n// unexpected mutation\n")
}
if (mode === "autonomous-repair") {
  await appendFile(path.join(workspace, "src/product.ts"), "\n// autonomous repair\n")
  await progress({ type: "meaningful-progress", kind: "repair", summary: "repaired product behavior" })
}
if (mode === "autonomous-repair-index-refresh") {
  const unchangedFile = path.join(workspace, "tests/sample.test.ts")
  const future = new Date(Date.now() + 5_000)
  await utimes(unchangedFile, future, future)
  await childExit(process.env.FAKE_REAL_GIT_BIN, ["-C", workspace, "update-index", "--refresh"])
  await appendFile(path.join(workspace, "src/product.ts"), "\n// autonomous repair after index refresh\n")
  await progress({ type: "meaningful-progress", kind: "repair", summary: "repaired after index stat refresh" })
}
if (mode === "absolute-git-stage") {
  await appendFile(path.join(workspace, "src/product.ts"), "\n// staged by delegated worker\n")
  await childExit(process.env.FAKE_REAL_GIT_BIN, ["-C", workspace, "add", "src/product.ts"])
}
if (mode === "additional-workspace-repair") {
  await appendFile(path.join(workspaces[1], "src/product.ts"), "\n// additional workspace repair\n")
  await progress({ type: "meaningful-progress", kind: "repair", summary: "repaired additional workspace" })
}
if (mode === "many-autonomous-repairs") {
  for (let index = 0; index < 4; index += 1) {
    await appendFile(path.join(workspace, "src/product.ts"), `\n// autonomous repair ${index}\n`)
    await progress({
      type: "meaningful-progress",
      kind: "repair",
      summary: `completed repair iteration ${index}`,
    })
  }
}
if (mode === "absolute-git-commit") {
  await appendFile(path.join(workspace, "src/product.ts"), "\n// committed by delegated worker\n")
  await childExit(process.env.FAKE_REAL_GIT_BIN, ["-C", workspace, "add", "src/product.ts"])
  await childExit(process.env.FAKE_REAL_GIT_BIN, ["-C", workspace, "commit", "-m", "forbidden"])
}
if (mode === "additional-workspace-commit") {
  await appendFile(path.join(workspaces[1], "src/product.ts"), "\n// committed in additional workspace\n")
  await childExit(process.env.FAKE_REAL_GIT_BIN, ["-C", workspaces[1], "add", "src/product.ts"])
  await childExit(process.env.FAKE_REAL_GIT_BIN, ["-C", workspaces[1], "commit", "-m", "forbidden"])
}
if (mode === "missing-result") process.exit(0)

const delegation = JSON.parse(await readFile(path.join(artifactDir, "delegation.json"), "utf8"))
const checks = [
  { id: "fake-check", status: "PASS", required: true },
  ...delegation.optionalChecks.map((id) => ({ id, status: "PASS", required: false })),
]
const result = {
  schemaVersion: 1,
  summary: "Fake delegated test completed",
  checks: checks.map((check) => ({ ...check, evidence: "fake evidence" })),
  cleanup: {
    status: "PASS",
    details: "nothing left running",
  },
  artifacts: [],
  blockers: [],
}
const repairCount = mode === "many-autonomous-repairs"
  ? 4
  : mode === "autonomous-repair"
      || mode === "autonomous-repair-index-refresh"
      || mode === "additional-workspace-repair"
    ? 1
    : 0
result.repair = {
  status: repairCount > 0 ? "APPLIED_AND_VERIFIED" : "NONE",
  iterations: Array.from({ length: repairCount }, (_, index) => ({
    evidence: `failure evidence ${index}`,
    hypothesis: `root cause ${index}`,
    changedFiles: ["src/product.ts"],
    verification: ["fake-check PASS"],
  })),
}
result.progress = {
  lastMeaningfulProgressAt: new Date().toISOString(),
  elapsedMs: 1,
}
result.recursionGuard = {
  depth: 1,
  blockedAttempts: mode === "path-recursion" || mode === "nested-agent" ? 1 : 0,
}
result.escalation = null
if (mode === "valid-escalation" || mode === "invalid-escalation-reason") {
  result.checks[0].status = "FAIL"
  result.repair = {
    status: "ESCALATION_REQUIRED",
    iterations: [],
  }
  result.escalation = mode === "valid-escalation"
    ? {
        code: "FAKE_REQUIRED_CHECK_FAILED",
        summary: "The fake required check needs parent review.",
      }
    : {
        reason: "The fake required check needs parent review.",
      }
}
if (mode === "missing-artifact") {
  result.artifacts.push({
    path: path.join(artifactDir, "missing-screenshot.png"),
    kind: "screenshot",
  })
}
if (mode === "outside-artifact") {
  result.artifacts.push({
    path: process.env.FAKE_EXTERNAL_ARTIFACT_PATH,
    kind: "screenshot",
  })
}
await writeFile(path.join(artifactDir, "agent-result.json"), `${JSON.stringify(result, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({
  type: "result",
  result: "done",
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
  },
})}\n`)
