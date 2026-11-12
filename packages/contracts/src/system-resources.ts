import { z } from "zod";
import { STORAGE_POLICY, type StorageRootHealth } from "./storage-health.js";

// Turn 240 / SPEC-061 R-2: local observations only. No paths, hostnames or device identifiers.
const instant = z.number().int().nonnegative().safe();
const bytes = z.number().int().nonnegative().safe();
const percent = z.number().finite().min(0).max(100);
const measurement = <T extends z.ZodTypeAny>(value: T) => z.object({
  source: z.enum(["node-os", "nvidia-smi", "host-owner"]),
  state: z.enum(["measured", "unavailable", "unsupported"]),
  measuredAt: instant.nullable(), value: value.nullable(),
}).strict().superRefine((sample, ctx) => {
  if (sample.state === "measured" && (sample.value === null || sample.measuredAt === null)) {
    ctx.addIssue({ code: "custom", message: "A measured reading needs a value and measurement time." });
  }
});
export const CpuMeasurementSchema = measurement(percent);
export const MemoryMeasurementSchema = measurement(z.object({ usedBytes: bytes, totalBytes: bytes.positive() }).strict()
  .refine(value => value.usedBytes <= value.totalBytes, "Used memory exceeds total memory."));
export const GpuValuesSchema = z.object({
  index: z.number().int().min(0).max(31), utilisation: percent.nullable(),
  usedBytes: bytes.nullable(), totalBytes: bytes.positive().nullable(),
}).strict().refine(value => value.usedBytes === null || value.totalBytes === null || value.usedBytes <= value.totalBytes, "Used GPU memory exceeds total memory.");
export const GpuMeasurementSchema = measurement(z.array(GpuValuesSchema).min(1).max(8));
export const MingMeasurementSchema = measurement(z.boolean());
export const SystemResourcesSchema = z.object({
  at: instant, cpu: CpuMeasurementSchema, memory: MemoryMeasurementSchema,
  gpu: GpuMeasurementSchema, ming: MingMeasurementSchema,
}).strict();
export type SystemResources = z.infer<typeof SystemResourcesSchema>;
export type GpuMeasurement = z.infer<typeof GpuMeasurementSchema>;
export type ResourceMeasurement = SystemResources["cpu" | "memory" | "gpu" | "ming"];
export const SYSTEM_RESOURCE_MAX_AGE_MS = 15_000;

/** UI freshness never grants resource admission or proves a service's inference quality. */
export function resourceFresh(sample: ResourceMeasurement | null | undefined, now: number): boolean {
  return !!sample && sample.state === "measured" && sample.value !== null && sample.measuredAt !== null &&
    sample.measuredAt <= now && now - sample.measuredAt <= SYSTEM_RESOURCE_MAX_AGE_MS;
}

export function unavailableSystemResources(at: number): SystemResources {
  return { at, cpu: { source: "node-os", state: "unavailable", measuredAt: null, value: null },
    memory: { source: "node-os", state: "unavailable", measuredAt: null, value: null },
    gpu: { source: "nvidia-smi", state: "unsupported", measuredAt: null, value: null },
    ming: { source: "host-owner", state: "unsupported", measuredAt: null, value: null } };
}

/** Mapping revisions identify destination mappings, not independent physical free-space pools. */
export function systemStorageGroups(roots: readonly StorageRootHealth[], now: number) {
  const groups = new Map<string, StorageRootHealth[]>();
  for (const root of roots) {
    const key = root.capacity ? `volume:${root.capacity.volumeId}` : `root:${root.rootId}`;
    groups.set(key, [...groups.get(key) ?? [], root]);
  }
  const current = (root: StorageRootHealth) => root.state === "measured" && root.capacity?.availableBytes !== null && !!root.capacity &&
    root.capacity.measuredAt <= now && now - root.capacity.measuredAt <= STORAGE_POLICY.forecastMaxAgeMs;
  return [...groups.entries()].map(([key, members]) => {
    const measured = members.filter(current).sort((a, b) => a.capacity!.availableBytes! - b.capacity!.availableBytes!);
    const chosen = measured[0] ?? [...members].sort((a, b) => (b.capacity?.measuredAt ?? 0) - (a.capacity?.measuredAt ?? 0))[0]!;
    return { key, roots: members, root: chosen, fresh: measured.length > 0, unavailable: members.length - measured.length };
  });
}
