-- Proposal discounts, refinements to 20261119000100_proposal_discounts.sql.
--
-- 1. A fixed discount may be as large as the offer's lowest possible
--    subtotal, not only its lowest package price. private.offer_min_subtotal
--    (mirrors minimumSelectionSubtotal in src/lib/pricing/discount.ts) tries
--    every package with every combination of answers to the required yes/no
--    and single-choice questions that have gear rules: the only answers a
--    client must give that can add charges. Optional add-ons count as zero,
--    optional questions as unanswered and multi-choice questions as "none".
--    Prices are the offer's own (custom prices included); required gear is
--    charged as pricing charges it (beyond what the package includes). Above
--    4,096 combinations it falls back to the lowest package price, which never
--    exceeds the true minimum. A discount larger than a client's actual
--    subtotal was already impossible (pricing takes min(amount, subtotal)), so
--    no total, tax or balance can be negative either way.
--    private.build_offer_snapshot (the wrapper from 20261119000100) now checks
--    against it; offers already sent keep their frozen snapshot.
--
-- 2. client_payment_summary adds "pricing" only when the contract being viewed
--    was generated from a discounted proposal: its frozen subtotal before the
--    discount, the discount, the subtotal after it, the taxes and the total,
--    read from the contract's commercial snapshot (never recalculated). Without
--    a discount the result is exactly as before.
--
-- Migration-first: the previously deployed app sends no discount and ignores
-- the added key.

create function private.offer_min_subtotal(p_offer jsonb)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_lowest bigint;
  v_combinations numeric := 1;
  v_count int;
  v_min bigint;
begin
  select min((p ->> 'base_price_cents')::bigint) into v_lowest from jsonb_array_elements(p_offer -> 'packages') p;

  for v_count in
    select case q ->> 'answer_type' when 'boolean' then 2 else jsonb_array_length(q -> 'options') end
    from jsonb_array_elements(p_offer -> 'questions') q
    where (q ->> 'required')::boolean and q ->> 'answer_type' in ('boolean', 'single_choice')
      and exists (select 1 from jsonb_array_elements(p_offer -> 'rules') r where r ->> 'question_key' = q ->> 'key')
  loop
    v_combinations := v_combinations * v_count;
  end loop;
  if v_combinations > 4096 then
    return v_lowest;
  end if;

  with recursive varying as (
    select row_number() over (order by x.ord) as i, q ->> 'key' as key,
           case q ->> 'answer_type' when 'boolean' then '[true, false]'::jsonb
                else (select jsonb_agg(o -> 'value') from jsonb_array_elements(q -> 'options') o) end as vals
    from jsonb_array_elements(p_offer -> 'questions') with ordinality as x(q, ord)
    where (q ->> 'required')::boolean and q ->> 'answer_type' in ('boolean', 'single_choice')
      and exists (select 1 from jsonb_array_elements(p_offer -> 'rules') r where r ->> 'question_key' = q ->> 'key')
  ),
  combos(i, answers) as (
    select 0::bigint, '{}'::jsonb
    union all
    select c.i + 1, c.answers || jsonb_build_object(v.key, val.value)
    from combos c
    join varying v on v.i = c.i + 1
    cross join jsonb_array_elements(v.vals) as val(value)
  ),
  complete as (
    select c.answers from combos c where c.i = (select count(*) from varying)
  ),
  -- Gear the answers require (rules of the same gear add up), per combination.
  required as (
    select c.answers, r ->> 'gear_key' as gear, sum((r ->> 'required_quantity')::bigint) as qty
    from complete c
    cross join jsonb_array_elements(p_offer -> 'rules') r
    where c.answers ? (r ->> 'question_key')
      and case r -> 'condition' ->> 'op'
            when 'equals' then (c.answers -> (r ->> 'question_key')) = (r -> 'condition' -> 'value')
            when 'in' then (r -> 'condition' -> 'values') @> jsonb_build_array(c.answers -> (r ->> 'question_key'))
            else false
          end
    group by c.answers, r ->> 'gear_key'
  ),
  subtotals as (
    select (pk ->> 'base_price_cents')::bigint + coalesce((
             select sum(greatest(0, rq.qty - coalesce((
                          select (inc ->> 'quantity')::bigint from jsonb_array_elements(pk -> 'included') inc
                          where inc ->> 'gear_key' = rq.gear), 0))
                        * (p_offer -> 'gear' -> rq.gear ->> 'unit_price_cents')::bigint)
             from required rq where rq.answers = c.answers), 0) as subtotal
    from complete c
    cross join jsonb_array_elements(p_offer -> 'packages') pk
  )
  select min(s.subtotal) into v_min from subtotals s;
  return coalesce(v_min, v_lowest);
