import { z } from "zod";

/** The rendered agreement stored on a contract: exactly what the client will read. */
export const renderedContentSchema = z.object({
  schema_version: z.literal(1),
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
});
export type RenderedContent = z.infer<typeof renderedContentSchema>;

export const templateSectionsSchema = z.array(z.object({ heading: z.string(), body: z.string() }));

export type MissingItem = { key: string; label: string; hint: string };

export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft, not sent",
  replaced: "Replaced by a newer draft",
  superseded: "Superseded by a revised offer",
  sent: "Sent",
  signed: "Signed",
  void: "Void",
};
