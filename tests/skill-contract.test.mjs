import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const skillRoot = path.join(root, "plugins", "cursor", "skills", "cursor-cli-runtime")

test("foreground delegation requires a user-visible update before the blocking call", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8")
  const contract = await readFile(
    path.join(skillRoot, "references", "delegated-test-contract.md"),
    "utf8",
  )
  assert.match(skill, /Immediately before every foreground `task` invocation/)
  assert.match(skill, /Send this update before the\s+shell\/tool call/)
  assert.match(
    skill,
    /Do not add this\s+announcement for short `status`,\s+`result`, or `cancel`/,
  )
  assert.match(contract, /Immediately before the blocking call/)
  assert.match(contract, /update must precede\s+the tool call/)
})

test("foreground delegation uses the companion timeout without shortening it", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8")
  const generalContract = await readFile(
    path.join(skillRoot, "references", "general-task-contract.md"),
    "utf8",
  )
  const delegatedContract = await readFile(
    path.join(skillRoot, "references", "delegated-test-contract.md"),
    "utf8",
  )
  for (const content of [skill, generalContract, delegatedContract]) {
    assert.match(content, /setup --json/)
    assert.match(content, /timeoutMs/)
    assert.match(content, /--background/)
    assert.match(content, /background_terminal_max_timeout/)
  }
  assert.match(skill, /never set it lower than the companion deadline/)
})

test("Codex keeps persistent-terminal draining inside one model-visible call", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8")
  assert.match(skill, /blocking unit is the outer `functions\.exec` call/)
  assert.match(
    skill,
    /```javascript\n\/\/ @exec: \{"yield_time_ms": 3610000, "max_output_tokens": 8000\}/,
  )
  assert.match(skill, /while \(result\.session_id !== undefined\)/)
  assert.match(skill, /yield_time_ms: 300000/)
  assert.match(skill, /Do not return the session ID to\s+the parent model/)
  assert.match(skill, /use `--background` from the start/)
})

test("plugin version metadata stays synchronized", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const pluginManifest = JSON.parse(
    await readFile(path.join(root, "plugins", "cursor", ".claude-plugin", "plugin.json"), "utf8"),
  )
  const marketplace = JSON.parse(
    await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"),
  )
  assert.equal(packageManifest.version, "0.3.5")
  assert.equal(pluginManifest.version, packageManifest.version)
  assert.equal(marketplace.metadata.version, packageManifest.version)
  assert.equal(marketplace.plugins[0].version, packageManifest.version)
})
