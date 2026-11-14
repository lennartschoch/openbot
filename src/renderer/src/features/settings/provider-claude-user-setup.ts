import type { ClaudeUserSetupSetting, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import type { ProviderClaudeUserSetup } from "@openbot/ui/features/settings/ProviderSettingsPage";
import { useText } from "@openbot/ui/text";
import { createHostSetting } from "./host-setting-state";

/** The "Use my Claude Code setup" calls of one server's host. The desktop reaches them through main. */
export type HostClaudeUserSetupCalls = Pick<
  OpenBotDesktopApi["hostAdmin"],
  "getClaudeUserSetup" | "setClaudeUserSetup"
>;

export interface HostClaudeUserSetupOptions {
  /** The calls of a client with no `window.openbot`, such as the web client. */
  calls?: HostClaudeUserSetupCalls;
}

export interface ProviderClaudeUserSetupSource extends HostClaudeUserSetupOptions {
  serverId: string;
  /** A joined server: the setup is the one of the host's user, on the host. */
  remote: boolean;
}

/** The calls and the load-failure text of one Claude switch of the Claude page. */
export interface ProviderClaudeSwitchApi {
  get: (source: ProviderClaudeUserSetupSource | undefined, serverId: string) => Promise<ClaudeUserSetupSetting>;
  set: (
    enabled: boolean,
    source: ProviderClaudeUserSetupSource | undefined,
    serverId: string,
  ) => Promise<ClaudeUserSetupSetting>;
  loadFailedKey: "provider.settings.claudeUserSetupLoadFailed" | "provider.settings.claudeUserMcpLoadFailed";
}

/** "Use my Claude Code setup": the user settings, CLAUDE.md, skills, agents, hooks and plugins. */
export const CLAUDE_USER_SETUP_SWITCH: ProviderClaudeSwitchApi = {
  get: (source, serverId) => (source?.calls ?? window.openbot.hostAdmin).getClaudeUserSetup(serverId),
  set: (enabled, source, serverId) => (source?.calls ?? window.openbot.hostAdmin).setClaudeUserSetup(enabled, serverId),
  loadFailedKey: "provider.settings.claudeUserSetupLoadFailed",
};

/**
 * "Load my Claude Code MCP servers": the claude.ai connectors and the user's own MCP servers.
 * This computer only: a joined server has no route for it, so the calls ignore `serverId`.
 */
export const CLAUDE_USER_MCP_SWITCH: ProviderClaudeSwitchApi = {
  get: () => window.openbot.getClaudeUserMcp(),
  set: (enabled) => window.openbot.setClaudeUserMcp(enabled),
  loadFailedKey: "provider.settings.claudeUserMcpLoadFailed",
};

/**
 * One switch of the Claude page's Claude Code section, of this computer or a joined server
 * (`claude-user-setup-v1`). The host checks the role again. Undefined while `source` is.
 *
 * Each new value of `status` reads the setting again: the host sends a status event after a change.
 */
export function createProviderClaudeUserSetup(
  source: () => ProviderClaudeUserSetupSource | undefined,
  status: () => unknown,
  api: ProviderClaudeSwitchApi = CLAUDE_USER_SETUP_SWITCH,
): () => ProviderClaudeUserSetup | undefined {
  const { t } = useText();
  const setting = createHostSetting<boolean, boolean>({
    serverId: () => source()?.serverId,
    status,
    read: async (serverId) => (await api.get(source(), serverId)).enabled,
    save: async (enabled, serverId) => (await api.set(enabled, source(), serverId)).enabled,
    loadFailed: () => t(api.loadFailedKey),
  });
  const setup: ProviderClaudeUserSetup = {
    get value() {
      return setting.state.value;
    },
    get pending() {
      return setting.state.pending;
    },
    get error() {
      return setting.state.error;
    },
    get remote() {
      return source()?.remote === true;
    },
    onChange: (next) => void setting.choose(next),
  };
  return () => (source() ? setup : undefined);
}
