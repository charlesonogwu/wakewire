import type { RuntimeAdapter } from "./adapter.js";
import type { RuntimeCallbacks } from "./executor.js";
import type { DeployJournal } from "./journal.js";

export type RuntimeObserver = Pick<
  RuntimeCallbacks,
  "runtimeTargetId" | "busyCheckId" | "verifyCheckId" | "reloadId" | "observe"
>;

export type RuntimeObserverProvider = (repositoryId: string) => RuntimeObserver | undefined;

const configuredObservers = new Map<string, RuntimeObserver>();

// Installed private runtime adapters register fixed observation callbacks at process startup.
export function registerRuntimeObserver(repositoryId: string, observer: RuntimeObserver): void {
  if (configuredObservers.has(repositoryId)) throw new Error("runtime observer already configured");
  configuredObservers.set(repositoryId, observer);
}

export const configuredRuntimeObserverFor: RuntimeObserverProvider = (repositoryId) =>
  configuredObservers.get(repositoryId);

export function trustedRuntimeObservation(
  journal: DeployJournal,
  repositoryId: string,
  provider: RuntimeObserverProvider | undefined,
): () => string {
  const adapter: RuntimeAdapter | null = journal.activatedAdapter(repositoryId);
  const observer = provider?.(repositoryId);
  if (
    !adapter ||
    !observer ||
    observer.runtimeTargetId !== adapter.runtimeTargetId ||
    observer.busyCheckId !== adapter.busyCheckId ||
    observer.verifyCheckId !== adapter.verifyCheckId ||
    observer.reloadId !== adapter.reloadId
  ) {
    throw new Error(
      "trusted runtime observer is not configured for the activated repository adapter",
    );
  }
  return () => observer.observe();
}
