// Local change (2026-10-21): background subagents still at work, for the waiting dog above the prompt.
declare module 'claude-code' {
  interface PluginState {
    fm: {
      bgAgents: number
    }
  }
}
