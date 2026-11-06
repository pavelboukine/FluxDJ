-- Configurable booking workflows (Release B). Staff can create a contract-first
-- event and generate a contract with no proposal, with stated terms or none.
-- Everything Release A enforces still applies: this adds the only ways in.
--
-- Creating: contract_first is set like booking_source, through the existing
-- staff insert. Its constraints reject an external or proposal-carrying event.
--
-- Changing: contract_first still can't be updated by any role, except through
-- set_event_contract_first, and only before the event has any proposal or
-- contract and while it is a lead. Nothing issued can be affected. booking_source
-- stays immutable: a booking made elsewhere is a different kind of event.
--
-- Generating: generate_direct_contract_draft mirrors generate_contract_draft
-- (which is untouched) for the terms staff state. It creates no proposal,
-- selection or approval. Fields that only an approved proposal can fill are
-- reported missing, never faked. A template must state the terms it records:
-- a total needs {{pricing.total}} and a deposit needs {{payment.deposit}}, and
-- contract_send_problems rechecks the rendered agreement before sending.
--
-- Deposits: Release A let staff state a $0 total under a business that requires
-- a deposit, because it owes nothing. That is also a way around the requirement,
-- so a $0 total now needs an owner too. An owner must ask for the override, and
-- it is audited. The trigger remains the rule; the generator only explains it.

-- ===========================================================================
-- Creating and correcting the workflow
-- ===========================================================================

grant insert (contract_first) on public.events to authenticated;

comment on column public.events.contract_first is
  'A Flux booking that skips the proposal: staff go straight to a contract. Set when the event is created; only set_event_contract_first can change it, before any proposal or contract exists.';

drop trigger events_immutable on public.events;
create trigger events_immutable before update on public.events
  for each row execute function private.forbid_column_changes('id', 'tenant_id', 'created_at', 'booking_source');

create function private.events_contract_first_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.contract_first is distinct from old.contract_first
     and current_setting('flux.event_workflow', true) is distinct from new.id::text then
    raise exception 'column events.contract_first is immutable outside set_event_contract_first' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function private.events_contract_first_guard() from public, anon, authenticated;
create trigger events_contract_first_guard before update of contract_first on public.events
  for each row execute function private.events_contract_first_guard();

