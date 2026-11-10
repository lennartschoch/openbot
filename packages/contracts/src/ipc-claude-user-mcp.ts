/**
 * Whether the Claude agents of this computer load the MCP servers of the user's own Claude Code: the
 * claude.ai connectors of the signed-in account (such as Gmail and Slack), the user and project MCP
 * files, and the servers of the plugins that load. On, Claude starts without `strictMcpConfig`, so
 * these servers come in addition to the servers of OpenBot's MCP panel. Off, the MCP panel is the
 * only source, so two computers with the same OpenBot settings give an agent the same tools.
 */

import { isBoolean, isDynamicRecord } from "./runtime-values";

export interface ClaudeUserMcpSetting {
  enabled: boolean;
}

/** Off, so that the MCP panel stays the only source. A file exists only after the user changed the switch. */
export const DEFAULT_CLAUDE_USER_MCP: ClaudeUserMcpSetting = { enabled: false };

export function decodeClaudeUserMcpSetting(value: unknown): ClaudeUserMcpSetting {
  if (!isDynamicRecord(value) || !isBoolean(value.enabled)) throw new Error("Invalid Claude MCP setting.");
  return { enabled: value.enabled };
}
