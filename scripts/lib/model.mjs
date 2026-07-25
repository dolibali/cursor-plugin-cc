import { loadGlobalConfig } from "./state.mjs"

/** Priority: CLI --model > CURSOR_COMPANION_MODEL > config.json model > unset */
export function resolveModel(cliModel, env = process.env) {
  if (cliModel != null && String(cliModel).trim()) {
    return { model: String(cliModel).trim(), source: "cli" }
  }
  if (env.CURSOR_COMPANION_MODEL && String(env.CURSOR_COMPANION_MODEL).trim()) {
    return { model: String(env.CURSOR_COMPANION_MODEL).trim(), source: "env" }
  }
  const config = loadGlobalConfig()
  if (config.model != null && String(config.model).trim()) {
    return { model: String(config.model).trim(), source: "config" }
  }
  return { model: null, source: "unset" }
}
