import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const COMPANION = path.join(ROOT, "scripts", "cursor-companion.mjs")
const FAKE_AGENT = path.join(ROOT, "tests", "fake-agent.mjs")

function run(args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env, CURSOR_COMPANION_AGENT_BIN: FAKE_AGENT },
  })
}

test("setup --json reports model unset and fake agent", () => {
  const result = run(["setup", "--json"])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.agent.available, true)
  assert.equal(payload.model.source, "unset")
})

test("task rejects home workspace", () => {
  const result = run(["task", "--workspace", os.homedir(), "--", "hello"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /home directory/i)
})

test("task foreground with fake agent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-ws-"))
  fs.writeFileSync(path.join(workspace, "README.md"), "x\n")
  const result = run(["task", "--workspace", workspace, "--json", "--", "fix the readme note"])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const job = JSON.parse(result.stdout)
  assert.equal(job.status, "completed")
  assert.match(job.stdoutPreview || "", /FAKE_AGENT_OK/)
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
    env: { ...process.env, CURSOR_COMPANION_AGENT_BIN: FAKE_AGENT },
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const job = JSON.parse(result.stdout)
  assert.equal(job.status, "completed")
  assert.equal(fs.realpathSync(job.workspace), fs.realpathSync(workspace))
})
