/**
 * The data revision the API reports in `x-wrl-revision` and `/health`.
 *
 * A plain counter, bumped on every `watchlog-data-changed` event. That bus is
 * the one every mutation already goes through (the store dispatches exactly one
 * event per write, and an external `data.json` reload dispatches one too), so a
 * client that polls the header learns "something changed" without the server
 * hashing the library. It starts at 0 on every load: it orders changes within
 * one session, it is not a persistent version number.
 */
import { DATA_CHANGED_EVENT } from "../types";

/** The slice of `Document` this needs, so tests can pass a bare `EventTarget`. */
export interface EventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ApiRevision {
  /** The current revision. */
  current(): number;
  /**
   * Also count events dispatched on `source`, e.g. a pop-out window's document
   * (the store dispatches on `activeDocument`). Returns the unsubscribe.
   */
  watch(source: EventSource): () => void;
  /** Stop listening everywhere. The counter keeps its last value. */
  dispose(): void;
}

export function createApiRevision(source?: EventSource): ApiRevision {
  let revision = 0;
  const bump = (): void => {
    revision += 1;
  };
  const unsubscribers = new Set<() => void>();

  const watch = (target: EventSource): (() => void) => {
    target.addEventListener(DATA_CHANGED_EVENT, bump);
    const off = (): void => {
      if (!unsubscribers.delete(off)) return;
      target.removeEventListener(DATA_CHANGED_EVENT, bump);
    };
    unsubscribers.add(off);
    return off;
  };

  if (source) watch(source);

  return {
    current: () => revision,
    watch,
    dispose: () => {
      for (const off of [...unsubscribers]) off();
    },
  };
}