-- Corrects a choice made when creating the event. Only while nothing has been
-- started: a lead with no proposal or contract of any status, so no issued
-- document or client access can depend on the old workflow.
create function public.set_event_contract_first(p_event_id uuid, p_contract_first boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.events%rowtype;
begin
  select * into e from public.events where id = p_event_id;
  if not found or p_contract_first is null then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  perform private.require_staff_of(e.tenant_id);
  select * into e from public.events where id = p_event_id for update;
  if e.contract_first = p_contract_first then
    return jsonb_build_object('status', 'unchanged', 'contract_first', e.contract_first);
  end if;
  if e.booking_source <> 'flux' then
    raise exception 'contract_not_allowed: this event was booked elsewhere, so it has no booking steps to change' using errcode = 'invalid_parameter_value';
  end if;
  if e.archived_at is not null then
    raise exception 'contract_not_allowed: the event is archived' using errcode = 'invalid_parameter_value';
  end if;
  if e.lifecycle_status <> 'lead'
     or exists (select 1 from public.proposals p where p.tenant_id = e.tenant_id and p.event_id = e.id)
     or exists (select 1 from public.contracts c where c.tenant_id = e.tenant_id and c.event_id = e.id) then
    raise exception 'contract_not_allowed: the booking steps can''t change once a proposal or contract has been started' using errcode = 'invalid_parameter_value';
  end if;
  perform set_config('flux.event_workflow', e.id::text, true);
  update public.events set contract_first = p_contract_first where id = e.id;
  perform set_config('flux.event_workflow', '', true);
  perform private.audit(e.tenant_id, 'event', e.id, 'booking_steps_changed', 'staff', (select auth.uid()),
    jsonb_build_object('contract_first', p_contract_first));
  return jsonb_build_object('status', 'changed', 'contract_first', p_contract_first);
end;
$$;
revoke execute on function public.set_event_contract_first(uuid, boolean) from public, anon;
grant execute on function public.set_event_contract_first(uuid, boolean) to authenticated, service_role;

-- ===========================================================================
-- Deposit authorization: a $0 total no longer avoids the requirement
-- ===========================================================================

create or replace function private.contracts_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tenants%rowtype;
begin
  select * into t from public.tenants where id = new.tenant_id;
  if new.proposal_id is not null then
    new.booking_policy := t.booking_confirmation_policy;
    return new;
  end if;
  if new.booking_policy is null then
    perform private.contract_error('choose when this booking is confirmed');
  end if;
  -- The business requires a deposit: only a positive total with at least that
  -- percentage, due before booking, meets it. Anything else needs an owner,
  -- who is the signed-in user's own membership, never an ID on the row.
  if t.booking_confirmation_policy = 'on_deposit' and t.deposit_percent > 0
     and not coalesce(new.total_cents > 0 and new.booking_policy = 'on_deposit'
                      and new.deposit_cents >= private.contract_deposit_cents(new.total_cents, t.deposit_percent), false) then
    if not exists (select 1 from public.tenant_memberships m
                   where m.tenant_id = new.tenant_id and m.user_id = (select auth.uid()) and m.role = 'owner' and m.removed_at is null) then
      raise exception 'only the owner can go below the deposit this business requires' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- Placeholders
-- ===========================================================================

CREATE OR REPLACE FUNCTION private.contract_placeholders()
 RETURNS TABLE(key text, label text, description text, missing_hint text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $$
  select * from (values
    ('business.name', 'Business name', 'Your legal business name (same as business.legal_name).', 'Business name: set the legal business name in Business settings.', 10),
    ('business.legal_name', 'Legal business name', 'Your legal business name from Business settings.', 'Legal business name: set it in Business settings.', 12),
    ('business.address', 'Business address', 'Your business address from Business settings.', 'Business address: set it in Business settings.', 14),
    ('business.email', 'Business contact email', 'Your contact email from Business settings.', 'Business contact email: set it in Business settings.', 16),
    ('business.display_name', 'Business display name', 'The name clients see on proposals.', 'Business display name: set it in your business settings.', 20),
    ('client.name', 'Client name', 'The event contact marked as signer.', 'Client name: edit the signer''s client record.', 30),
    ('client.email', 'Client email', 'The signer''s email address.', 'Client email: edit the signer''s client record.', 40),
    ('client.phone', 'Client phone', 'The signer''s phone number.', 'Client phone: add a phone number to the signer''s client record.', 50),
    ('event.title', 'Event title', 'The event''s title.', 'Event title: edit the event.', 60),
    ('event.date', 'Event date', 'The event date, for example "Saturday, June 12, 2027".', 'Event date: edit the event.', 70),
    ('venue.name', 'Venue name', 'The event''s venue name.', 'Venue name: add it to the event.', 80),
    ('venue.address', 'Venue address', 'The event''s venue address.', 'Venue address: add it to the event.', 90),
    ('contract.services', 'Services', 'The services for this event, typed when preparing a contract with no proposal.', 'Services: describe them when preparing the contract. This field isn''t available on a contract from a proposal, so choose a template without it there.', 95),
    ('package.name', 'Package', 'The approved package''s name.', 'Package: the approved selection has no package.', 100),
    ('package.price', 'Package price', 'The approved package''s base price.', 'Package price: the approved selection has no package.', 110),
    ('package.included', 'Included gear', 'A list of the gear included in the package.', 'Included gear: unavailable.', 120),
    ('gear.extras', 'Additional gear', 'A list of chargeable extra and required gear, with line totals and reasons. Says "No additional gear." when there is none.', 'Additional gear: unavailable.', 130),
    ('pricing.subtotal_before_discount', 'Subtotal before discount', 'Approved subtotal before the proposal discount and taxes. The same as the subtotal when there is no discount.', 'Subtotal before discount: unavailable.', 136),
    ('pricing.discount', 'Discount', 'The proposal discount with its description and amount, for example "Wedding Special (10%): -180.00 CAD". Says "No discount." when there is none.', 'Discount: unavailable.', 138),
    ('pricing.subtotal', 'Subtotal', 'Approved subtotal before taxes, after any proposal discount.', 'Subtotal: unavailable.', 140),
    ('pricing.taxes', 'Tax breakdown', 'A list of each configured tax with its rate and amount.', 'Tax breakdown: unavailable.', 150),
    ('pricing.tax_total', 'Total taxes', 'Sum of the approved taxes.', 'Total taxes: unavailable.', 160),
    ('pricing.total', 'Total', 'Approved total including taxes.', 'Total: unavailable.', 170),
    ('pricing.currency', 'Currency', 'Currency code, for example CAD.', 'Currency: unavailable.', 180),
    ('payment.deposit_percent', 'Deposit percentage', 'The deposit percentage from Business settings, frozen when the contract is generated.', 'Deposit percentage: unavailable.', 190),
    ('payment.deposit', 'Deposit', 'Deposit due on signing: the deposit percentage of the total including taxes, rounded half up to the cent.', 'Deposit: unavailable.', 200),
    ('payment.balance', 'Balance', 'Remaining balance: the total minus the deposit.', 'Balance: unavailable.', 210),
    ('payment.balance_due_date', 'Balance due date', 'A date staff enter when generating the contract. Nothing is assumed.', 'Balance due date: enter it when generating the contract.', 220)
  ) as p(key, label, description, missing_hint, sort_order);
$$;

-- ===========================================================================
-- Sending: the agreement must state the money the contract records
-- ===========================================================================

CREATE OR REPLACE FUNCTION "private"."contract_send_problems"("p_contract_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  c public.contracts%rowtype;
  e public.events%rowtype;
  t public.tenants%rowtype;
  v_signer record;
  v_frozen jsonb;
  v_problems jsonb := '[]'::jsonb;
  v_identity_changes text[] := '{}'::text[];
  v_agreement text;
begin
  select * into c from public.contracts where id = p_contract_id;
  if not found then
    return jsonb_build_array(jsonb_build_object('code', 'not_found', 'message', 'Contract not found.'));
  end if;
  select * into e from public.events where tenant_id = c.tenant_id and id = c.event_id;
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
  if not private.contract_is_current(c, e) then
    v_problems := v_problems || case when c.proposal_id is not null then
      jsonb_build_object('code', 'approval_superseded',
        'message', 'The approval this contract was built from is no longer current. Generate a contract from the current approval.')
    else
      jsonb_build_object('code', 'event_not_contract_first',
        'message', 'This contract has no proposal, and its event is no longer set up for one.')
    end;
  end if;
  if c.signing_mode = 'none' then
    v_problems := v_problems || jsonb_build_object('code', 'signing_unavailable',
      'message', 'This contract was generated from a template version published before agreements could be approved for client use, '
        || 'so it can''t be signed online. Publish a version for client use (or as DEMO) in Contract templates, then regenerate the contract.');
  elsif private.contract_signing_consent(c.consent_version) is null then
    -- Frozen on a contract without financial terms until its wording is approved.
    v_problems := v_problems || jsonb_build_object('code', 'consent_unavailable',
      'message', 'Online signing isn''t available yet for a contract without payment terms.');
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
  -- The money a direct contract records must be in the agreement the client reads, not only in its columns.
  if c.proposal_id is null and c.total_cents is not null then
    select string_agg(x.line, E'\n') into v_agreement
    from private.contract_template_texts(c.rendered_content ->> 'title', c.rendered_content -> 'sections') as x(line);
    if position(private.format_cents(c.total_cents, c.currency) in coalesce(v_agreement, '')) = 0
       or (c.deposit_cents > 0 and position(private.format_cents(c.deposit_cents, c.currency) in coalesce(v_agreement, '')) = 0) then
      v_problems := v_problems || jsonb_build_object('code', 'terms_not_in_agreement',
        'message', 'The agreement doesn''t state this contract''s total and deposit. Generate it from a template with those fields.');
    end if;
  end if;
  -- Only a proposal-backed contract follows the business's percentage; a direct contract states its own terms.
  if c.proposal_id is not null and c.deposit_percent <> t.deposit_percent then
    v_problems := v_problems || jsonb_build_object('code', 'deposit_changed',
      'message', 'The deposit setting is now ' || t.deposit_percent || '%, but this contract uses ' || c.deposit_percent
        || '%. Regenerate the contract to use the current setting.');
  end if;
  return v_problems;
end;
$$;

-- ===========================================================================
-- Generating a contract with no proposal
-- ===========================================================================

-- Mirrors generate_contract_draft for terms staff state: the same checks,
-- rendering, hash, one-draft rule and audit, with no proposal behind it.
-- No total means no financial terms, which is never the same as a total of 0.
create function public.generate_direct_contract_draft(
  p_event_id uuid,
  p_template_version_id uuid,
  p_total_cents bigint default null,
  p_deposit_cents bigint default null,
  p_balance_due_date date default null,
  p_services text default null,
  p_override_deposit boolean default false,
  p_replace_contract_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.events%rowtype;
  v_tenant public.tenants%rowtype;
  v_version public.contract_template_versions%rowtype;
  v_template_active boolean;
  v_membership_id uuid;
  v_role text;
  v_signer record;
  v_has_signer boolean;
  v_services text := nullif(btrim(coalesce(p_services, '')), '');
  v_deposit bigint;
  v_balance bigint;
  v_percent integer;
  v_policy text;
  v_required boolean;
  v_required_deposit bigint;
  v_meets_requirement boolean;
  v_values jsonb;
  v_missing jsonb;
  v_rendered jsonb;
  v_commercial jsonb;
  v_parties jsonb;
  v_hash text;
  v_existing public.contracts%rowtype;
  v_has_existing boolean;
  v_replaced uuid;
  v_id uuid;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_event.tenant_id);
  -- The event lock serializes generation, so concurrent clicks cannot create two drafts.
  select * into v_event from public.events where id = p_event_id for update;
  select * into v_tenant from public.tenants where id = v_event.tenant_id;
  select m.role into v_role from public.tenant_memberships m where m.id = v_membership_id;

  if not v_event.contract_first or v_event.booking_source <> 'flux' then
    raise exception 'contract_not_allowed: this event doesn''t use contract-first booking' using errcode = 'invalid_parameter_value';
  end if;
  if v_event.archived_at is not null then
    raise exception 'contract_not_allowed: the event is archived' using errcode = 'invalid_parameter_value';
  end if;
  if v_event.lifecycle_status not in ('lead', 'awaiting_signature') then
    raise exception 'contract_not_allowed: the event is %', replace(v_event.lifecycle_status, '_', ' ') using errcode = 'invalid_parameter_value';
  end if;
  if v_tenant.archived_at is not null then
    raise exception 'contract_not_allowed: the business is archived' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_version from public.contract_template_versions
  where tenant_id = v_tenant.id and id = p_template_version_id;
  if not found then
    perform private.contract_error('template version not found');
  end if;
  if v_version.published_at is null then
    perform private.contract_error('publish this template version before generating a contract');
  end if;
  select t.active into v_template_active from public.contract_templates t
  where t.tenant_id = v_tenant.id and t.id = v_version.template_id;
  if not v_template_active then
    perform private.contract_error('this template is archived');
  end if;

  -- The terms. A deposit needs a total; a total with no deposit is an explicit 0.
  if p_total_cents is null then
    if p_deposit_cents is not null then
      raise exception 'contract_input_invalid: a deposit needs a total' using errcode = 'invalid_parameter_value';
    end if;
    if p_balance_due_date is not null then
      raise exception 'contract_input_invalid: a balance due date needs a total' using errcode = 'invalid_parameter_value';
    end if;
  else
    v_deposit := coalesce(p_deposit_cents, 0);
    if p_total_cents < 0 or v_deposit < 0 then
      raise exception 'contract_input_invalid: amounts can''t be negative' using errcode = 'invalid_parameter_value';
    end if;
    if v_deposit > p_total_cents then
      raise exception 'contract_input_invalid: the deposit can''t be more than the total' using errcode = 'invalid_parameter_value';
    end if;
    v_balance := p_total_cents - v_deposit;
  end if;
  v_policy := case when v_deposit > 0 then 'on_deposit' else 'on_signature' end;
  -- The percentage is only stated when the deposit is exactly the business's own.
  if v_deposit > 0 and v_deposit = private.contract_deposit_cents(p_total_cents, v_tenant.deposit_percent) then
    v_percent := v_tenant.deposit_percent;
  end if;
  if v_services is not null then
    if length(v_services) > 5000 then
      raise exception 'contract_input_invalid: the services description is too long (5,000 characters at most)' using errcode = 'invalid_parameter_value';
    end if;
    if not ('contract.services' = any (v_version.placeholders)) then
      raise exception 'contract_input_invalid: this template version has no services field, so leave it blank' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if p_balance_due_date is not null then
    if not ('payment.balance_due_date' = any (v_version.placeholders)) then
      raise exception 'contract_input_invalid: this template version has no balance due date, so leave it blank' using errcode = 'invalid_parameter_value';
    end if;
    if p_balance_due_date < (now() at time zone v_event.timezone)::date then
      raise exception 'contract_input_invalid: the balance due date is in the past' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- The business's required deposit. Staff are stopped here with a clear message
  -- (contracts_booking_policy is what enforces it); an owner must ask explicitly.
  v_required := v_tenant.booking_confirmation_policy = 'on_deposit' and v_tenant.deposit_percent > 0;
  if p_total_cents is not null then
    v_required_deposit := private.contract_deposit_cents(p_total_cents, v_tenant.deposit_percent);
  end if;
  v_meets_requirement := not v_required
    or coalesce(p_total_cents > 0 and v_deposit >= v_required_deposit, false);
  if not v_meets_requirement then
    if v_role <> 'owner' then
      raise exception 'contract_input_invalid: this business requires a deposit of at least % of the total. Only the owner can go below it', v_tenant.deposit_percent::text || '%'
        using errcode = 'insufficient_privilege';
    end if;
    if p_override_deposit is not true then
      return jsonb_build_object('status', 'override_required', 'deposit_percent', v_tenant.deposit_percent,
                                'required_deposit_cents', v_required_deposit);
    end if;
  end if;

  select c.id, c.name, c.email, c.phone, c.archived_at into v_signer
  from public.event_clients ec
  join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = v_event.tenant_id and ec.event_id = v_event.id and ec.can_sign;
  v_has_signer := found;

  v_values := jsonb_build_object(
    'business.name', nullif(btrim(v_tenant.business_name), ''),
    'business.legal_name', nullif(btrim(v_tenant.business_name), ''),
    'business.address', nullif(btrim(v_tenant.business_address), ''),
    'business.email', nullif(btrim(v_tenant.contact_email), ''),
    'business.display_name', nullif(btrim(v_tenant.display_name), ''),
    'client.name', case when v_has_signer then nullif(btrim(v_signer.name), '') end,
    'client.email', case when v_has_signer then nullif(btrim(v_signer.email), '') end,
    'client.phone', case when v_has_signer then nullif(btrim(v_signer.phone), '') end,
    'event.title', nullif(btrim(v_event.title), ''),
    'event.date', to_char(v_event.event_date, 'FMDay, FMMonth FMDD, YYYY'),
    'venue.name', nullif(btrim(v_event.venue_name), ''),
    'venue.address', nullif(btrim(v_event.venue_address), ''),
    'contract.services', v_services,
    'pricing.total', case when p_total_cents is not null then private.format_cents(p_total_cents, v_tenant.currency) end,
    'pricing.currency', case when p_total_cents is not null then v_tenant.currency end,
    'payment.deposit_percent', case when v_percent is not null then v_percent::text || '%' end,
    'payment.deposit', case when p_total_cents is not null then private.format_cents(v_deposit, v_tenant.currency) end,
    'payment.balance', case when p_total_cents is not null then private.format_cents(v_balance, v_tenant.currency) end,
    'payment.balance_due_date', to_char(p_balance_due_date, 'FMMonth FMDD, YYYY')
  );

  -- Every field the template uses needs a real value. Package, gear and itemized
  -- pricing come from an approved proposal, so they have none here.
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'label', p.label, 'hint',
      case
        when p.key like 'package.%' or p.key like 'gear.%'
             or p.key in ('pricing.subtotal_before_discount', 'pricing.discount', 'pricing.subtotal', 'pricing.taxes', 'pricing.tax_total') then
          p.label || ': this comes from an approved proposal. Choose a template without it.'
        when p.key in ('pricing.total', 'pricing.currency', 'payment.deposit', 'payment.balance') and p_total_cents is null then
          p.label || ': enter a total, or choose a template without payment fields.'
        when p.key = 'payment.deposit_percent' then
          p.label || ': only available when the deposit is your business''s percentage of the total. Enter that deposit, or choose a template without it.'
        when p.key = 'payment.balance_due_date' and p_total_cents is null then
          p.label || ': enter a total and this date, or choose a template without payment fields.'
        else p.missing_hint
      end) order by p.sort_order), '[]')
    into v_missing
  from private.contract_placeholders() p
  where p.key = any (v_version.placeholders) and v_values ->> p.key is null;
  -- The agreement must state the money this contract records.
  if p_total_cents is not null and not ('pricing.total' = any (v_version.placeholders)) then
    v_missing := v_missing || jsonb_build_object('key', 'terms.total', 'label', 'Total',
      'hint', 'Total: this template doesn''t state the total. Add {{pricing.total}} to the template, or leave the total blank.');
  end if;
  if v_deposit > 0 and not ('payment.deposit' = any (v_version.placeholders)) then
    v_missing := v_missing || jsonb_build_object('key', 'terms.deposit', 'label', 'Deposit',
      'hint', 'Deposit: this template doesn''t state the deposit. Add {{payment.deposit}} to the template.');
  end if;
  if not v_has_signer then
    v_missing := jsonb_build_array(jsonb_build_object('key', 'signer', 'label', 'Signer',
      'hint', 'Signer: mark one of the event''s contacts as the signer.')) || v_missing;
  elsif v_signer.archived_at is not null then
    v_missing := jsonb_build_array(jsonb_build_object('key', 'signer', 'label', 'Signer',
      'hint', 'Signer: the signer''s client record is archived. Restore it or choose another signer.')) || v_missing;
  end if;
  if jsonb_array_length(v_missing) > 0 then
    return jsonb_build_object('status', 'incomplete', 'missing', v_missing);
  end if;

  v_rendered := jsonb_build_object(
    'schema_version', 1,
    'title', private.render_contract_text(v_version.title, v_values),
    'sections', (
      select jsonb_agg(jsonb_build_object(
        'heading', private.render_contract_text(s ->> 'heading', v_values),
        'body', private.render_contract_text(s ->> 'body', v_values)) order by ord)
      from jsonb_array_elements(v_version.sections) with ordinality as x(s, ord)
    )
  );
  v_commercial := case when p_total_cents is null then
      jsonb_build_object('schema_version', 2, 'financial_terms', 'none')
    else
      jsonb_build_object('schema_version', 2, 'financial_terms', 'stated', 'currency', v_tenant.currency, 'total_cents', p_total_cents,
        'payment', jsonb_build_object('deposit_cents', v_deposit, 'balance_cents', v_balance, 'balance_due_date', p_balance_due_date)
          || case when v_deposit > 0 then jsonb_build_object('deposit_due', 'on_signing') else '{}'::jsonb end
          || case when v_percent is not null then jsonb_build_object('deposit_percent', v_percent, 'deposit_basis_points', v_percent * 100, 'deposit_rounding', 'half_up_to_cent') else '{}'::jsonb end)
    end
    || case when v_services is not null then jsonb_build_object('services', v_services) else '{}'::jsonb end;
  v_parties := jsonb_build_object(
    'business', jsonb_build_object(
      'name', v_tenant.business_name, 'display_name', v_tenant.display_name, 'legal_name', v_tenant.business_name,
      'address', v_tenant.business_address, 'contact_email', v_tenant.contact_email),
    'client', jsonb_build_object('client_id', v_signer.id, 'name', v_signer.name, 'email', v_signer.email, 'phone', v_signer.phone),
    'event', jsonb_build_object(
      'event_id', v_event.id, 'title', v_event.title, 'event_type', v_event.event_type, 'date', v_event.event_date,
      'timezone', v_event.timezone, 'venue_name', v_event.venue_name, 'venue_address', v_event.venue_address)
  );
  v_hash := private.contract_content_sha256(v_rendered, v_commercial, v_parties, v_version.id, v_version.content_sha256);

  -- One draft per event: repeat or replace explicitly.
  select * into v_existing from public.contracts
  where tenant_id = v_event.tenant_id and event_id = v_event.id and status = 'draft'
  for update;
  v_has_existing := found;
  if v_has_existing then
    if v_existing.content_sha256 = v_hash
       and (p_replace_contract_id is null or p_replace_contract_id in (v_existing.id, v_existing.replaces_id)) then
      return jsonb_build_object('status', 'replayed', 'contract_id', v_existing.id);
    end if;
    if p_replace_contract_id is null then
      return jsonb_build_object('status', 'draft_exists', 'contract_id', v_existing.id);
    end if;
    if p_replace_contract_id <> v_existing.id then
      return jsonb_build_object('status', 'conflict', 'contract_id', v_existing.id);
    end if;
    update public.contracts set status = 'replaced' where id = v_existing.id;
    v_replaced := v_existing.id;
  elsif p_replace_contract_id is not null then
    return jsonb_build_object('status', 'conflict', 'contract_id', null);
  end if;

  insert into public.contracts (
    tenant_id, event_id, template_id, template_version_id, template_content_sha256, replaces_id,
    signer_client_id, signer_name, signer_email, currency,
    total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, booking_policy,
    rendered_content, commercial_snapshot, party_snapshot, content_sha256, generated_by_membership_id, generated_by_user_id
  ) values (
    v_tenant.id, v_event.id, v_version.template_id, v_version.id, v_version.content_sha256, v_replaced,
    v_signer.id, v_signer.name, v_signer.email, v_tenant.currency,
    p_total_cents, v_percent, v_deposit, v_balance, p_balance_due_date, v_policy,
    v_rendered, v_commercial, v_parties, v_hash, v_membership_id, (select auth.uid())
  )
  returning id, content_sha256 into v_id, v_hash;

  -- A proposal's approval does this on the full workflow.
  if v_event.lifecycle_status = 'lead' then
    update public.events set lifecycle_status = 'awaiting_signature' where id = v_event.id;
  end if;

  perform private.audit(v_tenant.id, 'contract', v_id, case when v_replaced is null then 'draft_generated' else 'draft_regenerated' end,
    'staff', (select auth.uid()),
    jsonb_build_object('event_id', v_event.id, 'template_version_id', v_version.id, 'content_sha256', v_hash, 'replaces_id', v_replaced,
                       'financial_terms', case when p_total_cents is null then 'none' else 'stated' end));
  if not v_meets_requirement then
    perform private.audit(v_tenant.id, 'contract', v_id, 'deposit_requirement_overridden', 'staff', (select auth.uid()),
      jsonb_build_object('deposit_percent', v_tenant.deposit_percent, 'required_deposit_cents', v_required_deposit,
                         'total_cents', p_total_cents, 'deposit_cents', v_deposit));
  end if;
  if v_replaced is not null then
    perform private.audit(v_tenant.id, 'contract', v_replaced, 'draft_replaced', 'staff', (select auth.uid()),
      jsonb_build_object('replaced_by', v_id));
  end if;

  return jsonb_build_object('status', 'created', 'contract_id', v_id, 'content_sha256', v_hash, 'replaced_id', v_replaced);
end;
$$;
comment on function public.generate_direct_contract_draft(uuid, uuid, bigint, bigint, date, text, boolean, uuid) is
  'Generates a contract with no proposal on a contract-first event, from terms staff state. Never creates a proposal, selection or approval. Null total: no financial terms.';
revoke execute on function public.generate_direct_contract_draft(uuid, uuid, bigint, bigint, date, text, boolean, uuid) from public, anon;
grant execute on function public.generate_direct_contract_draft(uuid, uuid, bigint, bigint, date, text, boolean, uuid) to authenticated, service_role;
