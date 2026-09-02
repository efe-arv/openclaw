import type {
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../shared/async-work-scope.js";

const TERMINAL_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;

type QuestionDeliveryFinalizer = (statusLine: string) => void | Promise<void>;

type QuestionChannelEntry = {
  record: QuestionRecord;
  owner: AbortSignal | undefined;
  track: ReturnType<typeof captureAsyncWorkTracker>;
  terminal?: QuestionResolvedEvent;
  deliveries: Map<string, QuestionDeliveryFinalizer>;
  finalizedDeliveryIds: Set<string>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type QuestionChannelRuntime = {
  handleRequested: (record: QuestionRecord) => void;
  handleResolved: (event: QuestionResolvedEvent) => void;
  registerDelivery: (params: {
    questionId: string;
    deliveryId: string;
    finalize: QuestionDeliveryFinalizer;
  }) => void;
  retireGateway: (owner: AbortSignal) => void;
  clear: () => Promise<void>;
};

function collectAnsweredLabels(
  record: QuestionRecord,
  event: Extract<QuestionResolvedEvent, { status: "answered" }>,
): string[] {
  const answers = event.answers.answers;
  return record.questions.flatMap((question) => {
    // Only declared choices are safe to echo. Free-text answers can contain
    // secrets, mentions, or transport markup, and the label filter below drops
    // them; isOther alone must not suppress a declared selection.
    if (question.isSecret || question.options.length === 0) {
      return [];
    }
    const optionLabels = new Set(question.options.map((option) => option.label));
    return (answers[question.questionId] ?? []).filter((answer) => optionLabels.has(answer));
  });
}

function formatQuestionTerminalStatusLine(params: {
  record: QuestionRecord;
  event: QuestionResolvedEvent;
}): string {
  if (params.event.status === "expired") {
    return "Expired";
  }
  if (params.event.status === "cancelled") {
    return "Cancelled";
  }
  const labels = collectAnsweredLabels(params.record, params.event);
  return labels.length > 0 ? `Answered: ${labels.join(", ")}` : "Answered";
}

export function createQuestionChannelRuntime(
  options: {
    onFinalizeError?: (error: unknown, questionId: string, deliveryId: string) => void;
    terminalRetentionMs?: number;
  } = {},
): QuestionChannelRuntime {
  const entries = new Map<string, QuestionChannelEntry>();
  const retiredGateways = new WeakSet<AbortSignal>();
  let finalizers = new AsyncWorkScope();
  let clearing: Promise<void> | undefined;
  const terminalRetentionMs = options.terminalRetentionMs ?? TERMINAL_DELIVERY_RETENTION_MS;

  const finalizeDelivery = (
    questionId: string,
    entry: QuestionChannelEntry,
    deliveryId: string,
    finalize: QuestionDeliveryFinalizer,
  ) => {
    if (!entry.terminal || entry.finalizedDeliveryIds.has(deliveryId)) {
      return;
    }
    entry.deliveries.delete(deliveryId);
    entry.finalizedDeliveryIds.add(deliveryId);
    const statusLine = formatQuestionTerminalStatusLine({
      record: entry.record,
      event: entry.terminal,
    });
    // Global reset joins the original callback; descendants retain the requested
    // Gateway's tracker. A late plugin caller supplies no replacement lifetime.
    void finalizers
      .track(() => entry.track(() => runWithRetainedGatewayRootWork(() => finalize(statusLine))))
      .catch((error: unknown) => options.onFinalizeError?.(error, questionId, deliveryId));
  };

  const scheduleCleanup = (questionId: string, entry: QuestionChannelEntry) => {
    if (entry.cleanupTimer || entries.get(questionId) !== entry) {
      return;
    }
    entry.cleanupTimer = setTimeout(() => {
      if (entries.get(questionId) === entry) {
        entries.delete(questionId);
      }
    }, terminalRetentionMs);
    entry.cleanupTimer.unref?.();
  };

  return {
    handleRequested(record) {
      const owner = getAsyncWorkSignal();
      if (clearing || (owner && retiredGateways.has(owner))) {
        return;
      }
      // The host publishes Requested before delivery; callbacks cannot create
      // entries. A fresh accepted request may reuse an id after the manager's grace.
      clearTimeout(entries.get(record.id)?.cleanupTimer);
      entries.set(record.id, {
        record,
        owner,
        track: captureAsyncWorkTracker(),
        deliveries: new Map(),
        finalizedDeliveryIds: new Set(),
      });
    },
    handleResolved(event) {
      const entry = entries.get(event.id);
      if (!entry || entry.terminal) {
        return;
      }
      entry.terminal = event;
      for (const [deliveryId, finalize] of entry.deliveries) {
        finalizeDelivery(event.id, entry, deliveryId, finalize);
      }
      scheduleCleanup(event.id, entry);
    },
    registerDelivery({ questionId, deliveryId, finalize }) {
      const entry = entries.get(questionId);
      if (!entry || entry.finalizedDeliveryIds.has(deliveryId)) {
        return;
      }
      entry.deliveries.set(deliveryId, finalize);
      finalizeDelivery(questionId, entry, deliveryId, finalize);
    },
    retireGateway(owner) {
      // The Gateway calls this after joining received work and its finalizers,
      // not at beginClose: an admitted resolve can still finalize deliveries.
      retiredGateways.add(owner);
      for (const [id, entry] of entries) {
        if (entry.owner === owner) {
          clearTimeout(entry.cleanupTimer);
          entries.delete(id);
        }
      }
    },
    clear() {
      if (clearing) {
        return clearing;
      }
      for (const entry of entries.values()) {
        clearTimeout(entry.cleanupTimer);
      }
      entries.clear();
      clearing = finalizers.drain().then(() => {
        finalizers = new AsyncWorkScope();
        clearing = undefined;
      });
      return clearing;
    },
  };
}
