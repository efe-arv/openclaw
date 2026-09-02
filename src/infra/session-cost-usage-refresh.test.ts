import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { testing as testApi } from "./session-cost-usage.test-support.js";

describe("session cost usage refresh", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await testApi.clearUsageCostRefreshesForTest();
  });

  afterEach(async () => {
    await testApi.clearUsageCostRefreshesForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("doubles consecutive busy delays, caps them, and resets after success", async () => {
    let calls = 0;
    const refresh = vi
      .spyOn(testApi.usageCostRefreshRuntime, "refreshCostUsageCacheForAgent")
      .mockImplementation(async () => {
        calls += 1;
        if (calls <= 10) {
          return "busy";
        }
        if (calls === 11) {
          testApi.requestCostUsageCacheRefresh({
            agentId: "backoff-test",
            sessionFiles: ["next-session.jsonl"],
          });
          return "refreshed";
        }
        if (calls === 12) {
          return "busy";
        }
        return "refreshed";
      });

    testApi.requestCostUsageCacheRefresh({ agentId: "backoff-test" });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    for (const [delayMs, expectedCalls] of [
      [50, 2],
      [100, 3],
      [200, 4],
      [400, 5],
      [800, 6],
      [1_600, 7],
      [3_200, 8],
      [5_000, 9],
      [5_000, 10],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(refresh).toHaveBeenCalledTimes(expectedCalls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(expectedCalls);
    }

    await vi.advanceTimersByTimeAsync(4_999);
    expect(refresh).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(12);

    await vi.advanceTimersByTimeAsync(49);
    expect(refresh).toHaveBeenCalledTimes(12);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(13);
  });

  it.each(["scope drain", "unscoped busy reset"] as const)(
    "keeps %s pending until the original refresh settles without leaving a retry",
    async (owner) => {
      const scope = owner === "scope drain" ? new AsyncWorkScope() : undefined;
      const release = createDeferredCore();
      const events: string[] = [];
      const settled = scope ? "scope drained" : "reset settled";
      const refreshWork = release.promise.then(() => {
        events.push("refresh settled");
        return scope ? ("refreshed" as const) : ("busy" as const);
      });
      const refresh = vi
        .spyOn(testApi.usageCostRefreshRuntime, "refreshCostUsageCacheForAgent")
        .mockReturnValueOnce(refreshWork);
      if (scope) {
        refresh.mockReturnValue(refreshWork);
      } else {
        refresh.mockResolvedValue("refreshed");
      }
      const request = () => {
        testApi.requestCostUsageCacheRefresh({
          agentId: scope ? "active-scope-refresh" : "reset-active-refresh",
        });
      };
      try {
        if (scope) {
          await scope.track(request);
          expect(refresh).not.toHaveBeenCalled();
        } else {
          request();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(refresh).toHaveBeenCalledOnce();

        scope?.beginClose();
        const draining = (
          scope ? scope.drain() : Promise.resolve(testApi.clearUsageCostRefreshesForTest())
        ).then(() => {
          events.push(settled);
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual([]);

        release.resolve();
        if (!scope) {
          await vi.advanceTimersByTimeAsync(50);
        }
        await draining;
        expect(events).toEqual(["refresh settled", settled]);
        if (scope) {
          await vi.advanceTimersByTimeAsync(50);
        }
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        scope?.beginClose();
        // Join the injected producer even when the broken queue never registered it.
        await refreshWork;
        await vi.advanceTimersByTimeAsync(0);
        if (scope) {
          await scope.drain();
        } else {
          // Pre-fix reset loses the running state; settle its orphan retry under the injection.
          await vi.advanceTimersByTimeAsync(50);
          await testApi.clearUsageCostRefreshesForTest();
        }
      }
    },
  );

  it.each(["initial timer", "busy retry"] as const)(
    "cancels a queued %s when its scope closes",
    async (phase) => {
      const scope = new AsyncWorkScope();
      const refresh = vi
        .spyOn(testApi.usageCostRefreshRuntime, "refreshCostUsageCacheForAgent")
        .mockResolvedValue("refreshed");
      if (phase === "busy retry") {
        refresh.mockResolvedValueOnce("busy");
      }

      try {
        await scope.track(() => {
          testApi.requestCostUsageCacheRefresh({ agentId: "cancelled-scope-refresh" });
        });
        if (phase === "busy retry") {
          await vi.advanceTimersByTimeAsync(0);
          expect(refresh).toHaveBeenCalledOnce();
        }
        const callsBeforeClose = refresh.mock.calls.length;
        scope.beginClose();
        const draining = scope.drain();
        await vi.advanceTimersByTimeAsync(50);
        await draining;
        expect(refresh).toHaveBeenCalledTimes(callsBeforeClose);
      } finally {
        scope.beginClose();
        // The pre-fix timer/retry has no scope owner; its injected next result terminates it.
        await vi.advanceTimersByTimeAsync(50);
        await testApi.clearUsageCostRefreshesForTest();
        await scope.drain();
      }
    },
  );

  it("keeps same-agent refreshes owned by independent scopes", async () => {
    const first = new AsyncWorkScope();
    const second = new AsyncWorkScope();
    const releaseFirst = createDeferredCore();
    const releaseSecond = createDeferredCore();
    const completed: string[] = [];
    const firstWork = releaseFirst.promise.then(() => {
      completed.push("first");
      return "refreshed" as const;
    });
    const secondWork = releaseSecond.promise.then(() => {
      completed.push("second");
      return "refreshed" as const;
    });
    const refresh = vi
      .spyOn(testApi.usageCostRefreshRuntime, "refreshCostUsageCacheForAgent")
      .mockImplementation((params) =>
        params?.sessionFiles?.includes("first-session.jsonl") ? firstWork : secondWork,
      );

    try {
      await first.track(() => {
        testApi.requestCostUsageCacheRefresh({
          agentId: "independent-scope-refresh",
          sessionFiles: ["first-session.jsonl"],
        });
      });
      await second.track(() => {
        testApi.requestCostUsageCacheRefresh({
          agentId: "independent-scope-refresh",
          sessionFiles: ["second-session.jsonl"],
        });
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh.mock.calls.map(([params]) => params?.sessionFiles)).toEqual([
        ["first-session.jsonl"],
        ["second-session.jsonl"],
      ]);

      first.beginClose();
      let firstDrained = false;
      const drainingFirst = first.drain().then(() => {
        firstDrained = true;
      });
      releaseFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(firstDrained).toBe(true);
      await drainingFirst;
      expect(completed).toEqual(["first"]);
      expect(second.signal.aborted).toBe(false);

      second.beginClose();
      releaseSecond.resolve();
      await second.drain();
      expect(completed).toEqual(["first", "second"]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      first.beginClose();
      second.beginClose();
      await Promise.all([firstWork, secondWork]);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([first.drain(), second.drain()]);
    }
  });
});
