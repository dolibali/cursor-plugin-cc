#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const installer = path.join(root, "scripts", "install-skills.sh")
const configFile = path.join(os.homedir(), ".cursor", "cursor-companion", "config.json")
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-cc-timeout-workspace-"))
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-cc-live-timeout-"))
const configuredTimeoutMs = 4 * 60 * 60 * 1_000
const cliTimeoutMs = 10 * 60 * 1_000
const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null

function environment() {
  const { CURSOR_COMPANION_TIMEOUT_MS: _ignoredTimeout, ...cleanEnvironment } = process.env
  return cleanEnvironment
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: environment(),
    timeout: options.timeout ?? configuredTimeoutMs + 60_000,
  })
}

function requireSuccess(result, label) {
  if (result.status === 0) return
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim()
  throw new Error(`${label} failed with exit ${result.status}: ${detail}`)
}

function parseJsonResult(result, label) {
  requireSuccess(result, label)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
}

function restoreConfig() {
  if (originalConfig == null) {
    fs.rmSync(configFile, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  const temporary = `${configFile}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, originalConfig)
  fs.renameSync(temporary, configFile)
}

function runTask(companion, extraArgs, prompt) {
  return parseJsonResult(
    run(
      process.execPath,
      [
        companion,
        "task",
        "--workspace",
        workspace,
        "--sandbox",
        "enabled",
        "--json",
        ...extraArgs,
        "--",
        prompt,
      ],
      { cwd: workspace },
    ),
    "real Cursor timeout task",
  )
}

async function main() {
  let succeeded = false
  try {
    requireSuccess(run("bash", [installer, "--replace-link"]), "Codex skill install")
    const installedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"))
    const companion = fs.realpathSync(installedConfig.companionScript)
    const expectedCompanion = fs.realpathSync(
      path.join(root, "plugins", "cursor", "scripts", "cursor-companion.mjs"),
    )
    if (companion !== expectedCompanion) {
      throw new Error("Installed companion does not resolve to this checkout")
    }

    const setup = parseJsonResult(
      run(process.execPath, [
        companion,
        "setup",
        "--set-timeout-ms",
        String(configuredTimeoutMs),
        "--json",
      ]),
      "Cursor timeout setup",
    )
    if (!setup.agent?.available || !setup.auth?.loggedIn || !setup.sandboxSupported) {
      throw new Error(
        `BLOCKED: Cursor Agent must be installed, authenticated, and sandbox-capable: ${
          setup.auth?.detail ?? setup.agent?.detail ?? "setup unavailable"
        }`,
      )
    }
    if (setup.timeout?.timeoutMs !== configuredTimeoutMs || setup.timeout?.source !== "config") {
      throw new Error("setup did not report the configured four-hour timeout")
    }

    requireSuccess(run("git", ["init"], { cwd: workspace }), "git init")
    requireSuccess(
      run("git", ["config", "user.email", "cursor-plugin-cc@example.invalid"], { cwd: workspace }),
      "git config",
    )
    requireSuccess(
      run("git", ["config", "user.name", "cursor-plugin-cc live timeout"], { cwd: workspace }),
      "git config",
    )
    fs.writeFileSync(path.join(workspace, "README.md"), "Cursor timeout smoke fixture.\n")
    requireSuccess(run("git", ["add", "README.md"], { cwd: workspace }), "git add")
    requireSuccess(run("git", ["commit", "-m", "fixture"], { cwd: workspace }), "git commit")

    const configJob = runTask(
      companion,
      [],
      "Do not modify files. Read README.md and reply only: config timeout verified",
    )
    if (configJob.timeoutMs !== configuredTimeoutMs || configJob.timeoutSource !== "config") {
      throw new Error("real config-timeout job did not record 14400000/config")
    }

    const cliJob = runTask(
      companion,
      ["--timeout-ms", String(cliTimeoutMs)],
      "Do not modify files. Read README.md and reply only: cli timeout verified",
    )
    if (cliJob.timeoutMs !== cliTimeoutMs || cliJob.timeoutSource !== "cli") {
      throw new Error("real CLI-timeout job did not record 600000/cli")
    }

    const status = run("git", ["status", "--porcelain"], { cwd: workspace })
    requireSuccess(status, "git status")
    if (status.stdout.trim()) throw new Error(`Real timeout smoke modified files: ${status.stdout.trim()}`)
    for (const job of [configJob, cliJob]) {
      if (job.status !== "completed" || job.pid != null) {
        throw new Error(`Real timeout job did not finish cleanly: ${job.id}`)
      }
    }

    fs.writeFileSync(
      path.join(artifactDir, "summary.json"),
      `${JSON.stringify({
        setup: setup.timeout,
        configJob: {
          id: configJob.id,
          timeoutMs: configJob.timeoutMs,
          timeoutSource: configJob.timeoutSource,
          cursorSession: configJob.cursorSession,
        },
        cliJob: {
          id: cliJob.id,
          timeoutMs: cliJob.timeoutMs,
          timeoutSource: cliJob.timeoutSource,
          cursorSession: cliJob.cursorSession,
        },
      }, null, 2)}\n`,
    )
    succeeded = true
  } finally {
    restoreConfig()
    if (succeeded) fs.rmSync(workspace, { recursive: true, force: true })
  }

  process.stdout.write(`PASS: real Cursor timeout configuration verified\nartifacts: ${artifactDir}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`artifacts: ${artifactDir}\nworkspace retained: ${workspace}\n`)
  process.exitCode = String(error?.message ?? error).startsWith("BLOCKED:") ? 3 : 1
})
