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
  assert.match(skill, /Do not add this\s+announcement for short `status`, `result`, or `cancel`/)
  assert.match(contract, /Immediately before the blocking call/)
  assert.match(contract, /update must precede the tool call/)
})

test("plugin version metadata stays synchronized", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const pluginManifest = JSON.parse(
    await readFile(path.join(root, "plugins", "cursor", ".claude-plugin", "plugin.json"), "utf8"),
  )
  const marketplace = JSON.parse(
    await readFile(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"),
  )
  assert.equal(packageManifest.version, "0.3.3")
  assert.equal(pluginManifest.version, packageManifest.version)
  assert.equal(marketplace.metadata.version, packageManifest.version)
  assert.equal(marketplace.plugins[0].version, packageManifest.version)
})
