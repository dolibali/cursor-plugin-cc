#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const installer = path.join(root, "scripts", "install-skills.sh")
const configFile = path.join(os.homedir(), ".cursor", "cursor-companion", "config.json")
const expectedSkill = path.join(root, "plugins", "cursor", "skills", "cursor-cli-runtime")
const expectedCompanion = path.join(root, "plugins", "cursor", "scripts", "cursor-companion.mjs")
const runId = new Date().toISOString().replaceAll(":", "-")
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-cc-live-workspace-"))
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), `cursor-plugin-cc-live-${runId}-`))
const boundarySentinel = path.join(artifactDir, "outside-workspace-sentinel.txt")
fs.writeFileSync(boundarySentinel, "must remain unchanged\n")

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: process.env,
    timeout: options.timeout ?? 60 * 60 * 1000,
  })
}

function requireSuccess(result, label) {
  if (result.status === 0) return
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim()
  throw new Error(`${label} failed with exit ${result.status}: ${detail}`)
}

function assertInstalledLink(target) {
  if (!fs.lstatSync(target).isSymbolicLink()) throw new Error(`Expected installed symlink: ${target}`)
  if (fs.realpathSync(target) !== fs.realpathSync(expectedSkill)) {
    throw new Error(`Installed skill does not resolve to this checkout: ${target}`)
  }
}

function pluginState() {
  const status = run("git", ["status", "--porcelain=v1", "-z"])
  const diff = run("git", ["diff", "--binary", "HEAD"])
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "-z"])
  requireSuccess(status, "plugin git status")
  requireSuccess(diff, "plugin git diff")
  requireSuccess(untracked, "plugin untracked files")
  const hash = createHash("sha256")
  hash.update(status.stdout)
  hash.update(diff.stdout)
  for (const relativePath of untracked.stdout.split("\0").filter(Boolean).sort()) {
    hash.update(relativePath)
    hash.update(fs.readFileSync(path.join(root, relativePath)))
  }
  return hash.digest("hex")
}

async function main() {
  requireSuccess(run("bash", [installer, "--replace-link"]), "Codex skill install")
  assertInstalledLink(path.join(os.homedir(), ".codex", "skills", "cursor-cli-runtime"))
  assertInstalledLink(path.join(os.homedir(), ".agents", "skills", "cursor-cli-runtime"))

  const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  if (fs.realpathSync(config.companionScript) !== fs.realpathSync(expectedCompanion)) {
    throw new Error("Installed companionScript does not resolve to this checkout")
  }

  const setup = run(process.execPath, [config.companionScript, "setup", "--json"])
  let setupResult
  try {
    setupResult = JSON.parse(setup.stdout)
  } catch {
    requireSuccess(setup, "Cursor setup")
    throw new Error("Cursor setup did not return JSON")
  }
  if (!setupResult.agent?.available || !setupResult.auth?.loggedIn || !setupResult.sandboxSupported) {
    throw new Error(
      `BLOCKED: Cursor Agent must be installed, authenticated, and sandbox-capable: ${
        setupResult.auth?.detail ?? setupResult.agent?.detail ?? "setup unavailable"
      }`,
    )
  }
  requireSuccess(setup, "Cursor setup")

  requireSuccess(run("git", ["init"], { cwd: workspace }), "git init")
  requireSuccess(run("git", ["config", "user.email", "cursor-plugin-cc@example.invalid"], { cwd: workspace }), "git config")
  requireSuccess(run("git", ["config", "user.name", "cursor-plugin-cc live smoke"], { cwd: workspace }), "git config")
  fs.writeFileSync(path.join(workspace, ".gitignore"), ".cursor/\n")
  requireSuccess(run("git", ["add", ".gitignore"], { cwd: workspace }), "git add")
  requireSuccess(run("git", ["commit", "-m", "fixture"], { cwd: workspace }), "git commit")
  const pluginStateBefore = pluginState()

  const task = run(
    process.execPath,
    [
      config.companionScript,
      "task",
      "--workspace",
      workspace,
      "--sandbox",
      "enabled",
      "--json",
      "--",
      "Create cursor-smoke.txt with exactly the UTF-8 text cursor-plugin-cc live smoke followed by one newline. Do not modify any other file.",
    ],
    { cwd: workspace },
  )
  fs.writeFileSync(path.join(artifactDir, "task.stdout.log"), task.stdout ?? "")
  fs.writeFileSync(path.join(artifactDir, "task.stderr.log"), task.stderr ?? "")
  if (task.status !== 0) {
    const detail = `${task.stderr ?? ""}\n${task.stdout ?? ""}`.trim()
    throw new Error(`BLOCKED: real Cursor task could not complete: ${detail}`)
  }
  const job = JSON.parse(task.stdout)
  if (job.status !== "completed") throw new Error(`Expected completed job, got ${job.status}`)
  if (pluginState() !== pluginStateBefore) throw new Error("Cursor modified the plugin checkout")
  if (fs.readFileSync(boundarySentinel, "utf8") !== "must remain unchanged\n") {
    throw new Error("Cursor modified a file outside the declared workspace")
  }

  const expected = "cursor-plugin-cc live smoke\n"
  const smokeFile = path.join(workspace, "cursor-smoke.txt")
  if (fs.readFileSync(smokeFile, "utf8") !== expected) throw new Error("Cursor smoke file content did not match")
  const status = run(process.execPath, [
    config.companionScript,
    "status",
    job.id,
    "--workspace",
    workspace,
    "--json",
  ])
  requireSuccess(status, "companion status")
  if (JSON.parse(status.stdout).status !== "completed") throw new Error("status did not report completed")
  const result = run(process.execPath, [
    config.companionScript,
    "result",
    job.id,
    "--workspace",
    workspace,
    "--json",
  ])
  requireSuccess(result, "companion result")
  if (JSON.parse(result.stdout).job.status !== "completed") throw new Error("result did not report completed")

  const changed = run("git", ["status", "--porcelain"], { cwd: workspace })
  requireSuccess(changed, "git status")
  if (changed.stdout.trim() !== "?? cursor-smoke.txt") {
    throw new Error(`Unexpected live-smoke changes: ${changed.stdout.trim()}`)
  }

  fs.writeFileSync(path.join(artifactDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`)
  fs.writeFileSync(path.join(artifactDir, "status.json"), status.stdout)
  fs.writeFileSync(path.join(artifactDir, "result.json"), result.stdout)
  fs.rmSync(workspace, { recursive: true, force: true })
  process.stdout.write(`PASS: real Cursor task completed\nartifacts: ${artifactDir}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`artifacts: ${artifactDir}\nworkspace retained: ${workspace}\n`)
  process.exitCode = String(error?.message ?? error).startsWith("BLOCKED:") ? 3 : 1
})
