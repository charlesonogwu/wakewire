import { isAbsolute } from "node:path";
import { z } from "zod";
import { CoordinationConfigSchema } from "../coordination/adapter.js";

export const PrepushConfigSchema = z
  .object({
    coordination: CoordinationConfigSchema.refine((value) => value.prepushEnabled === true),
    exportHost: z
      .string()
      .max(253)
      .regex(
        /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/,
      ),
    exportRoot: z
      .string()
      .max(2048)
      .regex(/^\/[A-Za-z0-9_./-]*$/)
      .refine((value) => value.split("/").every((part) => part !== "." && part !== "..")),
    stateRoot: z
      .string()
      .max(2048)
      .refine((value) => isAbsolute(value) && !/[\0\r\n,]/.test(value)),
    image: z
      .string()
      .max(300)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[a-f0-9]{64}$/),
    trustedAuthorEmail: z
      .string()
      .max(254)
      .refine((value) => value.trim().length > 0 && !/[\0\r\n]/.test(value)),
  })
  .strict();
export type PrepushConfig = z.infer<typeof PrepushConfigSchema>;
