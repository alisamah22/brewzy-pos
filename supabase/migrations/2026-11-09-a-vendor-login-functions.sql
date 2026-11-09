-- Brewzy POS — vendor login helpers. Run once, before 2026-11-09-vendor-logins.sql.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- Vendors log in to the app with a user name and password. Supabase stores a
-- login under an email, so the user name becomes <username>@brewzy-pos.example.com
-- behind the scenes (nobody receives mail there). Use these from the SQL Editor:
--
--   select create_vendor_login('brewzy', 'their-password');   -- add a vendor
--   select set_vendor_password('brewzy', 'new-password');      -- change a password
--
-- They can't be called from the app or the internet, only from the SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_vendor_login(username text, password text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
declare
  uid  uuid := gen_random_uuid();
  name text := lower(trim(username));
  mail text := lower(trim(username)) || '@brewzy-pos.example.com';
begin
  if name !~ '^[a-z0-9._-]+$' then
    raise exception 'User name can only use letters, numbers, dot, dash and underscore.';
  end if;
  if length(password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;
  if exists (select 1 from auth.users where email = mail) then
    raise exception 'The user name "%" is already taken.', name;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', mail,
    extensions.crypt(password, extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('username', name), now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', mail, 'email_verified', true),
    'email', now(), now(), now()
  );

  return uid;
end
$$;

create or replace function public.set_vendor_password(username text, password text)
returns void
language plpgsql
security definer
set search_path = public, extensions, auth
as $$
begin
  if length(password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(password, extensions.gen_salt('bf')), updated_at = now()
   where email = lower(trim(username)) || '@brewzy-pos.example.com';
  if not found then
    raise exception 'No vendor login named "%".', lower(trim(username));
  end if;
end
$$;

-- Only the SQL Editor (database owner) may use these.
revoke all on function public.create_vendor_login(text, text) from public, anon, authenticated;
revoke all on function public.set_vendor_password(text, text) from public, anon, authenticated;
