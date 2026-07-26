import { readJobFile, upsertJob } from "./state.mjs"

function nowIso() {
  return new Date().toISOString()
}

export async function runTrackedJob(workspace, jobId, runner, options = {}) {
  const queued = readJobFile(workspace, jobId)
  if (!queued) throw new Error(`Job request not found: ${jobId}`)
  if (queued.status === "cancelled") return queued

  const running = upsertJob(workspace, {
    ...queued,
    status: "running",
    phase: "running",
    pid: options.pid ?? null,
    startedAt: queued.startedAt ?? nowIso(),
  })

  try {
    const execution = await runner(running)
    const latest = readJobFile(workspace, jobId)
    if (latest?.status === "cancelled") return latest
    const status = execution.timedOut
      ? "timeout"
      : execution.exitCode === 0
        ? "completed"
        : "failed"
    return upsertJob(workspace, {
      ...running,
      ...execution,
      status,
      phase: status,
      pid: null,
      finishedAt: nowIso(),
    })
  } catch (error) {
    const latest = readJobFile(workspace, jobId) ?? running
    if (latest.status === "cancelled") return latest
    return upsertJob(workspace, {
      ...latest,
      status: "failed",
      phase: "failed",
      pid: null,
      error: error instanceof Error ? error.message : String(error),
      finishedAt: nowIso(),
    })
  }
}
