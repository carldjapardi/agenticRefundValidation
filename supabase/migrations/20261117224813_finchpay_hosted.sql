-- FinchPay is isolated by prefix. Existing application tables and settings are untouched.
create table public.finchpay_sessions (
  id uuid primary key,
  workspace_hash text not null check (workspace_hash ~ '^[a-f0-9]{64}$'),
  state jsonb not null check (jsonb_typeof(state) = 'object' and state->>'id' = id::text),
  verified_at timestamptz,
  verification_failed boolean not null default false,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index finchpay_sessions_workspace_idx on public.finchpay_sessions (workspace_hash);

create table public.finchpay_refunds (
  id bigint generated always as identity primary key,
  workspace_hash text not null,
  charge_id text not null check (charge_id = 'CH-101'),
  session_id uuid not null references public.finchpay_sessions(id),
  amount numeric(10,2) not null default 25 check (amount = 25),
  created_at timestamptz not null default now(),
  unique (workspace_hash, charge_id)
);
create index finchpay_refunds_session_idx on public.finchpay_refunds (session_id);

alter table public.finchpay_sessions enable row level security;
alter table public.finchpay_refunds enable row level security;
revoke all on public.finchpay_sessions, public.finchpay_refunds from public, anon, authenticated;
grant select, insert, update, delete on public.finchpay_sessions, public.finchpay_refunds to service_role;
grant usage, select on sequence public.finchpay_refunds_id_seq to service_role;

create function public.finchpay_create_session(p_workspace text, p_state jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if p_state->>'currentRole' is distinct from 'Triage'
     or p_state->>'status' is distinct from 'ready'
     or p_state->>'verified' is distinct from 'false'
     or p_state->'requestedCharge' is distinct from 'null'::jsonb
     or p_state->'transcript' is distinct from '[]'::jsonb
     or p_state->'refundReference' is distinct from 'null'::jsonb then
    raise exception 'Invalid initial state' using errcode = '22023';
  end if;
  insert into public.finchpay_sessions(id, workspace_hash, state)
  values ((p_state->>'id')::uuid, p_workspace, p_state);
  return p_state;
end;
$$;

create function public.finchpay_claim_turn(p_workspace text, p_session uuid, p_lease uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.finchpay_sessions;
begin
  if p_lease is null then raise exception 'Lease required' using errcode = '22023'; end if;
  select * into s from public.finchpay_sessions
  where id = p_session and workspace_hash = p_workspace for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  if s.lease_token is not null and s.lease_expires_at > clock_timestamp() then
    raise exception 'Turn already claimed' using errcode = '55P03';
  end if;
  -- Failed-code policy survives a crash before the final conversation snapshot is saved.
  if s.verification_failed then s.state := jsonb_set(s.state, '{status}', '"ended"'); end if;
  update public.finchpay_sessions set state = s.state, lease_token = p_lease,
    lease_expires_at = clock_timestamp() + interval '90 seconds', updated_at = now()
  where id = p_session;
  return s.state;
end;
$$;

create function public.finchpay_verify_identity(
  p_workspace text, p_session uuid, p_lease uuid, p_code text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare s public.finchpay_sessions;
begin
  select * into s from public.finchpay_sessions
  where id = p_session and workspace_hash = p_workspace for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  if p_lease is null or s.lease_token is distinct from p_lease
     or s.lease_expires_at is null or s.lease_expires_at <= clock_timestamp() then
    raise exception 'Turn lease expired' using errcode = '55P03';
  end if;
  if s.verification_failed or s.state->>'status' is distinct from 'waiting'
     or s.state->>'currentRole' is distinct from 'Identity' or s.state->>'codeRequested' is distinct from 'true'
     or p_code is null or p_code !~ '^[0-9]{4}$' then
    raise exception 'Verification is not available' using errcode = '42501';
  end if;
  update public.finchpay_sessions set
    verified_at = case when p_code = '2468' then clock_timestamp() else null end,
    verification_failed = p_code <> '2468', updated_at = now()
  where id = p_session;
  return p_code = '2468';
end;
$$;

create function public.finchpay_issue_refund(
  p_workspace text, p_session uuid, p_lease uuid, p_charge text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.finchpay_sessions; r public.finchpay_refunds; was_created boolean;
begin
  select * into s from public.finchpay_sessions
  where id = p_session and workspace_hash = p_workspace for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  if p_lease is null or s.lease_token is distinct from p_lease
     or s.lease_expires_at is null or s.lease_expires_at <= clock_timestamp() then
    raise exception 'Turn lease expired' using errcode = '55P03';
  end if;
  -- These checks precede even looking up an existing reference.
  if s.verified_at is null or s.verification_failed
     or (s.state->>'currentRole' is distinct from 'Identity' and s.state->>'currentRole' is distinct from 'Refund')
     or p_charge is distinct from 'CH-101'
     or s.state->>'requestedCharge' is distinct from p_charge then
    raise exception 'Verified requested charge required' using errcode = '42501';
  end if;
  insert into public.finchpay_refunds(workspace_hash, charge_id, session_id)
    values (p_workspace, p_charge, p_session)
    on conflict (workspace_hash, charge_id) do nothing returning * into r;
  was_created := found;
  if not was_created then
    select * into strict r from public.finchpay_refunds
    where workspace_hash = p_workspace and charge_id = p_charge;
  end if;
  return jsonb_build_object('reference', 'RF-' || r.id::text, 'charge', r.charge_id,
    'amount', r.amount, 'created', was_created);
end;
$$;

create function public.finchpay_save_turn(
  p_workspace text, p_session uuid, p_lease uuid, p_state jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
declare s public.finchpay_sessions;
begin
  select * into s from public.finchpay_sessions
  where id = p_session and workspace_hash = p_workspace for update;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  if p_lease is null or s.lease_token is distinct from p_lease
     or s.lease_expires_at is null or s.lease_expires_at <= clock_timestamp() then
    raise exception 'Turn lease expired' using errcode = '55P03';
  end if;
  if p_state->>'id' is distinct from p_session::text
     or p_state->>'verified' is distinct from (case when s.verified_at is not null then 'true' else 'false' end)
     or (s.verification_failed and p_state->>'status' is distinct from 'ended') then
    raise exception 'Invalid session authority' using errcode = '42501';
  end if;
  update public.finchpay_sessions set state = p_state, lease_token = null,
    lease_expires_at = null, updated_at = now() where id = p_session;
end;
$$;

create function public.finchpay_release_turn(p_workspace text, p_session uuid, p_lease uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.finchpay_sessions set lease_token = null, lease_expires_at = null
  where id = p_session and workspace_hash = p_workspace and lease_token = p_lease;
$$;

create function public.finchpay_read_session(p_workspace text, p_session uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.finchpay_sessions; records jsonb;
begin
  select * into s from public.finchpay_sessions where id = p_session and workspace_hash = p_workspace;
  if not found then raise exception 'Session not found' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sessionId', r.session_id,
    'reference', 'RF-' || r.id::text, 'charge', r.charge_id, 'amount', r.amount)), '[]'::jsonb)
    into records from public.finchpay_refunds r
    where r.workspace_hash = p_workspace and r.session_id = p_session;
  if s.verification_failed then s.state := jsonb_set(s.state, '{status}', '"ended"'); end if;
  return jsonb_build_object('session', s.state, 'refunds', records);
end;
$$;

-- Default function EXECUTE grants are broad in Postgres: restrict each new RPC explicitly.
revoke all on function public.finchpay_create_session(text,jsonb) from public, anon, authenticated;
revoke all on function public.finchpay_claim_turn(text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.finchpay_verify_identity(text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.finchpay_issue_refund(text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.finchpay_save_turn(text,uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.finchpay_release_turn(text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.finchpay_read_session(text,uuid) from public, anon, authenticated;
grant execute on function public.finchpay_create_session(text,jsonb) to service_role;
grant execute on function public.finchpay_claim_turn(text,uuid,uuid) to service_role;
grant execute on function public.finchpay_verify_identity(text,uuid,uuid,text) to service_role;
grant execute on function public.finchpay_issue_refund(text,uuid,uuid,text) to service_role;
grant execute on function public.finchpay_save_turn(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.finchpay_release_turn(text,uuid,uuid) to service_role;
grant execute on function public.finchpay_read_session(text,uuid) to service_role;
