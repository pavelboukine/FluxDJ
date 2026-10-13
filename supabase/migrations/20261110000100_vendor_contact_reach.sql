-- Planning vendors need a way to reach them.
--
-- A vendor in Contacts and vendors now needs a phone or an email (the name or
-- business rule is unchanged). Checked when the contacts item is saved, by
-- client or staff, against the answers stored at that moment:
--   - a new vendor, or one stored with a phone or email, needs one of them;
--   - a vendor stored without either (saved before this rule) may stay so,
--     even when renamed, so older plans keep saving their other answers
--     (the day-of contact is in the same item) until someone adds one.
-- No stored answers are changed, and completion rules are unchanged.
-- save_plan_item is redefined only to add this check beside the existing
-- reference checks; its signature and every other step are as before.

create function private.check_plan_vendor_reach(p_editor text, p_stored jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_editor = 'contacts' then (
    select jsonb_build_object('status', 'invalid', 'field', 'entry:' || (v ->> 'id') || ':phone',
             'message', 'Enter a phone number or an email address for this vendor.')
    from jsonb_array_elements(coalesce(p_new -> 'vendors', '[]'::jsonb)) with ordinality as n(v, position)
    where not (v ? 'phone' or v ? 'email')
      and not exists (
        select 1 from jsonb_array_elements(coalesce(p_stored -> 'vendors', '[]'::jsonb)) o
        where o ->> 'id' = v ->> 'id' and not (o ? 'phone' or o ? 'email'))
    order by position
    limit 1)
  end;
$$;

revoke execute on function private.check_plan_vendor_reach(text, jsonb, jsonb) from public, anon, authenticated;

create or replace function private.save_plan_item(p_plan_id uuid, p_item_id uuid, p_expected_revision integer, p_answers jsonb, p_actor text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.event_plan_items%rowtype;
  v_editor text;
  v_resp public.event_plan_responses%rowtype;
  v_norm jsonb;
  v_links jsonb;
  v_replay_safe boolean;
begin
  select * into v_item from public.event_plan_items where plan_id = p_plan_id and id = p_item_id;
  if not found then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select l.editor into v_editor from private.planning_library() l where l.key = v_item.key;
  if v_editor is null or v_editor in ('stage_details', 'included') or v_item.disabled_at is not null
     or exists (select 1 from public.event_plan_items p where p.id = v_item.parent_id and p.disabled_at is not null) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_norm := private.normalize_plan_answers(v_editor, p_answers);
  if not (v_norm ->> 'ok')::boolean then
    return jsonb_build_object('status', 'invalid', 'field', v_norm -> 'field', 'message', v_norm ->> 'message');
  end if;
  v_replay_safe := private.is_music_editor(v_editor) or private.is_moment_editor(v_editor);
  select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
  v_links := coalesce(private.check_plan_song_links(p_plan_id, v_item.key, v_resp.answers, v_norm -> 'answers'),
                      private.check_plan_contact_refs(p_plan_id, v_editor, v_norm -> 'answers'),
                      private.check_plan_vendor_reach(v_editor, v_resp.answers, v_norm -> 'answers'));
  if v_links is not null then
    return v_links;
  end if;
  if v_resp.id is null then
    if p_expected_revision is distinct from 0 then
      return jsonb_build_object('status', 'conflict');
    end if;
    insert into public.event_plan_responses (tenant_id, plan_id, item_id, answers, updated_by_actor, updated_by_user_id)
    values (v_item.tenant_id, p_plan_id, v_item.id, v_norm -> 'answers', p_actor, p_user_id)
    on conflict (item_id) do nothing
    returning * into v_resp;
    if v_resp.id is null then
      -- A concurrent first save won: the same answers are this save, already stored.
      select * into v_resp from public.event_plan_responses where item_id = v_item.id for update;
      if not (v_replay_safe and v_resp.answers = v_norm -> 'answers') then
        return jsonb_build_object('status', 'conflict');
      end if;
    end if;
  elsif p_expected_revision is distinct from v_resp.revision then
    -- A retried or doubled save (same entry ids) is already stored.
    if not (v_replay_safe and v_resp.answers = v_norm -> 'answers') then
      return jsonb_build_object('status', 'conflict');
    end if;
  elsif v_resp.answers is distinct from v_norm -> 'answers' or not v_replay_safe then
    update public.event_plan_responses
      set answers = v_norm -> 'answers', revision = revision + 1, updated_by_actor = p_actor, updated_by_user_id = p_user_id
      where id = v_resp.id returning * into v_resp;
  end if;
  return jsonb_build_object('status', 'saved', 'revision', v_resp.revision, 'answers', v_resp.answers,
                            'progress', private.plan_progress(p_plan_id), 'timeline_warnings', private.plan_timeline_warnings(p_plan_id));
end;
$$;
