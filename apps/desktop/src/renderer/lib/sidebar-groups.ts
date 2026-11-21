import type { BebotsBot, BebotsBotAvatar } from "../../shared/preload-api";
import type { ApiConversation } from "./api-types";

/**
 * One sidebar row per bot, with the bot's sessions nested underneath, newest
 * first. A conversation with several bot participants appears once under
 * every participant; human-only threads land in the trailing group.
 */
export interface SessionGroup {
  readonly botId: string;
  readonly name: string;
  /** Null for the unassigned (human-only) group. */
  readonly avatar: BebotsBotAvatar | null;
  readonly sessions: readonly ApiConversation[];
}

export const UNASSIGNED_GROUP_ID = "__unassigned__";
export const HUMAN_ONLY_GROUP_NAME = "Other sessions";

/**
 * Sidebar groups: bots ordered by their newest session (recency rank), each
 * with that bot's sessions newest-first. Multi-bot threads repeat under every
 * participant; human-only threads tail in a shared group.
 */
export function groupSidebarSessions(
  bots: readonly BebotsBot[],
  conversations: readonly ApiConversation[],
): readonly SessionGroup[] {
  const byBot = new Map<string, ApiConversation[]>();
  const orphans: ApiConversation[] = [];
  const chronological = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const conv of chronological) {
    const botIds = conv.participants.filter((p) => p !== "human");
    if (botIds.length === 0) orphans.push(conv);
    for (const botId of botIds) {
      const list = byBot.get(botId) ?? [];
      list.push(conv);
      byBot.set(botId, list);
    }
  }
  const groups: SessionGroup[] = bots.map((bot) => ({
    botId: bot.id,
    name: bot.name,
    avatar: bot.avatar,
    sessions: byBot.get(bot.id) ?? [],
  }));
  const newestAt = (g: SessionGroup) => g.sessions[0]?.updatedAt ?? 0;
  groups.sort((a, b) => {
    if (newestAt(a) !== newestAt(b)) return newestAt(b) - newestAt(a);
    return a.name.localeCompare(b.name);
  });
  if (orphans.length > 0) {
    groups.push({
      botId: UNASSIGNED_GROUP_ID,
      name: HUMAN_ONLY_GROUP_NAME,
      avatar: null,
      sessions: orphans,
    });
  }
  return groups;
}

/**
 * Sidebar filtering: a bot's name match keeps its whole group visible; a
 * session-title match shows that session within any group.
 */
export function filterSessionGroups(
  groups: readonly SessionGroup[],
  search: string,
): readonly SessionGroup[] {
  const query = search.trim().toLowerCase();
  if (!query) return [...groups];
  return groups
    .map((group) => ({
      group,
      matches: group.sessions.filter((c) => (c.title || c.id).toLowerCase().includes(query)),
    }))
    .filter(({ group, matches }) => group.name.toLowerCase().includes(query) || matches.length > 0)
    .map(({ group, matches }) => ({
      ...group,
      sessions: group.name.toLowerCase().includes(query) ? group.sessions : matches,
    }));
}
