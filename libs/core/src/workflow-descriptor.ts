import { z } from "zod";

const workflowDescriptorNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "must start with a letter or number and contain only letters, numbers, ., _, or -",
  );

/** The file format used to discover a workflow without importing its module. */
export const workflowDescriptorSchema = z.strictObject({
  name: workflowDescriptorNameSchema,
  moduleSpecifier: z.string().min(1),
  exportName: z.string().min(1),
  description: z.string().min(1),
});

export type WorkflowDescriptor = Readonly<
  z.output<typeof workflowDescriptorSchema>
>;
