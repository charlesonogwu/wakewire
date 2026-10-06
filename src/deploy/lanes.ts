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

export interface LaneRouterOptions {
  deploymentLeaseActive?: (repositoryId: string) => boolean;
}

type OwnerSource =
  | EngineeringOwnerRecord
  | ((repositoryId: string) => EngineeringOwnerRecord | null);

export function createLaneRouter(
  lanes: LaneRecord[],
  owner: OwnerSource,
  publicKey: KeyObject,
  options?: LaneRouterOptions,
): LaneRouter {
  if (typeof owner !== "function") assertOwnerSignature(owner, publicKey);
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
      const record = resolveOwner(owner, event.repositoryId, publicKey);
      if (!lane || !record || lane.repositoryId !== record.repositoryId) {
        throw new Error(`owner record does not cover ${event.repositoryId}`);
      }
      if (options?.deploymentLeaseActive?.(event.repositoryId)) {
        throw new Error("deployment lease is active");
      }
      if (generation !== record.generation) {
        throw new Error(`stale owner generation ${generation}`);
      }
      if (record.phase === "draining") {
        throw new Error("draining: new engineering work is refused");
      }
    },
  };
}

function resolveOwner(
  owner: OwnerSource,
  repositoryId: string,
  publicKey: KeyObject,
): EngineeringOwnerRecord | null {
  if (typeof owner !== "function") return owner;
  const record = owner(repositoryId);
  if (!record) return null;
  assertOwnerSignature(record, publicKey);
  return record;
}

function assertOwnerSignature(owner: EngineeringOwnerRecord, publicKey: KeyObject): void {
  const { signature, ...body } = owner;
  if (!verifySignature(body, signature, publicKey)) {
    throw new Error("owner record signature is invalid");
  }
}
