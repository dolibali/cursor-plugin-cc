export function renderSetupReport(payload) {
  const lines = [
    "# Cursor companion setup",
    "",
    `- agent: ${payload.agent?.available ? payload.agent.bin : "missing"} (${payload.agent?.detail ?? ""})`,
    `- auth: ${payload.auth?.loggedIn ? "ok" : "needs login"}`,
    `- sandbox: ${payload.sandboxSupported ? "supported" : "unsupported"}`,
    `- model: ${payload.model?.model ?? "(unset → Cursor CLI default/auto)"} [source=${payload.model?.source}]`,
    `- companionScript: ${payload.companionScript ?? ""}`,
    `- config: ${payload.configPath ?? ""}`,
  ]
  if (!payload.agent?.available) {
    lines.push("", "Install Cursor Agent CLI and ensure `agent` or `cursor-agent` is on PATH.")
  } else if (!payload.auth?.loggedIn) {
    lines.push("", "Run: agent login")
  } else if (!payload.sandboxSupported) {
    lines.push("", "Upgrade Cursor Agent CLI to a version that supports `--sandbox`.")
  } else {
    lines.push("", "Ready.")
  }
  return `${lines.join("\n")}\n`
}

export function renderTaskResult(job) {
  const lines = [
    `# Cursor task ${job.id}`,
    "",
    `- status: ${job.status}`,
    `- workspace: ${job.workspace}`,
    ...(job.workspaceRoots?.length > 1
      ? job.workspaceRoots.slice(1).map((root) => `- addDir: ${root}`)
      : []),
    `- model: ${job.model ?? "(unset)"}`,
    `- mode: ${job.mode ?? "simple"}`,
    `- sandbox: ${job.sandbox ?? "enabled"}`,
    `- hostAccess: ${job.hostAccess ?? "workspace"}`,
  ]
  if (job.exitCode != null) lines.push(`- exitCode: ${job.exitCode}`)
  if (job.logFile) lines.push(`- log: ${job.logFile}`)
  if (job.resultFile) lines.push(`- resultFile: ${job.resultFile}`)
  if (job.stdoutPreview) {
    lines.push("", "## Output", "", job.stdoutPreview)
  }
  if (job.error) {
    lines.push("", "## Error", "", job.error)
  }
  return `${lines.join("\n")}\n`
}

export function renderStatusReport(jobs) {
  if (!jobs.length) return "No cursor-companion jobs for this workspace.\n"
  const lines = ["# Cursor companion jobs", ""]
  for (const job of jobs) {
    lines.push(`- ${job.id}  ${job.status}  model=${job.model ?? "unset"}  ${job.workspace}`)
  }
  return `${lines.join("\n")}\n`
}

export function renderCancelReport(job) {
  return `# Cancelled ${job.id}\n\n- status: ${job.status}\n`
}
