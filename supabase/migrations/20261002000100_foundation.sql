-- Flux DJ foundation: privilege defaults, private helper schema and generic
-- validation/trigger functions shared by every tenant-owned table.
--
-- Security posture: deny by default. New tables and functions in `public`
-- receive no privileges for `anon` or `authenticated` until a migration grants
-- them explicitly. `service_role` keeps Supabase's defaults; server code using
-- it must perform its own authorization checks (spec section 7).

-- ---------------------------------------------------------------------------
-- Default privileges
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
-- Functions are executable by PUBLIC unless revoked globally.
alter default privileges for role postgres
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Private schema: helpers used by RLS policies and constraints. It is not in
-- the PostgREST exposed schemas, so nothing here is callable over the API.
-- `authenticated` needs USAGE so policies can evaluate helper calls.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- updated_at maintenance -----------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Immutable columns ------------------------------------------------------------
-- Usage: create trigger ... before update ... execute function
--          private.forbid_column_changes('id', 'tenant_id', ...);
-- Applies to every role, including service_role, so moving a row to another
-- tenant is impossible even when application code is wrong.
create function private.forbid_column_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
begin
  foreach col in array tg_argv loop
    if (to_jsonb(new) -> col) is distinct from (to_jsonb(old) -> col) then
      raise exception 'column %.% is immutable', tg_table_name, col
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

-- Validators used by check constraints ------------------------------------------
-- They return NULL for NULL input, which a CHECK constraint accepts, so
-- optional columns stay optional. Required columns use NOT NULL separately.
-- Marked immutable so they can be used in CHECK constraints. The timezone list
-- only grows between PostgreSQL releases, which makes this safe in practice.
create function private.is_valid_timezone(tz text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = tz);
$$;

create function private.is_valid_email(email text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select length(email) <= 320
     and email = lower(btrim(email))
     and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
$$;

-- Brand colors: an object whose keys come from a fixed list and whose values
-- are #RRGGBB hex strings. Example: {"primary":"#1A1A2E","accent":"#E94560"}.
create function private.is_valid_brand_colors(colors jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(colors) = 'object'
     and not exists (
       select 1
       from jsonb_each(colors) as e(key, value)
       where e.key not in ('primary', 'accent', 'background', 'foreground', 'muted')
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') !~ '^#[0-9A-Fa-f]{6}$'
     );
$$;

-- Tax configuration: an array (max 5) of
--   {"code":"GST","label":"GST","rate_ppm":50000}
-- rate_ppm is parts per million (50000 = 5%, 99750 = 9.975%), an integer so
-- rates are exact. Codes are unique. No rates are hardcoded; each DJ sets them.
create function private.is_valid_tax_config(config jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(config) = 'array'
     and jsonb_array_length(config) <= 5
     and not exists (
       select 1
       from jsonb_array_elements(config) as t(item)
       where jsonb_typeof(t.item) <> 'object'
          or (select count(*) from jsonb_object_keys(t.item)) <> 3
          or jsonb_typeof(t.item -> 'code') <> 'string'
          or (t.item ->> 'code') !~ '^[A-Z0-9_]{1,16}$'
          or jsonb_typeof(t.item -> 'label') <> 'string'
          or length(btrim(t.item ->> 'label')) not between 1 and 40
          or jsonb_typeof(t.item -> 'rate_ppm') <> 'number'
          or (t.item ->> 'rate_ppm') !~ '^[0-9]+$'
          or (t.item ->> 'rate_ppm')::bigint > 1000000
     )
     and (
       select count(distinct t.item ->> 'code') = count(*)
       from jsonb_array_elements(config) as t(item)
     );
$$;

-- Slugs appear in client URLs as fluxdj.com/{slug}/..., so they must not
-- collide with application routes.
create function private.is_valid_tenant_slug(slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
     and slug !~ '--'
     and slug not in (
       'admin', 'api', 'app', 'assets', 'auth', 'callback', 'dashboard', 'flux',
       'fluxdj', 'help', 'legal', 'login', 'logout', 'manifest', 'offline',
       'privacy', 'public', 'settings', 'signin', 'signup', 'staff', 'static',
       'support', 'terms', 'www'
     );
$$;

grant execute on all functions in schema private to authenticated, service_role;
