import { z } from "zod";

/** Keep declaration output bounded: callers need parsed values, not Zod's expanded internal tree. */
export function valueSchema<T extends z.ZodTypeAny>(schema: T): z.ZodType<z.output<T>, z.ZodTypeDef, z.input<T>> {
  return schema;
}
