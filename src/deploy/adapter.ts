import { z } from "zod";

export const RuntimeAdapterSchema = z.object({
  version: z.string().min(1),
  repositoryId: z.string().min(1),
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  runtimeTargetId: z.string().min(1),
  busyCheckId: z.string().min(1),
  verifyCheckId: z.string().min(1),
  reloadId: z.string().min(1),
  rollback: z.enum(["files", "unsafe"]),
  architecture: z.string().min(1),
  runtimeVersions: z.record(z.string(), z.string()),
});

export type RuntimeAdapter = z.infer<typeof RuntimeAdapterSchema>;

export function parseRuntimeAdapter(value: unknown): RuntimeAdapter {
  return RuntimeAdapterSchema.parse(value);
}
