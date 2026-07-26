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
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-cc-resume-workspace-"))
const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-cc-live-resume-"))
const firstArtifact = path.join(artifactRoot, "first")
const secondArtifact = path.join(artifactRoot, "second")
const firstPrompt = path.join(artifactRoot, "first-prompt.md")
const secondPrompt = path.join(artifactRoot, "second-prompt.md")
const simpleNonce = `simple-resume-${randomUUID()}`
const e2eNonce = `e2e-resume-${randomUUID()}`

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: process.env,
    timeout: options.timeout ?? 3 * 60 * 60 * 1000,
  })
}

function requireSuccess(result, label) {
  if (result.status === 0) return
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim()
  throw new Error(`${label} failed with exit ${result.status}: ${detail}`)
}

function parseJob(result, label) {
  requireSuccess(result, label)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} did not return a JSON job`)
  }
}

function runE2E(companion, args) {
  return run(process.execPath, [
    companion,
    "task",
    "--mode",
    "e2e",
    "--workspace",
    workspace,
    "--sandbox",
    "enabled",
    "--required-check",
    "resume-context",
    "--json",
    ...args,
  ], { cwd: workspace })
}

function runSimple(companion, args, prompt) {
  return run(process.execPath, [
    companion,
    "task",
    "--workspace",
    workspace,
    "--sandbox",
    "enabled",
    "--json",
    ...args,
    "--",
    prompt,
  ], { cwd: workspace })
}

async function main() {
  requireSuccess(run("bash", [installer, "--replace-link"]), "Codex skill install")
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"))
  const companion = fs.realpathSync(config.companionScript)
  const expectedCompanion = fs.realpathSync(
    path.join(root, "plugins", "cursor", "scripts", "cursor-companion.mjs"),
  )
  if (companion !== expectedCompanion) {
    throw new Error("Installed companion does not resolve to this checkout")
  }

  const setup = run(process.execPath, [companion, "setup", "--json"])
  const setupResult = JSON.parse(setup.stdout || "{}")
  if (!setupResult.agent?.available || !setupResult.auth?.loggedIn || !setupResult.sandboxSupported) {
    throw new Error(
      `BLOCKED: Cursor Agent must be installed, authenticated, and sandbox-capable: ${
        setupResult.auth?.detail ?? setupResult.agent?.detail ?? "setup unavailable"
      }`,
    )
  }
  requireSuccess(setup, "Cursor setup")

  requireSuccess(run("git", ["init"], { cwd: workspace }), "git init")
  requireSuccess(
    run("git", ["config", "user.email", "cursor-plugin-cc@example.invalid"], { cwd: workspace }),
    "git config",
  )
  requireSuccess(
    run("git", ["config", "user.name", "cursor-plugin-cc live resume"], { cwd: workspace }),
    "git config",
  )
  fs.writeFileSync(path.join(workspace, "README.md"), "Cursor resume smoke fixture.\n")
  requireSuccess(run("git", ["add", "README.md"], { cwd: workspace }), "git add")
  requireSuccess(run("git", ["commit", "-m", "fixture"], { cwd: workspace }), "git commit")

  const firstSimpleTask = runSimple(
    companion,
    [],
    `Do not modify files. Remember this nonce for a later continuation: ${simpleNonce}. Reply only: remembered.`,
  )
  fs.writeFileSync(path.join(artifactRoot, "simple-first.stdout.log"), firstSimpleTask.stdout ?? "")
  fs.writeFileSync(path.join(artifactRoot, "simple-first.stderr.log"), firstSimpleTask.stderr ?? "")
  const firstSimpleJob = parseJob(firstSimpleTask, "first Cursor simple task")

  const secondSimpleTask = runSimple(
    companion,
    ["--resume-job", firstSimpleJob.id],
    "Do not modify files. Reply with only the nonce remembered from the prior conversation.",
  )
  fs.writeFileSync(path.join(artifactRoot, "simple-second.stdout.log"), secondSimpleTask.stdout ?? "")
  fs.writeFileSync(path.join(artifactRoot, "simple-second.stderr.log"), secondSimpleTask.stderr ?? "")
  const secondSimpleJob = parseJob(secondSimpleTask, "resumed Cursor simple task")
  if (
    secondSimpleJob.cursorSession?.id !== firstSimpleJob.cursorSession?.id
    || secondSimpleJob.cursorSession?.resumed !== true
    || secondSimpleJob.resumedFromJobId !== firstSimpleJob.id
  ) {
    throw new Error("Simple continuation did not preserve Cursor session lineage")
  }
  if (!secondSimpleJob.stdoutPreview?.includes(simpleNonce)) {
    throw new Error("Simple continuation did not retain the first prompt nonce")
  }
  const simpleResult = run(process.execPath, [
    companion,
    "result",
    secondSimpleJob.id,
    "--workspace",
    workspace,
    "--json",
  ], { cwd: workspace })
  requireSuccess(simpleResult, "resumed simple result")
  const persistedSimpleJob = JSON.parse(simpleResult.stdout).job
  if (
    !persistedSimpleJob.stdoutPreview?.includes(simpleNonce)
    || persistedSimpleJob.stdoutPreview.includes('"type":"system"')
  ) {
    throw new Error("Simple result did not preserve the parsed final answer")
  }

  fs.writeFileSync(
    firstPrompt,
    `Do not modify files. Remember this nonce for a later continuation: ${e2eNonce}. Inspect README.md and report required check resume-context as PASS with concise evidence.\n`,
  )
  const firstTask = runE2E(companion, [
    "--prompt-file",
    firstPrompt,
    "--artifact-dir",
    firstArtifact,
  ])
  fs.writeFileSync(path.join(artifactRoot, "first-task.stdout.log"), firstTask.stdout ?? "")
  fs.writeFileSync(path.join(artifactRoot, "first-task.stderr.log"), firstTask.stderr ?? "")
  const firstJob = parseJob(firstTask, "first Cursor E2E task")
  if (!firstJob.cursorSession?.id) throw new Error("First job did not capture a Cursor session")

  fs.writeFileSync(
    secondPrompt,
    "Do not modify files. Re-read README.md. Report required check resume-context as PASS and include the nonce remembered from the prior conversation in its evidence. Do not invent or replace it.\n",
  )
  const secondTask = runE2E(companion, [
    "--resume-job",
    firstJob.id,
    "--prompt-file",
    secondPrompt,
    "--artifact-dir",
    secondArtifact,
  ])
  fs.writeFileSync(path.join(artifactRoot, "second-task.stdout.log"), secondTask.stdout ?? "")
  fs.writeFileSync(path.join(artifactRoot, "second-task.stderr.log"), secondTask.stderr ?? "")
  const secondJob = parseJob(secondTask, "resumed Cursor E2E task")
  if (secondJob.id === firstJob.id) throw new Error("Resumed task reused the old companion job ID")
  if (secondJob.cursorSession?.id !== firstJob.cursorSession.id) {
    throw new Error("Resumed task did not preserve the Cursor session ID")
  }
  if (secondJob.cursorSession?.resumed !== true || secondJob.resumedFromJobId !== firstJob.id) {
    throw new Error("Resumed task did not preserve explicit companion lineage")
  }

  const firstResult = JSON.parse(fs.readFileSync(path.join(firstArtifact, "run-result.json"), "utf8"))
  const secondResult = JSON.parse(fs.readFileSync(path.join(secondArtifact, "run-result.json"), "utf8"))
  if (firstResult.overall !== "PASS" || secondResult.overall !== "PASS") {
    throw new Error(`Expected both E2E passes, got ${firstResult.overall} and ${secondResult.overall}`)
  }
  const resumedEvidence = secondResult.agentResult?.checks
    ?.find((check) => check.id === "resume-context")
    ?.evidence
  if (typeof resumedEvidence !== "string" || !resumedEvidence.includes(e2eNonce)) {
    throw new Error("Resumed Cursor context did not retain the first prompt nonce")
  }
  if (run("git", ["status", "--porcelain"], { cwd: workspace }).stdout.trim()) {
    throw new Error("Live resume smoke modified the Git workspace")
  }
  for (const artifactDir of [firstArtifact, secondArtifact]) {
    if (fs.existsSync(path.join(artifactDir, ".cursor-companion-job.json"))) {
      throw new Error(`Artifact ownership claim was not released: ${artifactDir}`)
    }
  }

  fs.writeFileSync(
    path.join(artifactRoot, "summary.json"),
    `${JSON.stringify({
      simple: {
        firstJobId: firstSimpleJob.id,
        secondJobId: secondSimpleJob.id,
        cursorSession: secondSimpleJob.cursorSession,
        nonceVerified: true,
      },
      e2e: {
        firstJobId: firstJob.id,
        secondJobId: secondJob.id,
        cursorSession: secondJob.cursorSession,
        nonceVerified: true,
        firstArtifact,
        secondArtifact,
      },
    }, null, 2)}\n`,
  )
  fs.rmSync(workspace, { recursive: true, force: true })
  process.stdout.write(`PASS: real Cursor simple and E2E sessions resumed\nartifacts: ${artifactRoot}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`artifacts: ${artifactRoot}\nworkspace retained: ${workspace}\n`)
  process.exitCode = String(error?.message ?? error).startsWith("BLOCKED:") ? 3 : 1
})
