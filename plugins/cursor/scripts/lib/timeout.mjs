import { performance } from "node:perf_hooks"

import { loadGlobalConfig } from "./state.mjs"

export const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function parseTimeoutMs(value, optionName = "timeoutMs") {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive safe integer`)
  }
  return parsed
}

export function resolveTimeout(cliValue, env = process.env, config = loadGlobalConfig()) {
  if (cliValue != null) {
    return { timeoutMs: parseTimeoutMs(cliValue, "--timeout-ms"), source: "cli" }
  }
  if (env.CURSOR_COMPANION_TIMEOUT_MS != null && env.CURSOR_COMPANION_TIMEOUT_MS !== "") {
    return {
      timeoutMs: parseTimeoutMs(env.CURSOR_COMPANION_TIMEOUT_MS, "CURSOR_COMPANION_TIMEOUT_MS"),
      source: "env",
    }
  }
  if (config.timeoutMs != null) {
    return { timeoutMs: parseTimeoutMs(config.timeoutMs, "config.json timeoutMs"), source: "config" }
  }
  return { timeoutMs: DEFAULT_TIMEOUT_MS, source: "default" }
}

export function addTimeoutGrace(timeoutMs, graceMs) {
  return Math.min(Number.MAX_SAFE_INTEGER, timeoutMs + graceMs)
}

export function scheduleLongTimeout(
  callback,
  timeoutMs,
  {
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const durationMs = parseTimeoutMs(timeoutMs)
  const startedAt = now()
  let timer = null
  let cancelled = false

  const scheduleNext = () => {
    if (cancelled) return
    const remainingMs = durationMs - Math.max(0, now() - startedAt)
    if (remainingMs <= 0) {
      callback()
      return
    }
    timer = setTimer(scheduleNext, Math.min(remainingMs, MAX_TIMER_DELAY_MS))
  }

  scheduleNext()
  return () => {
    cancelled = true
    if (timer != null) clearTimer(timer)
  }
}
