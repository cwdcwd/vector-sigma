import { z } from 'zod';

/**
 * Vector Sigma bundle contract — one source of truth shared by the
 * registrar (producer) and the registrant (consumer).
 */

export const BUNDLE_SCHEMA_VERSION = 1;

/** Bundle files are written with restrictive permissions only. */
export const BUNDLE_FILE_MODE = '0600' as const;

const relativeSafePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'path must be relative')
  .refine((p) => !p.split('/').includes('..'), 'path must not contain ..');

export const BundleFileSchema = z.object({
  /** Relative path under the device data directory. */
  path: relativeSafePath,
  mode: z.literal(BUNDLE_FILE_MODE),
  content: z.string(),
});
export type BundleFile = z.infer<typeof BundleFileSchema>;

export const IdentityBundleSchema = z.object({
  schema_version: z.literal(BUNDLE_SCHEMA_VERSION),
  /** Monotonic per device; bumped on rotation. */
  bundle_version: z.number().int().positive(),
  generated_at: z.string().min(1),
  files: z.array(BundleFileSchema).min(1),
});
export type IdentityBundle = z.infer<typeof IdentityBundleSchema>;

/** Device lifecycle status (devices.status). */
export const DeviceStatusSchema = z.enum(['pending', 'active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/** Raw delivery slot state (delivery_slots.state). */
export const SlotStateSchema = z.enum(['armed', 'consumed']);
export type SlotState = z.infer<typeof SlotStateSchema>;

/** API contracts (versioned /v1). */

export const BootstrapRequestSchema = z.object({
  balena_uuid: z.string().uuid(),
});
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

export const StatusRequestSchema = z.object({
  balena_uuid: z.string().uuid(),
});
export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const RearmRequestSchema = z.object({
  balena_uuid: z.string().uuid(),
});
export type RearmRequest = z.infer<typeof RearmRequestSchema>;

export const RotateRequestSchema = z.object({
  balena_uuid: z.string().uuid(),
  /** Full replacement file set; each entry must satisfy BundleFileSchema. */
  files: z.array(BundleFileSchema).min(1),
});
export type RotateRequest = z.infer<typeof RotateRequestSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  retry_after_seconds: z.number().int().positive().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const BootstrapSuccessSchema = z.object({
  bundle: IdentityBundleSchema,
  bundle_version: z.number().int().positive(),
  delivered_at: z.string(),
});
export type BootstrapSuccess = z.infer<typeof BootstrapSuccessSchema>;

export const StatusSuccessSchema = z.object({
  balena_uuid: z.string().uuid(),
  device_status: DeviceStatusSchema,
  slot: z.object({
    /** Effective state: a consumed slot past its re-arm window reads as armed. */
    state: SlotStateSchema,
    delivery_count: z.number().int(),
    delivered_at: z.string().nullable(),
  }),
  bundle_version: z.number().int().positive().nullable(),
});
export type StatusSuccess = z.infer<typeof StatusSuccessSchema>;

export const REGISTRAR_ROUTES = {
  healthz: '/healthz',
  bootstrap: '/v1/bootstrap',
  status: '/v1/status',
  reArm: '/v1/re-arm',
  rotate: '/v1/rotate',
} as const;