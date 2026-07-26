import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveWorkspaceRoot } from "./workspace.mjs"

const STATE_VERSION = 1
const MAX_JOBS = 50
const STATE_FILE_NAME = "state.json"
const JOBS_DIR_NAME = "jobs"
const CONFIG_FILE_NAME = "config.json"

export function companionHomeDir() {
  return path.join(os.homedir(), ".cursor", "cursor-companion")
}

export function resolveGlobalConfigPath() {
  return path.join(companionHomeDir(), CONFIG_FILE_NAME)
}

export function loadGlobalConfig() {
  const file = resolveGlobalConfigPath()
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

export function saveGlobalConfig(config) {
  fs.mkdirSync(companionHomeDir(), { recursive: true })
  writeJsonAtomic(resolveGlobalConfigPath(), config)
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd)
  let canonical = workspaceRoot
  try {
    canonical = fs.realpathSync.native(workspaceRoot)
  } catch {
    canonical = workspaceRoot
  }
  const slugSource = path.basename(workspaceRoot) || "workspace"
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace"
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16)
  return path.join(companionHomeDir(), `${slug}-${hash}`)
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME)
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME)
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true })
}

function defaultState() {
  return { version: STATE_VERSION, jobs: [] }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd)
  if (!fs.existsSync(stateFile)) return defaultState()
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    return { ...defaultState(), ...parsed, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] }
  } catch {
    return defaultState()
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS)
}

export function saveState(cwd, state) {
  ensureStateDir(cwd)
  const next = { version: STATE_VERSION, jobs: pruneJobs(state.jobs ?? []) }
  writeJsonAtomic(resolveStateFile(cwd), next)
  return next
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd)
  mutate(state)
  return saveState(cwd, state)
}

export function generateJobId() {
  return randomUUID()
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`)
}

export function writeJobFile(cwd, job) {
  ensureStateDir(cwd)
  writeJsonAtomic(resolveJobFile(cwd, job.id), job)
}

export function readJobFile(cwd, jobId) {
  const file = resolveJobFile(cwd, jobId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export function upsertJob(cwd, job) {
  const now = new Date().toISOString()
  const existing = readJobFile(cwd, job.id) ?? {}
  const nextJob = { ...existing, ...job, updatedAt: now, createdAt: job.createdAt ?? existing.createdAt ?? now }
  writeJobFile(cwd, nextJob)
  return nextJob
}

export function listJobs(cwd) {
  const legacy = loadState(cwd).jobs
  const byId = new Map(legacy.map((job) => [job.id, job]))
  const jobsDir = resolveJobsDir(cwd)
  if (fs.existsSync(jobsDir)) {
    for (const entry of fs.readdirSync(jobsDir)) {
      if (!entry.endsWith(".json")) continue
      const job = readJobFile(cwd, entry.slice(0, -5))
      if (job?.id) byId.set(job.id, job)
    }
  }
  return pruneJobs([...byId.values()])
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  fs.renameSync(temporary, file)
}
