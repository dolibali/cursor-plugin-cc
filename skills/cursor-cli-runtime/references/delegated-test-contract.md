# Delegated Test Contract

Use this contract when a parent Agent delegates validation and autonomous GUI repair to Cursor CLI. Feature-specific checks, fixtures, commands, and locators belong in the task prompt.

- the parent freezes the current Git worktree;
- the Worker may edit production code, tests, fixtures, and test infrastructure inside that workspace;
- the Worker diagnoses, repairs, runs the smallest affected baseline checks, and reruns GUI checks until all required checks pass or an escalation boundary is reached;
- repair iteration count is unlimited.

The Worker may make no changes when validation already passes. It must not commit, push, reset, checkout, switch, restore, clean, rebase, stash, stage changes, perform destructive Git operations, or edit another repository.

## Runner

```bash
node "$COMPANION" task --mode e2e   # or: node <repo>/scripts/run-delegated-test.mjs \
  --workspace <absolute-git-workspace> \
  --prompt-file <absolute-task-prompt> \
  --artifact-dir <absolute-directory-outside-workspace> \
  --required-check <stable-check-id>
```

Repeat `--required-check` and `--optional-check` to define the authoritative checklist.

Defaults:

- model: unset by default (Cursor CLI `auto`); override with `--model` / env / config;
- total timeout: 3 hours;
- no-meaningful-progress timeout: 30 minutes;
- declared long-command maximum: 30 minutes;
- artifact heartbeat: 30 seconds;
- recursion process-tree scan: 10 seconds.

The artifact directory must be outside the Git workspace.

## Parent session

The parent starts the Runner with one blocking shell call (for example Codex `shell_command`) and waits until the process exits. Set the tool `timeout_ms` to at least the Runner total timeout ceiling (default **10800000** ms = 3 hours). Do not use short-yield `exec_command` plus empty `write_stdin` polling to continue waiting.

Stop semantics:

- The parent does **not** always wait the full 3 hours. That value is only the ceiling.
- When the Runner/Cursor finishes early (`PASS`, `FAIL`, `BLOCKED`, no meaningful progress, long-command timeout, recursion escalation, and similar), the child exits and the parent resumes immediately.
- Only a run that hits the ceiling is cut at about 3 hours by the Runner or the parent tool timeout.
- Artifact heartbeats do **not** wake the parent model. The parent continues only after the child process returns.

While waiting, the parent must not read heartbeat files, progress JSONL, stream logs, or screenshot directories, and must not poll with short timeouts. After exit, read only `<artifact-dir>/run-result.json` by default; open additional contract summary fields only when diagnosing failure. A single tool await idle-wait does not consume parent LLM tokens; repeated poll turns do.

## Meaningful Progress

The Worker appends JSONL to `DELEGATED_TEST_PROGRESS_FILE`.

```json
{"type":"meaningful-progress","kind":"evidence","summary":"New observable failure evidence"}
{"type":"meaningful-progress","kind":"hypothesis","summary":"Evidence-backed root cause"}
{"type":"meaningful-progress","kind":"repair","summary":"Implemented a scoped repair"}
{"type":"meaningful-progress","kind":"check-progress","summary":"A required check advanced"}
{"type":"meaningful-progress","kind":"phase-complete","summary":"Build or validation phase completed"}
{"type":"long-command","state":"start","command":"bun run package","expectedMaxMs":1800000}
{"type":"long-command","state":"finish"}
```

Heartbeat, repeated logs, unchanged retries, unsupported timeout increases, weakened assertions, and plans without evidence do not refresh meaningful progress.

The Runner escalates after 30 minutes without meaningful progress when no declared long command is active. A declared command cannot exceed 30 minutes. The entire run cannot exceed 3 hours.

## Recursion Guard

The Runner creates exactly one Cursor Worker and injects:

- `CURSOR_DELEGATED_WORKER=1`;
- `CURSOR_DELEGATION_DEPTH=1`;
- `CURSOR_DELEGATION_RUN_ID`;
- an artifact-local PATH guard.

A delegated Worker must execute the task directly. It must not invoke `agent`, `cursor-agent`, Cursor SDK, or this Runner, even when a loaded skill suggests delegation.

The Runner:

- rejects startup when inherited depth is already at least one;
- intercepts ordinary nested Agent commands through PATH;
- scans the root Worker's descendants every 10 seconds;
- terminates an Agent executable launched through an absolute path;
- allows the root Worker to continue after one blocked attempt;
- stops and escalates after repeated recursion attempts.

