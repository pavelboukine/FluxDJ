-- Client Event Hub (6E): the proposal a signer agreed to, read-only.
--
-- A signed-in client can reopen the offer and the exact selection their
-- contract was built from: the contract's own proposal, selection and
-- approval (contracts.proposal_id, selection_id, approval_id), never a newer
-- revision and never recomputed from the current catalogue. The agreed
-- totals come from the contract's frozen commercial snapshot.
--
-- Access is the contract's own rule (private.client_can_read_contract): the
-- verified, intended signer with unrevoked event access, the event and
-- business neither archived nor suspended, and the contract sent on the
-- current approval or signed. Anything else returns {"state":"unavailable"},
-- the same answer whether the contract exists or not. Reads only; no table,
-- policy or existing function changes.

create function public.client_approved_offer(p_contract_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  v_result jsonb;
begin
  select k.* into c from public.contracts k join public.tenants t on t.id = k.tenant_id
  where k.id = p_contract_id and t.slug = p_tenant_slug;
  if not found or not private.client_can_read_contract(c.id) then
    return jsonb_build_object('state', 'unavailable');
  end if;

  select jsonb_build_object(
    'state', 'available',
    'event_id', c.event_id,
    'contract', jsonb_build_object('id', c.id, 'status', c.status, 'signed_at', c.signed_at),
    'proposal', jsonb_build_object('revision', p.revision, 'offer_sha256', p.offer_sha256, 'offer', p.offer_snapshot),
    'selection', jsonb_build_object('version', s.version, 'submitted_at', s.submitted_at, 'priced', s.selection_snapshot),
    'approved_at', a.approved_at,
    -- The contract's frozen terms (what was signed), never recomputed.
    'agreed', jsonb_build_object(
      'currency', c.commercial_snapshot -> 'currency',
      'subtotal_cents', c.commercial_snapshot -> 'subtotal_cents',
      'tax_breakdown', c.commercial_snapshot -> 'tax_breakdown',
      'tax_cents', c.commercial_snapshot -> 'tax_cents',
      'total_cents', c.commercial_snapshot -> 'total_cents',
      'discount', c.commercial_snapshot -> 'discount',
      'discounted_subtotal_cents', c.commercial_snapshot -> 'discounted_subtotal_cents'))
  into v_result
  from public.proposals p
  join public.proposal_selections s on s.tenant_id = c.tenant_id and s.proposal_id = p.id and s.id = c.selection_id
  join public.proposal_approvals a on a.tenant_id = c.tenant_id and a.proposal_id = p.id and a.id = c.approval_id and a.selection_id = s.id
  where p.tenant_id = c.tenant_id and p.id = c.proposal_id;

  return coalesce(v_result, jsonb_build_object('state', 'unavailable'));
end;
$$;
comment on function public.client_approved_offer(uuid, text) is
  'The offer and selection a contract was built from, for its signer only (client_can_read_contract). Read-only, frozen data.';
revoke execute on function public.client_approved_offer(uuid, text) from public, anon;
grant execute on function public.client_approved_offer(uuid, text) to authenticated;
