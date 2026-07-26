import assert from "node:assert/strict"
import test from "node:test"

import {
  addTimeoutGrace,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  parseTimeoutMs,
  resolveTimeout,
  scheduleLongTimeout,
} from "../plugins/cursor/scripts/lib/timeout.mjs"

test("timeout resolution follows cli, environment, config, then default precedence", () => {
  assert.deepEqual(resolveTimeout(null, {}, {}), {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    source: "default",
  })
  assert.deepEqual(resolveTimeout(null, {}, { timeoutMs: 14_400_000 }), {
    timeoutMs: 14_400_000,
    source: "config",
  })
  assert.deepEqual(
    resolveTimeout(null, { CURSOR_COMPANION_TIMEOUT_MS: "7" }, { timeoutMs: 8 }),
    { timeoutMs: 7, source: "env" },
  )
  assert.deepEqual(
    resolveTimeout("6", { CURSOR_COMPANION_TIMEOUT_MS: "7" }, { timeoutMs: 8 }),
    { timeoutMs: 6, source: "cli" },
  )
})

test("timeout values must be positive safe integers", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "not-a-number"]) {
    assert.throws(() => parseTimeoutMs(value), /positive safe integer/)
  }
  assert.equal(parseTimeoutMs(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
})

test("timeout grace saturates instead of overflowing the safe integer range", () => {
  assert.equal(addTimeoutGrace(1_000, 2_000), 3_000)
  assert.equal(addTimeoutGrace(Number.MAX_SAFE_INTEGER - 1, 2_000), Number.MAX_SAFE_INTEGER)
})

test("long timeout scheduler chunks delays above the Node timer limit", () => {
  let now = 0
  let callbackCount = 0
  let timerId = 0
  const scheduled = new Map()
  const delays = []
  const cancel = scheduleLongTimeout(
    () => {
      callbackCount += 1
    },
    MAX_TIMER_DELAY_MS + 50,
    {
      now: () => now,
      setTimer(callback, delay) {
        timerId += 1
        scheduled.set(timerId, callback)
        delays.push(delay)
        return timerId
      },
      clearTimer(id) {
        scheduled.delete(id)
      },
    },
  )

  assert.deepEqual(delays, [MAX_TIMER_DELAY_MS])
  now = MAX_TIMER_DELAY_MS
  scheduled.get(1)()
  assert.deepEqual(delays, [MAX_TIMER_DELAY_MS, 50])
  assert.equal(callbackCount, 0)

  now += 50
  scheduled.get(2)()
  assert.equal(callbackCount, 1)
  cancel()
})
