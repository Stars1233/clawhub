import { z } from "zod";

export const publishSkillSchema = z.object({
  slug: z
    .string()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "Display name is required"),
  version: z
    .string()
    .min(1, "Version is required")
    .regex(/^\d+\.\d+\.\d+$/, "Version must be valid semver (e.g. 1.0.0)"),
  tags: z.array(z.string()).optional(),
  changelog: z.string().optional(),
  licenseAccepted: z.literal(true, {
    error: "You must accept the license terms",
  }),
});

export const settingsProfileSchema = z.object({
  displayName: z.string().min(1, "Display name is required").max(100, "Display name is too long"),
  bio: z.string().max(500, "Bio must be 500 characters or less").optional(),
});

export const reportSchema = z.object({
  reason: z.string().min(10, "Please provide at least 10 characters explaining the issue"),
});

export const orgSchema = z.object({
  handle: z
    .string()
    .min(1, "Handle is required")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Handle must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "Display name is required"),
});

export const tokenSchema = z.object({
  label: z.string().min(1, "Token label is required").max(100, "Label is too long"),
});

export type PublishSkillInput = z.infer<typeof publishSkillSchema>;
export type SettingsProfileInput = z.infer<typeof settingsProfileSchema>;
export type ReportInput = z.infer<typeof reportSchema>;
export type OrgInput = z.infer<typeof orgSchema>;
export type TokenInput = z.infer<typeof tokenSchema>;
