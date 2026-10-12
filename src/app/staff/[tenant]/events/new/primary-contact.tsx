"use client";

import { useState } from "react";
import { ClientPicker, type PickerClient } from "@/components/app/client-picker";
import { ClientFields } from "../../clients/client-fields";

/**
 * The new event's primary contact: an existing client found by search, or a
 * new client entered here. Only the chosen mode is submitted as required;
 * typed details survive switching back and forth.
 */
export function PrimaryContact({
  search,
  initial,
  hasClients,
  contractsNeedPhone,
}: {
  search: (query: string) => Promise<PickerClient[]>;
  initial: PickerClient | null;
  hasClients: boolean;
  contractsNeedPhone: boolean;
}) {
  const [mode, setMode] = useState<"existing" | "new">(initial ? "existing" : hasClients ? "existing" : "new");
  const option = "flex min-h-11 flex-1 basis-40 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm text-muted-foreground">Receives the proposal and signs the contract in later steps.</legend>
        <div className="flex flex-wrap gap-2">
          <label className={option}>
            <input type="radio" name="contact_mode" value="existing" checked={mode === "existing"} onChange={() => setMode("existing")} className="size-4 accent-primary" />
            Existing client
          </label>
          <label className={option}>
            <input type="radio" name="contact_mode" value="new" checked={mode === "new"} onChange={() => setMode("new")} className="size-4 accent-primary" />
            New client
          </label>
        </div>
      </fieldset>
      {mode === "existing" ? (
        <ClientPicker search={search} name="client_id" label="Client" initial={initial} />
      ) : (
        <input type="hidden" name="client_id" value="new" />
      )}
      <div hidden={mode !== "new"}>
        <ClientFields optional={mode !== "new"} contractsNeedPhone={contractsNeedPhone} />
      </div>
    </div>
  );
}
