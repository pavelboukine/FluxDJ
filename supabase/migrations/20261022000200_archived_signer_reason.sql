-- Sending a contract: an archived signer gets its own reason.
--
-- private.contract_send_problems (last replaced in
-- 20261007000100_client_use_signing.sql) reported an archived signer as
-- "signer_changed" with "Regenerate the contract", which doesn't help: the
-- client must be restored, or another contact made the signer. This is the
-- deployed definition, byte for byte, except that an archived signer is now
-- reported first as "signer_archived". A real mismatch keeps "signer_changed"
-- and its regeneration guidance. Both still block sending; nothing else
-- changes, and the function keeps its privileges (owner only).

CREATE OR REPLACE FUNCTION private.contract_send_problems(p_contract_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
  p public.proposals%rowtype;
  t public.tenants%rowtype;
  v_signer record;
  v_frozen jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_identity_changes text[] := '{}'::text[];
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'not_found', 'message', 'Contract not found.'));
  end if;
  select * into e from public.events where tenant_id = c.tenant_id and id = c.event_id;
  select * into p from public.proposals where tenant_id = c.tenant_id and id = c.proposal_id;
  select * into t from public.tenants where id = c.tenant_id;
  v_frozen := c.party_snapshot -> 'business';

  if t.archived_at is not null then
    v_problems := v_problems || jsonb_build_object('code', 'tenant_archived', 'message', 'This business is archived.');
  end if;
  if e.archived_at is not null then
    v_problems := v_problems || jsonb_build_object('code', 'event_archived',
      'message', 'The event is archived. Unarchive it before sending.');
  end if;
  -- Draft (to send) and sent (to resend) contracts may proceed.
  if c.status not in ('draft', 'sent') then
    v_problems := v_problems || jsonb_build_object('code', 'not_current_draft',
      'message', 'This contract is ' || c.status || ' and can no longer be sent. Open the current contract.');
  end if;
  if p.status <> 'approved' or e.active_proposal_id is distinct from c.proposal_id then
    v_problems := v_problems || jsonb_build_object('code', 'approval_superseded',
      'message', 'The approval this contract was built from is no longer current. Generate a contract from the current approval.');
  end if;
  if c.signing_mode = 'none' then
    v_problems := v_problems || jsonb_build_object('code', 'signing_unavailable',
      'message', 'This contract was generated from a template version published before agreements could be approved for client use, '
        || 'so it can''t be signed online. Publish a version for client use (or as DEMO) in Contract templates, then regenerate the contract.');
  end if;

  select cl.id, cl.name, cl.email, cl.archived_at into v_signer
  from public.event_clients ec join public.clients cl on cl.tenant_id = ec.tenant_id and cl.id = ec.client_id
  where ec.tenant_id = c.tenant_id and ec.event_id = c.event_id and ec.can_sign;
  if not found then
    v_problems := v_problems || jsonb_build_object('code', 'signer_missing',
      'message', 'The event has no contact marked as signer.');
  elsif v_signer.archived_at is not null then
    -- The signer is archived: restore them, or mark another contact as signer (which then needs a new contract).
    v_problems := v_problems || jsonb_build_object('code', 'signer_archived',
      'message', 'The event''s signer, ' || v_signer.name || ' (' || v_signer.email || '), is an archived client. '
        || 'Restore them on their client page, or make another contact the signer and regenerate the contract.');
  elsif v_signer.id <> c.signer_client_id or v_signer.name <> c.signer_name or v_signer.email <> c.signer_email then
    v_problems := v_problems || jsonb_build_object('code', 'signer_changed',
      'message', 'The event''s signer is now ' || v_signer.name || ' (' || v_signer.email || '), but this contract names '
        || c.signer_name || ' (' || c.signer_email || '). Regenerate the contract.');
  end if;

  if t.business_address is null or t.contact_email is null then
    v_problems := v_problems || jsonb_build_object('code', 'business_settings_incomplete',
      'message', 'Business settings are incomplete. Set the legal name, address and contact email in Business settings.');
  end if;
  if nullif(btrim(v_frozen ->> 'legal_name'), '') is null or nullif(btrim(v_frozen ->> 'address'), '') is null
     or nullif(btrim(v_frozen ->> 'contact_email'), '') is null then
    v_problems := v_problems || jsonb_build_object('code', 'business_identity_missing',
      'message', 'This contract was generated without a complete business identity. Regenerate it after completing Business settings.');
  else
    if v_frozen ->> 'legal_name' is distinct from t.business_name then v_identity_changes := array_append(v_identity_changes, 'legal name'); end if;
    if v_frozen ->> 'address' is distinct from t.business_address then v_identity_changes := array_append(v_identity_changes, 'address'); end if;
    if v_frozen ->> 'contact_email' is distinct from t.contact_email then v_identity_changes := array_append(v_identity_changes, 'contact email'); end if;
    if cardinality(v_identity_changes) > 0 then
      v_problems := v_problems || jsonb_build_object('code', 'business_changed',
        'message', 'Business settings changed since this contract was generated (' || array_to_string(v_identity_changes, ', ')
          || '). Regenerate the contract to use the current details.');
    end if;
  end if;
  if c.deposit_percent <> t.deposit_percent then
    v_problems := v_problems || jsonb_build_object('code', 'deposit_changed',
      'message', 'The deposit setting is now ' || t.deposit_percent || '%, but this contract uses ' || c.deposit_percent
        || '%. Regenerate the contract to use the current setting.');
  end if;
  return v_problems;
end;
$function$;

revoke execute on function private.contract_send_problems(uuid) from public, anon, authenticated;
