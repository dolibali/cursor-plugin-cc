import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const installer = path.join(root, "scripts", "install-skills.sh")
const uninstaller = path.join(root, "scripts", "uninstall-skills.sh")
const expectedSkill = path.join(root, "plugins", "cursor", "skills", "cursor-cli-runtime")
const expectedCompanion = path.join(root, "plugins", "cursor", "scripts", "cursor-companion.mjs")

function createHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-install-home-"))
}

function run(script, args, home) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  })
}

test("installer is idempotent and preserves unrelated config", () => {
  const home = createHome()
  const configDir = path.join(home, ".cursor", "cursor-companion")
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, "config.json"), '{"model":"test-model","custom":true}\n')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = run(installer, [], home)
    assert.equal(result.status, 0, result.stderr)
  }
  for (const parent of [".codex", ".agents"]) {
    const link = path.join(home, parent, "skills", "cursor-cli-runtime")
    assert.equal(fs.realpathSync(link), fs.realpathSync(expectedSkill))
  }
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"))
  assert.deepEqual(config, {
    model: "test-model",
    custom: true,
    companionScript: expectedCompanion,
  })
})

test("installer replaces only foreign symlinks when explicitly requested", () => {
  const home = createHome()
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-plugin-foreign-"))
  for (const parent of [".codex", ".agents"]) {
    const skills = path.join(home, parent, "skills")
    fs.mkdirSync(skills, { recursive: true })
    fs.symlinkSync(foreign, path.join(skills, "cursor-cli-runtime"))
  }
  const refused = run(installer, [], home)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /Refusing to replace foreign symlink/)
  const replaced = run(installer, ["--replace-link"], home)
  assert.equal(replaced.status, 0, replaced.stderr)
  assert.equal(
    fs.realpathSync(path.join(home, ".codex", "skills", "cursor-cli-runtime")),
    fs.realpathSync(expectedSkill),
  )
})

test("installer never replaces a real skill directory", () => {
  const home = createHome()
  const directory = path.join(home, ".codex", "skills", "cursor-cli-runtime")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "sentinel"), "keep")
  const result = run(installer, ["--replace-link"], home)
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(path.join(directory, "sentinel"), "utf8"), "keep")
})

test("installer backs up malformed config and stops", () => {
  const home = createHome()
  const configDir = path.join(home, ".cursor", "cursor-companion")
  fs.mkdirSync(configDir, { recursive: true })
  const config = path.join(configDir, "config.json")
  fs.writeFileSync(config, "{broken")
  const result = run(installer, [], home)
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(config, "utf8"), "{broken")
  assert.equal(fs.readdirSync(configDir).filter((name) => name.startsWith("config.json.bak-")).length, 1)
})

test("dry-run reports changes without creating links or config", () => {
  const home = createHome()
  const result = run(installer, ["--dry-run"], home)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /would link/)
  assert.match(result.stdout, /would set companionScript/)
  assert.equal(fs.existsSync(path.join(home, ".codex")), false)
  assert.equal(fs.existsSync(path.join(home, ".agents")), false)
  assert.equal(fs.existsSync(path.join(home, ".cursor")), false)
})

test("installer removes only a legacy link owned by this checkout", () => {
  const ownedHome = createHome()
  const ownedParent = path.join(ownedHome, ".agents", "skills")
  fs.mkdirSync(ownedParent, { recursive: true })
  fs.symlinkSync(path.join(root, "skills", "cursor-cli-runtime"), path.join(ownedParent, "cursor-cli-use"))
  assert.equal(run(installer, [], ownedHome).status, 0)
  assert.equal(fs.existsSync(path.join(ownedParent, "cursor-cli-use")), false)

  const foreignHome = createHome()
  const foreignParent = path.join(foreignHome, ".agents", "skills")
  const foreignTarget = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cli-use-foreign-"))
  fs.mkdirSync(foreignParent, { recursive: true })
  fs.symlinkSync(foreignTarget, path.join(foreignParent, "cursor-cli-use"))
  assert.equal(run(installer, [], foreignHome).status, 0)
  assert.equal(
    fs.realpathSync(path.join(foreignParent, "cursor-cli-use")),
    fs.realpathSync(foreignTarget),
  )
})

test("uninstaller removes only links and config owned by this checkout", () => {
  const home = createHome()
  assert.equal(run(installer, [], home).status, 0)
  const result = run(uninstaller, [], home)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "cursor-cli-runtime")), false)
  assert.equal(fs.existsSync(path.join(home, ".agents", "skills", "cursor-cli-runtime")), false)
  const config = JSON.parse(
    fs.readFileSync(path.join(home, ".cursor", "cursor-companion", "config.json"), "utf8"),
  )
  assert.equal("companionScript" in config, false)
})

test("uninstaller stops before removing links when config is malformed", () => {
  const home = createHome()
  assert.equal(run(installer, [], home).status, 0)
  const configDir = path.join(home, ".cursor", "cursor-companion")
  fs.writeFileSync(path.join(configDir, "config.json"), "{broken")
  const result = run(uninstaller, [], home)
  assert.notEqual(result.status, 0)
  assert.equal(fs.lstatSync(path.join(home, ".codex", "skills", "cursor-cli-runtime")).isSymbolicLink(), true)
  assert.equal(fs.lstatSync(path.join(home, ".agents", "skills", "cursor-cli-runtime")).isSymbolicLink(), true)
  assert.equal(fs.readdirSync(configDir).filter((name) => name.startsWith("config.json.bak-")).length, 1)
})
