-- Brewzy POS migration — super admin. Run once, after 2026-11-09-c-staff-and-day-close.sql.
-- Supabase dashboard: SQL Editor -> New query -> paste -> Run. Safe to re-run.
--
-- A super admin sees every vendor and every vendor's admins and cashiers, and
-- can add vendors, rename logins, change passwords and roles. They have no
-- shop of their own. Make one (or reset its password) with:
--
--   select make_super_admin('brew', '<password>');

create table if not exists public.super_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.super_admins enable row level security;
-- Read only through the functions below.

create or replace function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.super_admins where user_id = auth.uid())
$$;

-- SQL Editor only: create the super admin login (or reset its password).
create or replace function public.make_super_admin(username text, password text)
returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where email = lower(trim(username)) || '@brewzy-pos.example.com';
  if uid is null then
    uid := public.create_vendor_login(username, password);
  else
    perform public.set_vendor_password(username, password);
  end if;
  insert into public.super_admins (user_id) values (uid) on conflict do nothing;
end $$;

-- whoami also says whether the login is a super admin.
create or replace function public.whoami() returns json
language sql stable security definer set search_path = public, auth as $$
  select json_build_object(
    'user_id', auth.uid(),
    'username', split_part((select email from auth.users where id = auth.uid()), '@', 1),
    'vendor_id', public.my_vendor(),
    'vendor_username', split_part((select email from auth.users where id = public.my_vendor()), '@', 1),
    'role', public.my_role(),
    'super', public.is_super()
  )
$$;

-- Every login: vendors (main logins) and their staff.
create or replace function public.super_list_logins()
returns table (username text, vendor_username text, role text, kind text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_super() then raise exception 'Only a super admin can do this.'; end if;
  return query
    select split_part(u.email, '@', 1)::text,
           split_part(coalesce(v.email, u.email), '@', 1)::text,
           coalesce(m.role, 'admin')::text,
           (case when s.user_id is not null then 'super' when m.user_id is not null then 'staff' else 'vendor' end)::text,
           u.created_at, u.last_sign_in_at
      from auth.users u
      left join public.vendor_members m on m.user_id = u.id
      left join auth.users v on v.id = m.vendor_id
      left join public.super_admins s on s.user_id = u.id
     where u.email like '%@brewzy-pos.example.com'
     order by 2, (m.user_id is not null), 1;
end $$;

create or replace function public.super_create_vendor(username text, password text)
returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_super() then raise exception 'Only a super admin can do this.'; end if;
  perform public.create_vendor_login(username, password);
end $$;

create or replace function public.super_set_password(username text, password text)
returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_super() then raise exception 'Only a super admin can do this.'; end if;
  perform public.set_vendor_password(username, password);
end $$;

create or replace function public.super_set_role(username text, role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Only a super admin can do this.'; end if;
  if role not in ('admin', 'cashier') then raise exception 'Role must be admin or cashier.'; end if;
  update public.vendor_members m set role = super_set_role.role where m.username = lower(trim(super_set_role.username));
  if not found then raise exception 'Only staff logins have a role; "%" is a vendor''s main login.', lower(trim(username)); end if;
end $$;

create or replace function public.super_rename_login(old_username text, new_username text)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  uid  uuid;
  name text := lower(trim(new_username));
  mail text := lower(trim(new_username)) || '@brewzy-pos.example.com';
begin
  if not public.is_super() then raise exception 'Only a super admin can do this.'; end if;
  if name !~ '^[a-z0-9._-]+$' then raise exception 'User name can only use letters, numbers, dot, dash and underscore.'; end if;
  if exists (select 1 from auth.users where email = mail) then raise exception 'The user name "%" is already taken.', name; end if;
  select id into uid from auth.users where email = lower(trim(old_username)) || '@brewzy-pos.example.com';
  if uid is null then raise exception 'No login named "%".', lower(trim(old_username)); end if;
  update auth.users set email = mail, updated_at = now(),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('username', name)
   where id = uid;
  update auth.identities set identity_data = identity_data || jsonb_build_object('email', mail), updated_at = now()
   where user_id = uid and provider = 'email';
  update public.vendor_members set username = name where user_id = uid;
end $$;

revoke all on function public.is_super() from public, anon;
revoke all on function public.make_super_admin(text, text) from public, anon, authenticated;
revoke all on function public.whoami() from public, anon;
revoke all on function public.super_list_logins() from public, anon;
revoke all on function public.super_create_vendor(text, text) from public, anon;
revoke all on function public.super_set_password(text, text) from public, anon;
revoke all on function public.super_set_role(text, text) from public, anon;
revoke all on function public.super_rename_login(text, text) from public, anon;
grant execute on function public.is_super() to authenticated;
grant execute on function public.whoami() to authenticated;
grant execute on function public.super_list_logins() to authenticated;
grant execute on function public.super_create_vendor(text, text) to authenticated;
grant execute on function public.super_set_password(text, text) to authenticated;
grant execute on function public.super_set_role(text, text) to authenticated;
grant execute on function public.super_rename_login(text, text) to authenticated;