end;
$$;
revoke execute on function private.offer_min_subtotal(jsonb) from public, anon, authenticated;

-- Unchanged from 20261119000100_proposal_discounts.sql apart from the fixed
-- discount's limit: the lowest possible subtotal. Replacing keeps its privileges.
create or replace function private.build_offer_snapshot(p_tenant_id uuid, p_offer jsonb)
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
    v_lowest := private.offer_min_subtotal(v_snapshot);
    if v_value > v_lowest then
      perform private.offer_error('the fixed discount can''t be more than the lowest possible subtotal of this proposal ('
        || private.format_cents(v_lowest, v_snapshot ->> 'currency') || ')');
    end if;
    return v_snapshot || jsonb_build_object('discount', jsonb_build_object('type', 'fixed', 'amount_cents', v_value, 'label', v_label));
  end if;
  return v_snapshot || jsonb_build_object('discount', jsonb_build_object('type', 'percent', 'percent_basis_points', v_value, 'label', v_label));
end;
$$;

-- Unchanged from 20261009000100_booking_policy.sql apart from "pricing", added
-- only for a contract generated from a discounted proposal. Replacing keeps
-- its privileges.
create or replace function public.client_payment_summary(p_contract_id uuid, p_tenant_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts%rowtype;
  s jsonb;
begin
  select k.* into c from public.contracts k join public.tenants t on t.id = k.tenant_id
  where k.id = p_contract_id and t.slug = p_tenant_slug;
  if not found or not private.client_can_read_contract(c.id) then
    return null;
  end if;
  s := private.event_payment_summary(c.event_id);
  return jsonb_build_object(
    'currency', s ->> 'currency',
    'terms_status', s -> 'terms' ->> 'status',
    'total_cents', s -> 'terms' -> 'total_cents',
    'deposit_percent', s -> 'terms' -> 'deposit_percent',
    'deposit_cents', s -> 'terms' -> 'deposit_cents',
    'balance_due_date', s -> 'terms' -> 'balance_due_date',
    'received_cents', s -> 'received_cents',
    'deposit_outstanding_cents', s -> 'deposit_outstanding_cents',
    'remaining_balance_cents', s -> 'remaining_balance_cents',
    'credit_cents', s -> 'credit_cents',
    'invoice_url', s -> 'invoice_url',
    'booking_status', case s -> 'booking' ->> 'lifecycle_status' when 'booked' then 'booked' when 'awaiting_deposit' then 'awaiting_deposit' end
  )
  -- The viewed contract's frozen price breakdown, only when it has a discount.
  || case when c.commercial_snapshot ? 'discount' then jsonb_build_object('pricing', jsonb_build_object(
       'subtotal_cents', c.commercial_snapshot -> 'subtotal_cents',
       'discount', c.commercial_snapshot -> 'discount',
       'discounted_subtotal_cents', c.commercial_snapshot -> 'discounted_subtotal_cents',
       'tax_breakdown', (select coalesce(jsonb_agg(jsonb_build_object('label', t ->> 'label', 'rate_ppm', t -> 'rate_ppm', 'amount_cents', t -> 'amount_cents') order by ord), '[]'::jsonb)
                         from jsonb_array_elements(c.commercial_snapshot -> 'tax_breakdown') with ordinality as x(t, ord)),
       'total_cents', c.commercial_snapshot -> 'total_cents'))
     else '{}'::jsonb end;
end;
$$;
