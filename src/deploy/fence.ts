export interface FenceState {
  token: number;
  held: boolean;
  fenced: boolean;
  reason: string | null;
}

export type FenceResult = "acquired" | "busy" | "fenced";

export function initialFence(): FenceState {
  return { token: 0, held: false, fenced: false, reason: null };
}

export function tryAcquire(
  state: FenceState,
  token: number,
): { state: FenceState; result: FenceResult } {
  if (state.fenced) return { state, result: "fenced" };
  if (state.held || token <= state.token) return { state, result: "busy" };
  return { state: { ...state, token, held: true }, result: "acquired" };
}

export function release(state: FenceState, token: number): FenceState {
  if (!state.held || state.token !== token) throw new Error("stale fencing token");
  return { ...state, held: false };
}

export function retain(state: FenceState, token: number, reason: string): FenceState {
  if (state.token !== token) throw new Error("stale fencing token");
  return { ...state, held: true, fenced: true, reason };
}

export function clearFence(): never {
  throw new Error("fence clear forbidden");
}