Electron, Extension Host, Playwright, shell commands, and ordinary processes whose names merely contain `agent` are not nested Cursor Workers.

The same artifact-local PATH layer forwards read-only Git commands but blocks destructive subcommands. The Runner also compares `HEAD`, the index, and `refs/stash` before and after the Worker so an absolute-path Git invocation cannot silently change repository metadata. A blocked destructive command escalates; a metadata change fails integrity validation and is preserved for parent inspection.

## Failure class: product vs environment

Every failed or blocked check should be classified so the parent does not repair the wrong thing.

| Class | Typical causes | Parent / Worker action |
|---|---|---|
| `product` | Assertion failed, wrong VSIX/extension identity, control/state missing after a ready runtime, deterministic product timeout | Worker may fix code/tests/fixtures and re-run affected checks |
| `infrastructure` | Auth/session expired, network or model service down, no graphical desktop, missing worktree, preflight identity not ready | Do not change product code to "fix" it; report and stop or ask the user |

Guidance:

- Waiting for an expected UI control after the intended runtime is ready is usually `product`.
- Connection refused, unauthorized, invalid credentials, or service unavailable is usually `infrastructure`.
- Put the class on each check and/or on `run-result.json` reasons (for example `INFRA_...` prefixes). `BLOCKED` alone is not enough when environment and product are mixed.

## Repair And Escalation

Ordinary product bugs, styles, state handling, tests, fixtures, locators, builds, and isolated runtime setup stay with the Worker. Infrastructure failures are not repair targets.

Escalate only when:

- product semantics or acceptance criteria require a decision;
- public protocol, persistence, migration, dependency, security, destructive data, or cross-repository changes are required;
- no meaningful progress occurs for 30 minutes;
- a required command exceeds 30 minutes and cannot recover;
- the total run reaches 3 hours;
- repeated recursive delegation is attempted.

Source changes are allowed only when every required check and the affected baseline checks pass. Otherwise report `ESCALATION_REQUIRED`; never claim a complete pass.

## Result Contract

The Worker atomically writes `<artifact-dir>/agent-result.json` with:

- `schemaVersion`, `summary`, `checks`;
- `cleanup`;
- `artifacts`;
- `blockers`.

```json
{
  "repair": {
    "status": "APPLIED_AND_VERIFIED",
    "iterations": [
      {
        "evidence": "observable failure",
        "hypothesis": "root cause",
        "changedFiles": ["path/to/file"],
        "verification": ["command and result"]
      }
    ]
  },
  "progress": {
    "lastMeaningfulProgressAt": "2026-01-01T00:00:00.000Z",
    "elapsedMs": 1000
  },
  "recursionGuard": {
    "depth": 1,
    "blockedAttempts": 0
  },
  "escalation": null
}
```

Valid repair statuses are `NONE`, `APPLIED_AND_VERIFIED`, and `ESCALATION_REQUIRED`.

The Runner derives the authoritative `overall` status. Cursor prose does not override checks, cleanup, process exit, recursion guard, Git workspace guard, fingerprints, or result validation.
When Cursor emits usage counters, `run-result.json` also records input, output, cache-read, and cache-write tokens so delegated cost can be measured without reading the raw stream.

## Artifacts And Parent Review

The Runner writes:

- `delegation.json`;
- `events.jsonl`, `stdout.log`, and `stderr.log`;
- `progress.jsonl` and `worker-progress.jsonl`;
- `recursion-attempts.log` and `git-guard-attempts.log`;
- `agent-result.json` and authoritative `run-result.json`;
- `attempted-repair.patch` when source changes occur.

The parent reads `run-result.json` first. Full stream and heartbeat output stay on disk. Read referenced logs only when the result is not a clean PASS or requests a major decision.

Overall statuses retain their existing meanings:

- `PASS`: all required checks and cleanup passed; repairs, if any, were verified;
- `FAIL`: a required product assertion failed or result integrity was violated (`product`);
- `BLOCKED`: environment, readiness, recursion, missing result, or similar prevented completion — prefer labeling infrastructure causes explicitly so the parent does not start a code-fix loop;
- `PARTIAL`: meaningful evidence exists but required checks or cleanup remain incomplete.

The parent reads `overall` first, then failure class:

- `FAIL` / product blockers → may continue diagnosis or a new delegated repair run;
- infrastructure `BLOCKED` / incomplete validation → tell the user what environment step is missing; do not treat it as a product regression.
