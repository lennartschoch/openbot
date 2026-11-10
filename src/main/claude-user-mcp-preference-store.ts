import { type ClaudeUserMcpSetting, DEFAULT_CLAUDE_USER_MCP } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/**
 * Whether the Claude agents of this computer load the MCP servers of the user's own Claude Code. A
 * Claude process reads it when it starts, so a change applies to the next process, not to a running
 * turn. A file without the switch reads as the default, off.
 */
export type ClaudeUserMcpPreferenceStore = PreferenceStore<ClaudeUserMcpSetting>;

export function createClaudeUserMcpPreferenceStore(path: string): ClaudeUserMcpPreferenceStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_CLAUDE_USER_MCP,
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && isBoolean(parsed.enabled) ? { enabled: parsed.enabled } : null,
  });
}
