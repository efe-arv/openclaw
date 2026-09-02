import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Owns received work and connection cleanup until this Gateway generation settles. */
export class GatewayConnectionWork extends AsyncWorkScope {
  private readonly connections = new Set<() => void>();
  private failure: { error: unknown } | undefined;

  trackCleanup(run: () => Promise<void>): Promise<void> {
    // Settled request errors are outcomes, not failed teardown. Only cleanup
    // failure prevents the generation from declaring its dependencies releasable.
    return this.track(async () => {
      try {
        await run();
      } catch (error) {
        this.failure ??= { error };
        throw error;
      }
    });
  }

  registerConnection(close: () => void): () => void {
    const closed = createDeferredCore();
    this.connections.add(close);
    void this.track(() => closed.promise);
    return () => {
      this.connections.delete(close);
      closed.resolve();
    };
  }

  override beginClose(): void {
    if (this.isClosing) {
      return;
    }
    super.beginClose();
    // Disconnect so pending node invocations and request-owned cancellation can
    // settle. Ordinary RPCs still own their original completion promises.
    for (const close of this.connections) {
      try {
        close();
      } catch (error) {
        this.failure ??= { error };
      }
    }
  }

  override async drain(): Promise<void> {
    await super.drain();
    if (this.failure) {
      throw new Error("Gateway connection work failed to close cleanly", {
        cause: this.failure.error,
      });
    }
  }
}
