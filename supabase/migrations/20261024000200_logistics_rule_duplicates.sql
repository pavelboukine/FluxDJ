-- No two identical active logistics rules.
--
-- Why a migration: matching rules add their quantities (two rules requiring
-- one speaker each require two), so an identical active rule saved twice
-- silently doubles what clients must take. The app checked for one before
-- inserting, but two submissions at once (or a retry racing the original)
-- could both pass that check, and editing or restoring a rule didn't check at
-- all. This trigger enforces it in the database, for every writer.
--
-- Identical means the same question, gear, quantity, reason (as stored) and
-- condition, comparing "any of" values in any order and a one-value "any of"
-- as "is". Archived rules never count, so archiving is always allowed.
-- A per-question transaction lock serializes concurrent writes, so the second
-- of two simultaneous identical rules sees the first and is refused.
--
-- A trigger rather than a unique index: duplicates saved before this
-- migration would make the index fail to build, and they must not be removed
-- automatically. They are left as they are; editing one into something
-- distinct, or archiving it, works as usual. Nothing else changes: pricing
-- still adds the quantities of distinct matching rules.

-- The condition in one canonical form, for comparisons only.
create function private.rule_condition_key(p_condition jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_condition ->> 'op' = 'in' and jsonb_typeof(p_condition -> 'values') = 'array' then (
      select case
        when count(distinct v) = 1 then jsonb_build_object('op', 'equals', 'value', to_jsonb(min(v)))
        else jsonb_build_object('op', 'in', 'values', coalesce(jsonb_agg(distinct v order by v), '[]'::jsonb))
      end
      from jsonb_array_elements_text(p_condition -> 'values') v
    )
    else p_condition
  end;
$$;
revoke execute on function private.rule_condition_key(jsonb) from public, anon, authenticated;

create function private.forbid_duplicate_logistics_rule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.active then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('flux:logistics-rule:' || new.question_id::text, 0));
  if exists (
    select 1 from public.logistics_rules r
    where r.tenant_id = new.tenant_id
      and r.question_id = new.question_id
      and r.id <> new.id
      and r.active
      and r.gear_item_id = new.gear_item_id
      and r.required_quantity = new.required_quantity
      and r.reason = new.reason
      and private.rule_condition_key(r.condition) = private.rule_condition_key(new.condition)
  ) then
    raise exception 'rule_duplicate: an identical active rule already exists for this question'
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;
revoke execute on function private.forbid_duplicate_logistics_rule() from public, anon, authenticated;

create trigger logistics_rules_no_duplicates before insert or update on public.logistics_rules
  for each row execute function private.forbid_duplicate_logistics_rule();
