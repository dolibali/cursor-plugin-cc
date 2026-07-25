---
name: cursor-result-handling
description: Internal guidance for presenting Cursor companion helper output back to the user
user-invocable: false
---

# Cursor Result Handling

When the helper returns Cursor companion output:
- Preserve the helper's status, summary, paths, and next steps structure.
- Use file paths exactly as the helper reports them.
- If Cursor made edits, say so explicitly and list touched files when the helper provides them.
- For `cursor:cursor-rescue`, do not turn a failed or incomplete Cursor run into a Claude-side implementation attempt. Report the failure and stop.
- For `cursor:cursor-rescue`, if Cursor was never successfully invoked, do not generate a substitute answer at all.
- If the helper reports malformed output or a failed Cursor run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/cursor:setup` and do not improvise alternate auth flows.
