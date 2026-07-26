# Agent CLI model slugs

Authoritative list from the local CLI:

```bash
agent --list-models
# or
agent models
```

The table below is a convenience map only; available models depend on the account. Prefer `--list-models` when unsure.

## Default

| User phrasing | Slug |
|---|---|
| Default | omit `--model` (global config defaults to `auto`) |
| Grok / Grok 4.5 / High Fast / Cursor Grok 4.5 High Fast | `cursor-grok-4.5-high-fast` |

## Common alternatives

| User phrasing | Slug |
|---|---|
| Auto | `auto` |
| Cursor Grok 4.5 (non-Fast) | `cursor-grok-4.5-high` |
| Grok Low / Medium | `cursor-grok-4.5-low-fast` / `cursor-grok-4.5-medium-fast` |
| Composer 2.5 | `composer-2.5` / `composer-2.5-fast` |
| Opus 4.8 Thinking | `claude-opus-4-8-thinking-high` / `claude-opus-4-8-thinking-high-fast` |
| Sonnet 5 Thinking | `claude-sonnet-5-thinking-high` |
| GPT-5.6 Sol High | `gpt-5.6-sol-high` / `gpt-5.6-sol-high-fast` |

## Rules

1. Leave `--model` unset in task commands to use the effective selection. Fresh installations store `auto`; CLI and environment overrides still take priority.
2. When the user gives a display name, match it to a slug from `--list-models` before passing `--model`.
3. Parameterized models may use brackets when the CLI supports them, e.g. `'claude-opus-4-8[context=1m,effort=high,fast=false]'`. Do not invent parameters; use listed slugs when unsure.
