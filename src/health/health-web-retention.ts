import {
  ensureRecordField,
  normalizeRetentionPolicy,
  parseBooleanQuery,
  parseBoundedIntQuery,
  resolveKthxConfigPath,
  type RetentionPolicyView,
} from "./health-web-shared.js";
import { readJsonRecord } from "./health-web-runtime-pipeline.js";

export const readKthxConfig = async (
  stateDir: string,
): Promise<{
  configPath: string;
  configRaw: Record<string, unknown>;
  retention: RetentionPolicyView | null;
}> => {
  const configPath = resolveKthxConfigPath(stateDir);
  const configRaw = (await readJsonRecord(configPath)) ?? {};
  return {
    configPath,
    configRaw,
    retention: normalizeRetentionPolicy(configRaw),
  };
};

export const applyRetentionPatchFromQuery = (
  configRaw: Record<string, unknown>,
  query: URLSearchParams,
): { changed: boolean; retention: RetentionPolicyView | null } => {
  const memory = ensureRecordField(configRaw, "memory");
  const retention = ensureRecordField(memory, "retention");
  const longTerm = ensureRecordField(retention, "longTerm");
  let changed = false;
  const assign = (
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ): void => {
    if (target[key] === value) return;
    target[key] = value;
    changed = true;
  };
  const assignDaysCategory = (category: string, days: number): void => {
    const categoryRecord = ensureRecordField(retention, category);
    if (categoryRecord.days !== days) {
      categoryRecord.days = days;
      changed = true;
    }
  };

  const enabled = parseBooleanQuery(query.get("enabled"));
  if (enabled !== null) assign(retention, "enabled", enabled);

  const intervalMinutes = parseBoundedIntQuery(
    query.get("intervalMinutes"),
    10,
    1440,
  );
  if (intervalMinutes !== null) assign(retention, "intervalMinutes", intervalMinutes);

  const allDays = parseBoundedIntQuery(query.get("days"), 1, 3650);
  if (allDays !== null) {
    for (const category of [
      "commands",
      "moods",
      "posts",
      "interactions",
      "notifications",
      "system",
    ]) {
      assignDaysCategory(category, allDays);
    }
  }

  const dayParams: Array<[string, string]> = [
    ["commandsDays", "commands"],
    ["moodsDays", "moods"],
    ["postsDays", "posts"],
    ["interactionsDays", "interactions"],
    ["notificationsDays", "notifications"],
    ["systemDays", "system"],
  ];
  for (const [queryKey, category] of dayParams) {
    const parsed = parseBoundedIntQuery(query.get(queryKey), 1, 3650);
    if (parsed === null) continue;
    assignDaysCategory(category, parsed);
  }

  const longTermEnabled = parseBooleanQuery(query.get("longTermEnabled"));
  if (longTermEnabled !== null) assign(longTerm, "enabled", longTermEnabled);
  const longTermUseAgentCompression = parseBooleanQuery(
    query.get("longTermUseAgentCompression"),
  );
  if (longTermUseAgentCompression !== null) {
    assign(longTerm, "useAgentCompression", longTermUseAgentCompression);
  }

  const longTermMaxCapsules = parseBoundedIntQuery(
    query.get("longTermMaxCapsules"),
    1000,
    2_000_000,
  );
  if (longTermMaxCapsules !== null) {
    assign(longTerm, "maxCapsules", longTermMaxCapsules);
  }
  const longTermMaxCompactionsPerRun = parseBoundedIntQuery(
    query.get("longTermMaxCompactionsPerRun"),
    1,
    100,
  );
  if (longTermMaxCompactionsPerRun !== null) {
    assign(longTerm, "maxCompactionsPerRun", longTermMaxCompactionsPerRun);
  }
  const longTermMaxEventsPerArchive = parseBoundedIntQuery(
    query.get("longTermMaxEventsPerArchive"),
    20,
    2000,
  );
  if (longTermMaxEventsPerArchive !== null) {
    assign(longTerm, "maxEventsPerArchive", longTermMaxEventsPerArchive);
  }
  const longTermMaxSnippetsPerArchive = parseBoundedIntQuery(
    query.get("longTermMaxSnippetsPerArchive"),
    1,
    24,
  );
  if (longTermMaxSnippetsPerArchive !== null) {
    assign(longTerm, "maxSnippetsPerArchive", longTermMaxSnippetsPerArchive);
  }

  return { changed, retention: normalizeRetentionPolicy(configRaw) };
};
