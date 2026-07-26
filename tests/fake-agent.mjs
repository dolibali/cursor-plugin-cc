#!/usr/bin/env node
// Minimal fake Cursor agent for companion tests
import fs from "node:fs"

const args = process.argv.slice(2)
const mode = process.env.FAKE_AGENT_MODE || "ok"

if (args.includes("--help") || args.includes("status")) {
  if (args.includes("status")) {
    process.stdout.write("Logged in as fake-user\n")
    process.exit(0)
  }
  process.stdout.write(process.env.FAKE_AGENT_NO_SANDBOX
    ? "Usage: fake-agent [options] <prompt>\n"
    : "Usage: fake-agent [options] --sandbox enabled|disabled <prompt>\n")
  process.exit(0)
}

const prompt = args.filter((a) => !a.startsWith("-")).pop() || ""
const out = `FAKE_AGENT_OK prompt=${prompt.slice(0, 80)} mode=${mode}\n`
process.stdout.write(out)
if (process.env.FAKE_AGENT_PID_FILE) {
  fs.writeFileSync(process.env.FAKE_AGENT_PID_FILE, `${process.pid}\n`)
}
if (process.env.FAKE_AGENT_ARGV_LOG) {
  fs.writeFileSync(process.env.FAKE_AGENT_ARGV_LOG, `${JSON.stringify(args)}\n`)
}
if (process.env.FAKE_AGENT_LOG) {
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, out)
}
if (mode === "fail") process.exit(2)
if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 250))
if (mode === "medium") await new Promise((resolve) => setTimeout(resolve, 1_000))
if (mode === "very-slow") await new Promise((resolve) => setTimeout(resolve, 30_000))
process.exit(0)
