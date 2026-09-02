import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { restoreLatestSkillCollectionBackup } from "../../skills/workshop/collection-reconcile.js";
import { listSkillCollectionReviewOutcomes } from "../../skills/workshop/collection-review-state.js";
import { textResult } from "./tool-results.js";

const SKILL_COLLECTION_HISTORY_REASON_MAX_CHARS = 300;
const SKILL_COLLECTION_HISTORY_NAME_LIMIT = 10;
const SKILL_COLLECTION_HISTORY_TRUNCATION_MARKER = "\n(history truncated)";

function summarizeSkillNames(names: string[]) {
  const remaining = names.length - SKILL_COLLECTION_HISTORY_NAME_LIMIT;
  return {
    count: names.length,
    names: [
      ...names.slice(0, SKILL_COLLECTION_HISTORY_NAME_LIMIT),
      ...(remaining > 0 ? [`+${remaining} more`] : []),
    ],
  };
}

export async function executeSkillCollectionRestore(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}) {
  const result = await restoreLatestSkillCollectionBackup(params);
  return textResult(
    `Restored skill collection backup ${result.backupId}: restored ${result.restored.length}, removed ${result.removed.length}.`,
    result,
  );
}

export function executeSkillCollectionHistory(
  params: {
    workspaceDir: string;
    env?: NodeJS.ProcessEnv;
  },
  maxChars: number,
) {
  const outcomes = listSkillCollectionReviewOutcomes(params.env ? { env: params.env } : {});
  const reviews = [];
  let text = "Recent collection reviews, newest first:";
  let truncated = false;
  const textLimit = maxChars - SKILL_COLLECTION_HISTORY_TRUNCATION_MARKER.length;
  for (const outcome of outcomes) {
    const review = {
      createTime: new Date(outcome.createTime).toISOString(),
      backupId: outcome.backupId,
      kept: summarizeSkillNames(outcome.kept),
      written: summarizeSkillNames(outcome.written),
      dropped: outcome.dropped.map((entry) => ({
        name: entry.name,
        reason:
          entry.reason.length > SKILL_COLLECTION_HISTORY_REASON_MAX_CHARS
            ? `${truncateUtf16Safe(entry.reason, SKILL_COLLECTION_HISTORY_REASON_MAX_CHARS - 1)}…`
            : entry.reason,
      })),
    };
    const candidate = `${text}\n${JSON.stringify(review)}`;
    if (truncateUtf16Safe(candidate, textLimit) !== candidate) {
      truncated = true;
      break;
    }
    reviews.push(review);
    text = candidate;
  }
  if (truncated) {
    text = `${truncateUtf16Safe(text, textLimit)}${SKILL_COLLECTION_HISTORY_TRUNCATION_MARKER}`;
  }
  return textResult(outcomes.length === 0 ? "No recorded collection reviews." : text, {
    reviews,
    truncated,
  });
}
