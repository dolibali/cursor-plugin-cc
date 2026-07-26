import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import process from "node:process"
import test from "node:test"

import { isSystemTemporaryPath } from "../plugins/cursor/scripts/lib/system-temp.mjs"

test("recognizes the configured system temporary directory", () => {
  assert.equal(isSystemTemporaryPath(os.tmpdir()), true)
})

test("recognizes POSIX temporary directory aliases", {
  skip: process.platform === "win32",
}, () => {
  assert.equal(isSystemTemporaryPath("/tmp"), true)
  if (fs.existsSync("/private/tmp")) {
    assert.equal(isSystemTemporaryPath("/private/tmp"), true)
  }
})
