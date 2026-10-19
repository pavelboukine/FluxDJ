-- Proposal discounts: one discount on the whole proposal, set by staff,
-- frozen with the offer, applied to the client's selection before taxes, and
-- carried into the approval, the contract, the deposit and the balance.
--
-- Draft offers (proposals.draft_offer) may carry "discount":
--   {"type": "percent", "percent_basis_points": 0..10000, "label": text|null}
--   {"type": "fixed", "amount_cents": 0..100000000, "label": text|null}
-- Basis points: 1000 = 10%, 1250 = 12.5%. Only staff edit drafts
-- (update_proposal_draft, unchanged), so only staff set a discount; clients
-- never supply one. A zero discount is the same as none.
--
-- Freezing (private.build_offer_snapshot, now a wrapper around the unchanged
-- builder, renamed private.build_offer_snapshot_catalog): a non-zero discount
-- is frozen as "discount" {type, percent_basis_points | amount_cents, label},
-- the label trimmed and "Discount" when empty. A fixed amount may not exceed
-- the lowest offered package price (after this proposal's custom prices), so
-- no selection can cost less than nothing. Offers without a discount are
-- frozen exactly as before, so sent offers, their hashes and the previously
-- deployed app (which rejects unknown snapshot fields) are unaffected.
--
-- Pricing policy (mirrors src/lib/pricing/discount.ts):
--   subtotal  = sum of line totals (unchanged meaning)
--   discount  = round_half_up(subtotal * basis_points / 10000), or
--               min(amount, subtotal) for a fixed amount
--   allocation: the discount is split over the lines in proportion to their
--               totals (largest remainder, ties to the lower line number);
--   taxes     = per line, per tax, half up, on each line's discounted amount
--               (the existing rounding rule, now on the discounted base, as
--               Canadian GST/HST/QST apply to the reduced price);
--   total     = subtotal - discount + taxes.
-- Selections and their lines gain discount_cents (default 0: every stored
-- selection keeps its amounts and still verifies). The total check becomes
-- total = subtotal - discount + taxes, which existing rows satisfy.
-- private.verify_proposal_selection recomputes the discount, the allocation
-- and the taxes from the frozen offer, so no caller can store other amounts.
--
-- Contracts (generate_contract_draft): totals, deposit and balance already
-- come from the approved selection's total, so they use the discounted total.
-- New placeholders: {{pricing.discount}} ("Wedding Special (10%): -180.00
-- CAD", or "No discount.") and {{pricing.subtotal_before_discount}};
-- {{pricing.subtotal}} is the subtotal after the discount (the amount taxes
-- apply to), so a template's "Subtotal + taxes = Total" still adds up. Without
-- a discount every value is exactly as before. The commercial snapshot gains
-- "discount" and per-line "discount_cents" only when the selection has a
-- discount. Contracts already generated, sent or signed are stored documents
-- and are never re-rendered.
--
-- Migration-first: the previously deployed app never sends "discount", so it
-- stores, freezes, prices and contracts exactly as before.

-- ===========================================================================
-- Stored selections
-- ===========================================================================

alter table public.proposal_selections
  add column discount_cents bigint not null default 0
    constraint proposal_selections_discount_range check (discount_cents >= 0 and discount_cents <= subtotal_cents);
alter table public.proposal_selections drop constraint proposal_selections_total_sum;
alter table public.proposal_selections
  add constraint proposal_selections_total_sum check (total_cents = subtotal_cents - discount_cents + tax_cents);
comment on column public.proposal_selections.discount_cents is
  'The proposal discount applied to this selection (0 when the offer has none). total = subtotal - discount + tax.';

alter table public.proposal_selection_lines
  add column discount_cents bigint not null default 0
    constraint proposal_selection_lines_discount_range check (discount_cents >= 0 and discount_cents <= line_total_cents);
comment on column public.proposal_selection_lines.discount_cents is
  'This line''s share of the proposal discount; taxes apply to line_total_cents - discount_cents.';

drop trigger proposal_selections_immutable on public.proposal_selections;
create trigger proposal_selections_immutable before update on public.proposal_selections
  for each row execute function private.forbid_column_changes(
    'id', 'tenant_id', 'proposal_id', 'version', 'package_key', 'addon_quantities', 'logistics_answers',
    'subtotal_cents', 'discount_cents', 'tax_cents', 'total_cents', 'currency', 'tax_breakdown', 'selection_snapshot',
    'pricing_version', 'offer_sha256', 'created_at');

-- ===========================================================================
-- Draft offers
-- ===========================================================================

create function private.is_valid_discount(d jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when jsonb_typeof(d) <> 'object' then false
    when jsonb_typeof(d -> 'label') is not null and jsonb_typeof(d -> 'label') not in ('string', 'null') then false
    when length(coalesce(d ->> 'label', '')) > 80 then false
    when d ->> 'type' = 'percent' then
      not exists (select 1 from jsonb_object_keys(d) k where k not in ('type', 'percent_basis_points', 'label'))
      and case when jsonb_typeof(d -> 'percent_basis_points') is distinct from 'number'
                 or (d ->> 'percent_basis_points') !~ '^[0-9]{1,5}$' then false
               else (d ->> 'percent_basis_points')::int <= 10000 end
    when d ->> 'type' = 'fixed' then
      not exists (select 1 from jsonb_object_keys(d) k where k not in ('type', 'amount_cents', 'label'))
      and case when jsonb_typeof(d -> 'amount_cents') is distinct from 'number'
                 or (d ->> 'amount_cents') !~ '^[0-9]{1,9}$' then false
               else (d ->> 'amount_cents')::bigint <= 100000000 end
    else false
  end;
$$;
-- Used by is_valid_draft_offer, which check constraints run as the calling role.
revoke execute on function private.is_valid_discount(jsonb) from public, anon;
grant execute on function private.is_valid_discount(jsonb) to authenticated, service_role;

-- Unchanged from 20261108000100_gear_categories_custom_prices.sql apart from
-- the optional "discount".
create or replace function private.is_valid_draft_offer(draft jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select jsonb_typeof(draft) = 'object'
     and not exists (select 1 from jsonb_object_keys(draft) k
                     where k not in ('template_id', 'intro', 'expiry_days', 'packages', 'addons', 'question_ids', 'price_overrides', 'discount'))
     and coalesce(jsonb_typeof(draft -> 'template_id') in ('string', 'null'), true)
     and (jsonb_typeof(draft -> 'template_id') is distinct from 'string' or private.is_uuid_text(draft ->> 'template_id'))
     and coalesce(jsonb_typeof(draft -> 'intro') in ('string', 'null'), true)
     and coalesce(length(draft ->> 'intro') <= 10000, true)
     and coalesce(jsonb_typeof(draft -> 'expiry_days') in ('number', 'null'), true)
     and coalesce(jsonb_typeof(draft -> 'packages') = 'array' and jsonb_array_length(draft -> 'packages') <= 3, true)
     and coalesce(jsonb_typeof(draft -> 'addons') = 'array' and jsonb_array_length(draft -> 'addons') <= 100, true)
     and coalesce(jsonb_typeof(draft -> 'question_ids') = 'array' and jsonb_array_length(draft -> 'question_ids') <= 100, true)
     and coalesce(private.is_valid_price_overrides(draft -> 'price_overrides'), true)
     and (jsonb_typeof(draft -> 'discount') is null or jsonb_typeof(draft -> 'discount') = 'null' or private.is_valid_discount(draft -> 'discount'));
$$;

-- ===========================================================================
-- Freezing the offer
-- ===========================================================================

-- The existing builder, unchanged, under a new name; the wrapper below keeps
-- the name every caller uses (send_proposal, preview_proposal_draft, ...).
alter function private.build_offer_snapshot(uuid, jsonb) rename to build_offer_snapshot_catalog;

create function private.build_offer_snapshot(p_tenant_id uuid, p_offer jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_discount jsonb;
  v_snapshot jsonb;
  v_value bigint;
  v_label text;
  v_lowest bigint;
begin
  if jsonb_typeof(p_offer) = 'object' then
    v_discount := nullif(p_offer -> 'discount', 'null'::jsonb);
    if v_discount is not null and not private.is_valid_discount(v_discount) then
      perform private.offer_error('the discount must be a percentage from 0 to 100 or an amount from 0 to 1,000,000.00, with a description of at most 80 characters');
    end if;
    v_snapshot := private.build_offer_snapshot_catalog(p_tenant_id, p_offer - 'discount');
  else
    v_snapshot := private.build_offer_snapshot_catalog(p_tenant_id, p_offer);
  end if;
  if v_discount is null then
    return v_snapshot;
  end if;

  v_value := case v_discount ->> 'type' when 'percent' then (v_discount ->> 'percent_basis_points')::bigint
                                        else (v_discount ->> 'amount_cents')::bigint end;
  -- A zero discount is no discount: nothing is frozen.
  if v_value = 0 then
    return v_snapshot;
  end if;
  v_label := coalesce(nullif(btrim(v_discount ->> 'label'), ''), 'Discount');

  if v_discount ->> 'type' = 'fixed' then
    select min((pk ->> 'base_price_cents')::bigint) into v_lowest from jsonb_array_elements(v_snapshot -> 'packages') pk;
    if v_value > v_lowest then
      perform private.offer_error('the fixed discount can''t be more than the lowest package price (' || private.format_cents(v_lowest, v_snapshot ->> 'currency') || ')');
    end if;
    return v_snapshot || jsonb_build_object('discount', jsonb_build_object('type', 'fixed', 'amount_cents', v_value, 'label', v_label));
  end if;
  return v_snapshot || jsonb_build_object('discount', jsonb_build_object('type', 'percent', 'percent_basis_points', v_value, 'label', v_label));
end;
$$;
revoke execute on function private.build_offer_snapshot(uuid, jsonb) from public, anon, authenticated;

-- ===========================================================================
-- Discount arithmetic (mirrors src/lib/pricing/discount.ts)
-- ===========================================================================

create function private.offer_discount_cents(p_offer jsonb, p_subtotal bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_offer -> 'discount' is null or jsonb_typeof(p_offer -> 'discount') = 'null' then 0
    when p_offer -> 'discount' ->> 'type' = 'percent'
      then (p_subtotal * (p_offer -> 'discount' ->> 'percent_basis_points')::bigint + 5000) / 10000
    else least((p_offer -> 'discount' ->> 'amount_cents')::bigint, p_subtotal)
  end;
$$;
revoke execute on function private.offer_discount_cents(jsonb, bigint) from public, anon, authenticated;

-- ===========================================================================
-- Verifying stored selections
-- ===========================================================================

-- Unchanged from 20261002000400_offers_selections.sql apart from the
-- discount: its amount, its allocation to the lines, taxes on the discounted
-- line amounts, and the selection record's own discount fields. A selection
-- of an offer without a discount must have no discount anywhere.
create or replace function private.verify_proposal_selection(p_selection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.proposal_selections%rowtype;
  offer jsonb;
  offer_hash text;
  problem text;
begin
  select * into s from public.proposal_selections where id = p_selection_id;
  if not found then
    return;
  end if;

  select p.offer_snapshot, p.offer_sha256 into offer, offer_hash
  from public.proposals p
  where p.tenant_id = s.tenant_id and p.id = s.proposal_id;

  problem := case
    when s.offer_sha256 <> offer_hash then 'selection was priced against a different offer'
    when s.currency <> offer ->> 'currency' then 'currency does not match the offer'
    when not exists (select 1 from jsonb_array_elements(offer -> 'packages') pk where pk ->> 'key' = s.package_key)
      then 'package is not part of the offer'
    when (select count(*) from public.proposal_selection_lines l
          where l.selection_id = s.id and l.source = 'package') <> 1
      then 'exactly one package line is required'
    when exists (select 1 from public.proposal_selection_lines l
                 where l.selection_id = s.id and l.source = 'package' and l.item_key <> s.package_key)
      then 'package line does not match the selected package'
    else null
  end;

  -- Unit prices and tax categories must come from the frozen offer.
  if problem is null then
    select 'line ' || l.line_no || ' (' || l.item_key || ') does not match the frozen offer'
      into problem
    from public.proposal_selection_lines l
    left join lateral (
      select (pk ->> 'base_price_cents')::bigint as price, pk ->> 'tax_category' as tax_category
      from jsonb_array_elements(offer -> 'packages') pk
      where pk ->> 'key' = l.item_key
    ) pkg on l.source = 'package'
    left join lateral (
      select (offer -> 'gear' -> l.item_key ->> 'unit_price_cents')::bigint as price,
             offer -> 'gear' -> l.item_key ->> 'tax_category' as tax_category
    ) gear on l.source in ('optional', 'required', 'included')
    left join lateral (
      select (inc ->> 'quantity')::int as quantity
      from jsonb_array_elements(offer -> 'packages') pk,
           jsonb_array_elements(pk -> 'included') inc
      where pk ->> 'key' = s.package_key and inc ->> 'gear_key' = l.item_key
    ) incl on l.source = 'included'
    where l.selection_id = s.id
      and case l.source
        when 'package' then pkg.price is distinct from l.unit_price_cents
                         or pkg.tax_category is distinct from l.tax_category
        when 'included' then incl.quantity is distinct from l.quantity
                          or gear.tax_category is distinct from l.tax_category
        else gear.price is distinct from l.unit_price_cents
          or gear.tax_category is distinct from l.tax_category
      end
    order by l.line_no
    limit 1;
  end if;

  if problem is null and s.subtotal_cents <> (
    select coalesce(sum(l.line_total_cents), 0) from public.proposal_selection_lines l where l.selection_id = s.id
  ) then
    problem := 'subtotal does not equal the sum of line totals';
  end if;

  -- The discount, from the frozen offer and the subtotal.
  if problem is null and s.discount_cents <> private.offer_discount_cents(offer, s.subtotal_cents) then
    problem := 'discount does not match the frozen offer';
  end if;

  -- Its allocation: proportional to line totals, largest remainder first,
  -- ties to the lower line number.
  if problem is null then
    with l as (
      select l.line_no, l.line_total_cents, l.discount_cents,
             s.discount_cents::numeric * l.line_total_cents as share
      from public.proposal_selection_lines l
      where l.selection_id = s.id
    ),
    split as (
      select l.*,
             case when s.subtotal_cents = 0 then 0 else floor(l.share / s.subtotal_cents) end as base,
             case when s.subtotal_cents = 0 then 0 else mod(l.share, s.subtotal_cents) end as remainder
      from l
    ),
    ranked as (
      select split.*, row_number() over (order by split.remainder desc, split.line_no) as rank,
             s.discount_cents - sum(split.base) over () as extra
      from split
    )
    select 'line ' || r.line_no || ' has the wrong share of the discount' into problem
    from ranked r
    where r.discount_cents <> r.base + case when r.rank <= r.extra then 1 else 0 end
    order by r.line_no
    limit 1;
  end if;

  -- The selection record says the same about its discount.
  if problem is null and (
       coalesce(s.selection_snapshot ->> 'discount_cents', '0') <> s.discount_cents::text
       or (s.selection_snapshot ? 'discount') <> (offer ? 'discount')
       or (offer ? 'discount' and (
             s.selection_snapshot -> 'discount' ->> 'type' is distinct from offer -> 'discount' ->> 'type'
             or s.selection_snapshot -> 'discount' ->> 'label' is distinct from offer -> 'discount' ->> 'label'))
     ) then
    problem := 'the selection''s discount details do not match the frozen offer';
  end if;

  -- Recompute taxes with the frozen rates and the documented rounding
  -- policy, on each line's discounted amount.
  if problem is null then
    with rates as (
      select r ->> 'code' as code, r ->> 'label' as label, (r ->> 'rate_ppm')::bigint as rate_ppm,
             ord
      from jsonb_array_elements(offer -> 'tax' -> 'rates') with ordinality as x(r, ord)
    ),
    expected as (
      select rates.code, rates.label, rates.rate_ppm, rates.ord,
             coalesce(sum(l.line_total_cents - l.discount_cents) filter (where applies), 0) as taxable_cents,
             coalesce(sum(((l.line_total_cents - l.discount_cents) * rates.rate_ppm + 500000) / 1000000) filter (where applies), 0) as amount_cents
      from rates
      left join public.proposal_selection_lines l on l.selection_id = s.id
      left join lateral (
        select exists (
          select 1 from jsonb_array_elements_text(offer -> 'tax' -> 'categories' -> l.tax_category) c(code)
          where c.code = rates.code
        ) as applies
      ) a on true
      group by rates.code, rates.label, rates.rate_ppm, rates.ord
    ),
    expected_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', code, 'label', label, 'rate_ppm', rate_ppm,
               'taxable_cents', taxable_cents, 'amount_cents', amount_cents) order by ord), '[]'::jsonb) as breakdown,
             coalesce(sum(amount_cents), 0) as total_tax
      from expected
    )
    select case
      when s.tax_breakdown <> e.breakdown then 'tax breakdown does not match the frozen rates and rounding policy'
      when s.tax_cents <> e.total_tax then 'tax total does not equal the sum of rounded taxes'
    end
    into problem
    from expected_json e;
  end if;

  if problem is not null then
    raise exception 'invalid priced selection: %', problem using errcode = 'check_violation';
  end if;
end;
$$;

-- ===========================================================================
-- Recording selections
-- ===========================================================================

-- Unchanged from 20261003000200_send_submit_approve_functions.sql apart from
-- storing the discount (0 when the selection has none). Replacing keeps its
-- privileges.
create or replace function private.insert_selection_submission(p_proposal_id uuid, p_selection jsonb, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_selection_id uuid;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id;
  if v_proposal.offer_snapshot is null then
    raise exception 'the offer is not frozen yet' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.proposal_selections (
    tenant_id, proposal_id, version, package_key, addon_quantities, logistics_answers,
    subtotal_cents, discount_cents, tax_cents, total_cents, currency, tax_breakdown, selection_snapshot,
    pricing_version, offer_sha256, submitted_at, idempotency_key
  ) values (
    v_proposal.tenant_id, v_proposal.id, v_proposal.current_selection_version + 1,
    p_selection ->> 'package_key', p_selection -> 'addon_quantities', p_selection -> 'logistics_answers',
    (p_selection ->> 'subtotal_cents')::bigint, coalesce((p_selection ->> 'discount_cents')::bigint, 0),
    (p_selection ->> 'tax_cents')::bigint, (p_selection ->> 'total_cents')::bigint,
    p_selection ->> 'currency', p_selection -> 'tax_breakdown', p_selection,
    p_selection ->> 'pricing_version', p_selection ->> 'offer_sha256', now(), p_idempotency_key
  )
  returning id into v_selection_id;

  insert into public.proposal_selection_lines (
    tenant_id, selection_id, line_no, source, item_key, name, description, quantity,
    unit_price_cents, line_total_cents, required_quantity, required_reasons, tax_category, discount_cents
  )
  select v_proposal.tenant_id, v_selection_id, l.ord::int,
         l.x ->> 'source', l.x ->> 'item_key', l.x ->> 'name', l.x ->> 'description',
         (l.x ->> 'quantity')::int, (l.x ->> 'unit_price_cents')::bigint, (l.x ->> 'line_total_cents')::bigint,
         coalesce((l.x ->> 'required_quantity')::int, 0),
         coalesce(array(select jsonb_array_elements_text(l.x -> 'required_reasons')), '{}'),
         l.x ->> 'tax_category', coalesce((l.x ->> 'discount_cents')::bigint, 0)
  from jsonb_array_elements(p_selection -> 'lines') with ordinality as l(x, ord);

  update public.proposals set current_selection_version = v_proposal.current_selection_version + 1 where id = v_proposal.id;
  return v_selection_id;
end;
$$;

-- ===========================================================================
-- Contract placeholders (additions; pricing.subtotal is after any discount)
-- ===========================================================================

create or replace function private.contract_placeholders()
returns table (key text, label text, description text, missing_hint text, sort_order integer)
language sql
immutable
set search_path = ''
as $$
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
-- Contract generation
-- ===========================================================================

-- Unchanged from 20261109000100_package_prices_contract_quantities.sql apart
-- from the discount: {{pricing.discount}}, {{pricing.subtotal_before_discount}},
-- {{pricing.subtotal}} after the discount, and the commercial snapshot's
-- "discount", "discounted_subtotal_cents" and per-line "discount_cents"
-- (only with a discount; without one the snapshot is as before). Totals,
-- deposit and balance already come from the approved (discounted) total.
create or replace function public.generate_contract_draft(
  p_approval_id uuid,
  p_template_version_id uuid,
  p_balance_due_date date default null,
  p_replace_contract_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.proposal_approvals%rowtype;
  v_membership_id uuid;
  v_event_id uuid;
  v_event public.events%rowtype;
  v_proposal public.proposals%rowtype;
  v_selection public.proposal_selections%rowtype;
  v_tenant public.tenants%rowtype;
  v_version public.contract_template_versions%rowtype;
  v_template_active boolean;
  v_signer record;
  v_has_signer boolean;
  v_package record;
  v_deposit bigint;
  v_has_discount boolean;
  v_discount_text text;
  v_balance bigint;
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
  select * into v_approval from public.proposal_approvals where id = p_approval_id;
  if not found then
    raise exception 'not found' using errcode = 'no_data_found';
  end if;
  v_membership_id := private.require_staff_of(v_approval.tenant_id);

  -- Lock order everywhere: event, then proposal. The event lock serializes
  -- generation, so concurrent clicks cannot create two drafts.
  select p.event_id into v_event_id from public.proposals p
  where p.tenant_id = v_approval.tenant_id and p.id = v_approval.proposal_id;
  select * into v_event from public.events where tenant_id = v_approval.tenant_id and id = v_event_id for update;
  select * into v_proposal from public.proposals where tenant_id = v_approval.tenant_id and id = v_approval.proposal_id for update;
  select * into v_selection from public.proposal_selections where tenant_id = v_approval.tenant_id and id = v_approval.selection_id;
  select * into v_tenant from public.tenants where id = v_approval.tenant_id;

  if v_proposal.status <> 'approved' or v_event.active_proposal_id is distinct from v_proposal.id then
    raise exception 'contract_stale_approval: this approval is no longer current because a revised offer replaced it'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_event.lifecycle_status <> 'awaiting_signature' then
    raise exception 'contract_not_allowed: the event is %', replace(v_event.lifecycle_status, '_', ' ')
      using errcode = 'invalid_parameter_value';
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

  if p_balance_due_date is not null then
    if not ('payment.balance_due_date' = any (v_version.placeholders)) then
      raise exception 'contract_input_invalid: this template version has no balance due date, so leave it blank'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_balance_due_date < (now() at time zone v_event.timezone)::date then
      raise exception 'contract_input_invalid: the balance due date is in the past' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Parties, copied now -------------------------------------------------------
  select c.id, c.name, c.email, c.phone, c.archived_at into v_signer
  from public.event_clients ec
  join public.clients c on c.tenant_id = ec.tenant_id and c.id = ec.client_id
  where ec.tenant_id = v_event.tenant_id and ec.event_id = v_event.id and ec.can_sign;
  v_has_signer := found;

  -- Commercial terms, from the approved selection only -------------------------
  select l.item_key, l.name, l.unit_price_cents into v_package
  from public.proposal_selection_lines l
  where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source = 'package';

  -- The tenant's deposit percentage, frozen below; deposit rounded half up
  -- to the cent from the approved total; balance = total - deposit.
  v_deposit := private.contract_deposit_cents(v_selection.total_cents, v_tenant.deposit_percent);
  v_balance := v_selection.total_cents - v_deposit;
  -- The approved selection's discount (its total is already discounted).
  v_has_discount := v_selection.selection_snapshot ? 'discount';
  v_discount_text := case when v_selection.discount_cents > 0 then
      (v_selection.selection_snapshot -> 'discount' ->> 'label')
      || case when v_selection.selection_snapshot -> 'discount' ->> 'type' = 'percent'
              then ' (' || private.format_rate_ppm((v_selection.selection_snapshot -> 'discount' ->> 'percent_basis_points')::bigint * 100) || ')'
              else '' end
      || ': ' || private.format_cents(-v_selection.discount_cents, v_selection.currency)
    else 'No discount.' end;

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
    'package.name', v_package.name,
    'package.price', private.format_cents(v_package.unit_price_cents, v_selection.currency),
    -- Quantities read as on the approved proposal, from its frozen gear
    -- ("1 pair of Moving Heads (2 lights)"); older offers read as before.
    'package.included', coalesce((
      select string_agg('- ' || private.gear_quantity_text(v_proposal.offer_snapshot -> 'gear' -> l.item_key, l.name, l.quantity), E'\n' order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source = 'included'
    ), 'No gear is listed as included in the package.'),
    'gear.extras', coalesce((
      select string_agg(
        '- ' || private.gear_quantity_text(v_proposal.offer_snapshot -> 'gear' -> l.item_key, l.name, l.quantity)
        || ': ' || private.format_cents(l.line_total_cents, v_selection.currency)
        || case when l.source = 'required' then ' (required: ' || array_to_string(l.required_reasons, '; ') || ')' else '' end,
        E'\n' order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id and l.source in ('optional', 'required')
    ), 'No additional gear.'),
    'pricing.subtotal_before_discount', private.format_cents(v_selection.subtotal_cents, v_selection.currency),
    'pricing.discount', v_discount_text,
    'pricing.subtotal', private.format_cents(v_selection.subtotal_cents - v_selection.discount_cents, v_selection.currency),
    'pricing.taxes', coalesce((
      select string_agg(
        '- ' || (t ->> 'label') || ' (' || private.format_rate_ppm((t ->> 'rate_ppm')::bigint) || '): '
        || private.format_cents((t ->> 'amount_cents')::bigint, v_selection.currency),
        E'\n' order by ord)
      from jsonb_array_elements(v_selection.tax_breakdown) with ordinality as x(t, ord)
    ), 'No taxes apply.'),
    'pricing.tax_total', private.format_cents(v_selection.tax_cents, v_selection.currency),
    'pricing.total', private.format_cents(v_selection.total_cents, v_selection.currency),
    'pricing.currency', v_selection.currency,
    'payment.deposit_percent', v_tenant.deposit_percent::text || '%',
    'payment.deposit', private.format_cents(v_deposit, v_selection.currency),
    'payment.balance', private.format_cents(v_balance, v_selection.currency),
    'payment.balance_due_date', to_char(p_balance_due_date, 'FMMonth FMDD, YYYY')
  );

  -- Every placeholder the template uses needs a real value, and a signer is
  -- always required. Nothing is stored when anything is missing.
  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'label', p.label, 'hint', p.missing_hint) order by p.sort_order), '[]')
    into v_missing
  from private.contract_placeholders() p
  where p.key = any (v_version.placeholders) and v_values ->> p.key is null;
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
  v_commercial := jsonb_build_object(
    'schema_version', 1,
    'currency', v_selection.currency,
    'package', jsonb_build_object('key', v_package.item_key, 'name', v_package.name, 'base_price_cents', v_package.unit_price_cents),
    'lines', (
      select jsonb_agg(jsonb_build_object(
        'line_no', l.line_no, 'source', l.source, 'item_key', l.item_key, 'name', l.name, 'description', l.description,
        'quantity', l.quantity, 'unit_price_cents', l.unit_price_cents, 'line_total_cents', l.line_total_cents,
        'required_quantity', l.required_quantity, 'required_reasons', to_jsonb(l.required_reasons),
        'tax_category', l.tax_category)
        || case when v_has_discount then jsonb_build_object('discount_cents', l.discount_cents) else '{}'::jsonb end
        order by l.line_no)
      from public.proposal_selection_lines l
      where l.tenant_id = v_selection.tenant_id and l.selection_id = v_selection.id
    ),
    'subtotal_cents', v_selection.subtotal_cents,
    'tax_breakdown', v_selection.tax_breakdown,
    'tax_cents', v_selection.tax_cents,
    'total_cents', v_selection.total_cents,
    'payment', jsonb_build_object(
      'deposit_percent', v_tenant.deposit_percent,
      'deposit_basis_points', v_tenant.deposit_percent * 100,
      'deposit_rounding', 'half_up_to_cent',
      'deposit_due', 'on_signing',
      'deposit_cents', v_deposit,
      'balance_cents', v_balance,
      'balance_due_date', p_balance_due_date
    ),
    'source', jsonb_build_object(
      'proposal_id', v_proposal.id, 'proposal_revision', v_proposal.revision, 'offer_sha256', v_proposal.offer_sha256,
      'selection_id', v_selection.id, 'selection_version', v_selection.version,
      'approval_id', v_approval.id, 'selection_sha256', v_approval.selection_sha256, 'approved_at', v_approval.approved_at
    )
  );
  -- Only with a discount, so a contract without one is generated exactly as before.
  if v_has_discount then
    v_commercial := v_commercial || jsonb_build_object(
      'discount', (v_selection.selection_snapshot -> 'discount') || jsonb_build_object('amount_cents', v_selection.discount_cents),
      'discounted_subtotal_cents', v_selection.subtotal_cents - v_selection.discount_cents);
  end if;
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

  -- One draft per event: repeat or replace explicitly ---------------------------
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
    tenant_id, event_id, proposal_id, selection_id, approval_id, template_id, template_version_id,
    template_content_sha256, replaces_id, signer_client_id, signer_name, signer_email, currency,
    total_cents, deposit_percent, deposit_cents, balance_cents, balance_due_date, rendered_content, commercial_snapshot,
    party_snapshot, content_sha256, generated_by_membership_id, generated_by_user_id
  ) values (
    v_tenant.id, v_event.id, v_proposal.id, v_selection.id, v_approval.id, v_version.template_id, v_version.id,
    v_version.content_sha256, v_replaced, v_signer.id, v_signer.name, v_signer.email, v_selection.currency,
    v_selection.total_cents, v_tenant.deposit_percent, v_deposit, v_balance, p_balance_due_date, v_rendered, v_commercial,
    v_parties, v_hash, v_membership_id, (select auth.uid())
  )
  returning id, content_sha256 into v_id, v_hash;

  perform private.audit(v_tenant.id, 'contract', v_id, case when v_replaced is null then 'draft_generated' else 'draft_regenerated' end,
    'staff', (select auth.uid()),
    jsonb_build_object('event_id', v_event.id, 'approval_id', v_approval.id, 'template_version_id', v_version.id,
                       'content_sha256', v_hash, 'replaces_id', v_replaced));
  if v_replaced is not null then
    perform private.audit(v_tenant.id, 'contract', v_replaced, 'draft_replaced', 'staff', (select auth.uid()),
      jsonb_build_object('replaced_by', v_id));
  end if;

  return jsonb_build_object('status', 'created', 'contract_id', v_id, 'content_sha256', v_hash, 'replaced_id', v_replaced);
end;
$$;
