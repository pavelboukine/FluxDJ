"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { templateSectionsSchema } from "@/lib/contracts/content";
import { importDocx, MAX_DOCX_BYTES, type ImportResult } from "@/lib/contracts/docx/import.server";
import { readSections, type TemplateSection } from "@/lib/contracts/template-text";
import { describeDbError } from "@/lib/db-errors";
import { fail, int, ok, text, UUID_RE, type ActionState } from "@/lib/forms";

/**
 * Contract template actions. Every action re-checks staff membership with
 * requireStaff, and every database function checks it again. Published
 * versions are immutable in the database; these actions only edit drafts.
 */

function readContent(form: FormData) {
  const title = text(form, "title");
  if (title.length < 1 || title.length > 300) return { ok: false, error: "The document title is required (up to 300 characters)." } as const;
  const parsed = readSections(form);
  if (!parsed.ok) return { ok: false, error: parsed.error } as const;
  return { ok: true, title, sections: parsed.sections } as const;
}

/**
 * Creates a template with draft version 1, from what the form chose (field
 * "start"): "write" or "import" (the title and sections in the form: typed,
 * or converted from a Word document and reviewed), or "copy" (the latest
 * version of one of the business's templates, field "source_id"). One
 * database call keyed by the form's request id: a retry or a double
 * submission returns the template already created.
 */
export async function createContractTemplate(slug: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const requestId = text(form, "request_id");
  if (!UUID_RE.test(requestId)) return fail("Reload the page and try again.");
  const name = text(form, "name");
  if (name.length < 1 || name.length > 200) return fail("Name is required (up to 200 characters).");
  const start = text(form, "start");
  let content: { title: string; sections: TemplateSection[] };
  if (start === "copy") {
    const sourceId = text(form, "source_id");
    if (!UUID_RE.test(sourceId)) return fail("Choose the template to copy.");
    const { data: source } = await supabase
      .from("contract_template_versions")
      .select("title, sections")
      .eq("tenant_id", tenant.id)
      .eq("template_id", sourceId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!source) return fail("That template wasn't found. Reload the page and choose another.");
    content = { title: source.title, sections: templateSectionsSchema.parse(source.sections) };
  } else if (start === "write" || start === "import") {
    const read = readContent(form);
    if (!read.ok) return fail(read.error);
    content = read;
  } else {
    return fail("Choose how to start.");
  }
  const { data, error } = await supabase.rpc("create_contract_template_once", {
    p_tenant_id: tenant.id,
    p_template_id: requestId,
    p_name: name,
    p_title: content.title,
    p_sections: content.sections,
  });
  if (error) return fail(`Nothing was saved. ${describeDbError(error)}`);
  const result = data as { id: string; replayed: boolean };
  revalidatePath(`/staff/${slug}/contract-templates`);
  redirect(`/staff/${slug}/contract-templates/${result.id}?created=${result.replayed ? "replayed" : "1"}`);
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

export async function renameContractTemplate(slug: string, templateId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const name = text(form, "name");
  if (name.length < 1 || name.length > 200) return fail("Name is required (up to 200 characters).");
  const { data, error } = await supabase.from("contract_templates").update({ name }).eq("id", templateId).eq("tenant_id", tenant.id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Template not found.");
  revalidatePath(`/staff/${slug}/contract-templates`, "layout");
  return ok("Name saved.");
}

/** Archives (not offered when generating contracts) or restores a template. Versions and contracts are unchanged. */
export async function setContractTemplateArchived(slug: string, templateId: string, archived: boolean): Promise<ActionState> {
  const { supabase, tenant } = await requireStaff(slug);
  const { data, error } = await supabase.from("contract_templates").update({ active: !archived }).eq("id", templateId).eq("tenant_id", tenant.id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data?.length) return fail("Template not found.");
  revalidatePath(`/staff/${slug}/contract-templates`, "layout");
  return ok(archived ? "Archived. Contracts already generated from it are unchanged." : "Restored.");
}

/**
 * Converts an uploaded Word document (.docx) into proposed contract sections
 * and an import report, for the review screen. Nothing is saved and the file
 * isn't kept: it is read from the request into memory and converted there.
 * Creating the draft is a separate, explicit step (createContractTemplate,
 * start "import"), with the same checks as typed text.
 */
export async function importWordDocument(slug: string, form: FormData): Promise<ImportResult> {
  const { supabase, tenant } = await requireStaff(slug);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a Word document (.docx) to import." };
  if (!/\.docx$/i.test(file.name)) return { ok: false, error: "Only Word documents (.docx) can be imported. Save the file as .docx in Word first." };
  if (file.size > MAX_DOCX_BYTES) return { ok: false, error: "The file is larger than 4 MB. Remove large images from the document (they aren't imported anyway) and try again." };
  const [{ data: catalog }, { data: business }] = await Promise.all([
    supabase.rpc("contract_placeholder_catalog"),
    supabase.from("tenants").select("business_name, display_name, contact_email, business_address").eq("id", tenant.id).single(),
  ]);
  try {
    return await importDocx(Buffer.from(await file.arrayBuffer()), catalog ?? [], {
      legalName: business?.business_name ?? null,
      displayName: business?.display_name ?? null,
      email: business?.contact_email ?? null,
      address: business?.business_address ?? null,
    });
  } catch {
    // Never log the document: it is a client-facing agreement.
    return { ok: false, error: "This document couldn't be read. Open it in Word, save it again as a .docx, and try once more." };
  }
}
