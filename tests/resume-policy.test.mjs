import assert from "node:assert/strict"
import test from "node:test"

import { resumePolicyFromResult } from "../plugins/cursor/scripts/lib/resume.mjs"

function safeResult(overrides = {}) {
  return {
    reasons: [],
    validation: { valid: true },
    source: { unsafeChangedSymlinks: [] },
    workspaceGuard: { violations: [], blockedAttempts: 0 },
    recursionGuard: { blockedAttempts: 0 },
    executionGuard: { blockedDetachedAttempts: 0 },
    ...overrides,
  }
}

test("allows ordinary PASS, FAIL, BLOCKED, and PARTIAL E2E results to resume", () => {
  for (const overall of ["PASS", "FAIL", "BLOCKED", "PARTIAL"]) {
    assert.deepEqual(resumePolicyFromResult(safeResult({ overall })), {
      allowed: true,
      blockedReasons: [],
    })
  }
})

test("rejects every security and result-integrity resume boundary", () => {
  const cases = [
    [safeResult({ reasons: ["PROHIBITED_GIT_STATE_CHANGE"] }), "PROHIBITED_GIT_STATE_CHANGE"],
    [safeResult({ reasons: ["PROHIBITED_GIT_OPERATION"] }), "PROHIBITED_GIT_OPERATION"],
    [safeResult({ reasons: ["UNSAFE_CHANGED_SYMLINK"] }), "UNSAFE_CHANGED_SYMLINK"],
    [safeResult({ reasons: ["RECURSIVE_DELEGATION_TOOL_CALL"] }), "RECURSIVE_DELEGATION_TOOL_CALL"],
    [safeResult({ reasons: ["PROHIBITED_DETACHED_PROCESS"] }), "PROHIBITED_DETACHED_PROCESS"],
    [safeResult({ reasons: ["RESULT_INVALID"] }), "RESULT_INVALID"],
    [safeResult({ reasons: ["REPAIR_STATUS_MISMATCH"] }), "REPAIR_STATUS_MISMATCH"],
    [safeResult({ validation: { valid: false } }), "RESULT_INVALID"],
    [safeResult({ source: { unsafeChangedSymlinks: ["escape"] } }), "UNSAFE_CHANGED_SYMLINK"],
    [safeResult({ workspaceGuard: { violations: ["HEAD_CHANGED"], blockedAttempts: 0 } }), "PROHIBITED_GIT_STATE_CHANGE"],
    [safeResult({ workspaceGuard: { violations: [], blockedAttempts: 1 } }), "PROHIBITED_GIT_OPERATION"],
    [safeResult({ recursionGuard: { blockedAttempts: 1 } }), "RECURSIVE_DELEGATION"],
    [safeResult({ executionGuard: { blockedDetachedAttempts: 1 } }), "PROHIBITED_DETACHED_PROCESS"],
  ]
  for (const [result, expectedReason] of cases) {
    const policy = resumePolicyFromResult(result)
    assert.equal(policy.allowed, false)
    assert.ok(policy.blockedReasons.includes(expectedReason))
  }
})
