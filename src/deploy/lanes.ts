import type { KeyObject } from "node:crypto";
import { verifySignature } from "./crypto.js";
import type { EngineeringOwnerRecord, LaneRecord } from "./types.js";

export interface LaneEvent {
  repositoryId: string;
  deliveryId: string;
}

export interface LaneRouter {
  route(event: LaneEvent): { laneId: string };
  admit(event: { repositoryId: string }, generation: number): void;
}

export function createLaneRouter(
  lanes: LaneRecord[],
  owner: EngineeringOwnerRecord,
  publicKey: KeyObject,
): LaneRouter {
  const { signature, ...body } = owner;
  if (!verifySignature(body, signature, publicKey)) {
    throw new Error("owner record signature is invalid");
  }
  const byRepo = new Map(lanes.map((lane) => [lane.repositoryId, lane]));
  const deliveries = new Map<string, string>();

  return {
    route(event) {
      const seen = deliveries.get(event.deliveryId);
      if (seen) {
        if (seen !== event.repositoryId) throw new Error("delivery crossed repositories");
        const lane = byRepo.get(event.repositoryId);
        if (!lane) throw new Error(`unknown repository ${event.repositoryId}`);
        return { laneId: lane.laneId };
      }
      const lane = byRepo.get(event.repositoryId);
      if (!lane) throw new Error(`unknown repository ${event.repositoryId}`);
      deliveries.set(event.deliveryId, event.repositoryId);
      return { laneId: lane.laneId };
    },
    admit(event, generation) {
      const lane = byRepo.get(event.repositoryId);
      if (!lane || lane.repositoryId !== owner.repositoryId) {
        throw new Error(`owner record does not cover ${event.repositoryId}`);
      }
      if (generation !== owner.generation) {
        throw new Error(`stale owner generation ${generation}`);
      }
      if (owner.phase === "draining") {
        throw new Error("draining: new engineering work is refused");
      }
    },
  };
}
