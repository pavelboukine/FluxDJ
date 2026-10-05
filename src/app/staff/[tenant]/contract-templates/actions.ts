"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { parseTemplateText } from "@/lib/contracts/template-text";
import { describeDbError } from "@/lib/db-errors";
import { checkbox, fail, int, ok, text, UUID_RE, type ActionState } from "@/lib/forms";

/**
 * Contract template actions. Every action re-checks staff membership with
 * requireStaff, and every database function checks it again. Published
 * versions are immutable in the database; these actions only edit drafts.
 */

function readContent(form: FormData) {
  const title = text(form, "title");
  if (title.length < 1 || title.length > 300) return { ok: false, error: "The document title is required (up to 300 characters)." } as const;
  // Not trimmed by text(): keep the editor's exact text for parsing.
  const raw = form.get("content");
  const parsed = parseTemplateText(typeof raw === "string" ? raw : "");
  if (!parsed.ok) return { ok: false, error: parsed.error } as const;
  return { ok: true, title, sections: parsed.sections } as const;
}

export async function createContractTemplate(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const name = text(form, "name");
  if (name.length < 1 || name.length > 200) return fail("Name is required (up to 200 characters).");
  const content = readContent(form);
  if (!content.ok) return fail(content.error);
  const { data, error } = await supabase.rpc("create_contract_template", {
    p_tenant_id: tenant.id,
    p_name: name,
    p_title: content.title,
    p_sections: content.sections,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/contract-templates`);
  redirect(`/staff/${slug}/contract-templates/${data}`);
}

/** Saves the draft version in place. A stale draft_version (another tab saved first) is refused. */
export async function saveContractTemplateDraft(slug: string, templateId: string, versionId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(versionId)) return fail("Reload the page and try again.");
  const expectedVersion = int(form, "draft_version", 0, 2_000_000_000);
  if (expectedVersion === null) return fail("Reload the page and try again.");
  const content = readContent(form);
  if (!content.ok) return fail(content.error);
  const { data: version, error } = await supabase.rpc("save_contract_template_draft", {
    p_version_id: versionId,
    p_expected_draft_version: expectedVersion,
    p_title: content.title,
    p_sections: content.sections,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/contract-templates/${templateId}`);
  return ok("Draft saved. It is not published yet.", version);
}

/**
 * Publishes the draft exactly as last saved, as DEMO or for client use.
 * Client use is owner-only (checked again in the database) and records the
 * confirmation statement version the owner accepted. Published versions can
 * never change. Publishing sends and signs nothing.
 */
export async function publishContractTemplateVersion(
  slug: string,
  templateId: string,
  versionId: string,
  expectedVersion: number,
  usage: "demo" | "client_use",
  clientUseStatementVersion: string | null,
): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(versionId) || !Number.isInteger(expectedVersion)) return fail("Reload the page and try again.");
  if (usage !== "demo" && usage !== "client_use") return fail("Choose DEMO or client use.");
  if (usage === "client_use" && !clientUseStatementVersion) return fail("Confirm the statement to publish for client use.");
  const { data, error } = await supabase.rpc("publish_contract_template_version", {
    p_version_id: versionId,
    p_expected_draft_version: expectedVersion,
    p_usage: usage,
    p_client_use_statement_version: usage === "client_use" ? clientUseStatementVersion! : undefined,
  });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/contract-templates/${templateId}`);
  revalidatePath(`/staff/${slug}/contract-templates`);
  const result = data as { version_number?: number; usage?: string };
  return ok(
    result.usage === "client_use"
      ? `Version ${result.version_number ?? ""} published for client use. It can no longer be edited. Generate contracts from it to send them.`
      : `Version ${result.version_number ?? ""} published as DEMO. It can no longer be edited.`,
  );
}

/** Opens a new draft version copied from the latest version. The published version stays unchanged. */
export async function openContractTemplateDraft(slug: string, templateId: string): Promise<ActionState> {
  const { supabase } = await requireStaff(slug);
  if (!UUID_RE.test(templateId)) return fail("Template not found.");
  const { error } = await supabase.rpc("open_contract_template_draft", { p_template_id: templateId });
  if (error) return fail(describeDbError(error));
  revalidatePath(`/staff/${slug}/contract-templates/${templateId}`);
  redirect(`/staff/${slug}/contract-templates/${templateId}`);
}

export async function updateContractTemplateDetails(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const name = text(form, "name");
  if (name.length < 1 || name.length > 200) return fail("Name is required (up to 200 characters).");
  const { data, error } = await supabase
    .from("contract_templates")
    .update({ name, active: checkbox(form, "active") })
    .eq("id", templateId)
    .eq("tenant_id", tenant.id)
    .select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Template not found.");
  revalidatePath(`/staff/${slug}/contract-templates`);
  revalidatePath(`/staff/${slug}/contract-templates/${templateId}`);
  return ok("Saved.");
}
