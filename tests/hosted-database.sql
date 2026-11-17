-- Run against the migrated Supabase database as an administrator.
-- Rows are rolled back. Identity sequences may advance, so references need not be consecutive.
begin;
set local role service_role;
do $$
declare
  workspace text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  other_workspace text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  first_id uuid := gen_random_uuid(); second_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid(); failed_id uuid := gen_random_uuid();
  lease uuid := gen_random_uuid(); replacement uuid := gen_random_uuid();
  base jsonb; state jsonb; result jsonb; first_reference text;
begin
  if has_table_privilege('anon', 'public.finchpay_sessions', 'select')
     or has_table_privilege('authenticated', 'public.finchpay_refunds', 'insert')
     or has_function_privilege('anon', 'public.finchpay_issue_refund(text,uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.finchpay_verify_identity(text,uuid,uuid,text)', 'execute') then
    raise exception 'Public database permissions are too broad';
  end if;
  base := jsonb_build_object('id', first_id, 'createdAt', now(), 'triageMode', 'deterministic',
    'currentRole', 'Triage', 'requestedCharge', null, 'verified', false, 'status', 'ready',
    'codeRequested', false, 'refundReference', null, 'refundOutcome', null,
    'transcript', '[]'::jsonb, 'trace', '[]'::jsonb);
  perform public.finchpay_create_session(workspace, base);
  begin
    perform public.finchpay_read_session(other_workspace, first_id);
    raise exception 'Another visitor read this session';
  exception when sqlstate 'P0002' then null; end;
  state := public.finchpay_claim_turn(workspace, first_id, lease);
  begin
    perform public.finchpay_claim_turn(workspace, first_id, gen_random_uuid());
    raise exception 'Overlapping turn was accepted';
  exception when sqlstate '55P03' then null; end;
  begin
    perform public.finchpay_verify_identity(workspace, first_id, lease, '2468');
    raise exception 'Triage skipped the Identity prompt';
  exception when sqlstate '42501' then null; end;
  begin
    perform public.finchpay_issue_refund(workspace, first_id, lease, 'CH-101');
    raise exception 'Unverified refund was accepted';
  exception when sqlstate '42501' then null; end;
  begin
    perform public.finchpay_save_turn(workspace, first_id, lease, jsonb_set(state, '{verified}', 'true'));
    raise exception 'A forged verified flag was accepted';
  exception when sqlstate '42501' then null; end;
  state := state || '{"currentRole":"Identity","requestedCharge":"CH-101","status":"waiting","codeRequested":true}'::jsonb;
  perform public.finchpay_save_turn(workspace, first_id, lease, state);
  begin
    perform public.finchpay_verify_identity(workspace, first_id, null, '2468');
    raise exception 'Null lease was accepted';
  exception when sqlstate '55P03' then null; end;
  perform public.finchpay_claim_turn(workspace, first_id, lease);
  update public.finchpay_sessions set lease_expires_at = now() - interval '1 second' where id = first_id;
  begin
    perform public.finchpay_verify_identity(workspace, first_id, lease, '2468');
    raise exception 'Expired request still verified';
  exception when sqlstate '55P03' then null; end;
  perform public.finchpay_claim_turn(workspace, first_id, replacement);
  perform public.finchpay_release_turn(workspace, first_id, lease);
  if (select lease_token from public.finchpay_sessions where id = first_id) is distinct from replacement then
    raise exception 'Stale request released a newer lease';
  end if;
  begin
    perform public.finchpay_save_turn(workspace, first_id, lease, state);
    raise exception 'Stale request saved over a newer turn';
  exception when sqlstate '55P03' then null; end;
  if not public.finchpay_verify_identity(workspace, first_id, replacement, '2468') then
    raise exception 'Correct verification failed';
  end if;
  begin
    perform public.finchpay_issue_refund(workspace, first_id, replacement, 'CH-999');
    raise exception 'Unsupported charge was refunded';
  exception when sqlstate '42501' then null; end;
  result := public.finchpay_issue_refund(workspace, first_id, replacement, 'CH-101');
  if result->>'created' <> 'true' or result->>'amount' <> '25.00' then
    raise exception 'First refund did not create the expected record: %', result;
  end if;
  first_reference := result->>'reference';
  result := public.finchpay_issue_refund(workspace, first_id, replacement, 'CH-101');
  if result->>'created' <> 'false' or result->>'reference' <> first_reference or result ? 'sessionId' then
    raise exception 'Duplicate refund or session handle disclosure';
  end if;
  perform public.finchpay_save_turn(workspace, first_id, replacement,
    state || jsonb_build_object('verified', true, 'status', 'ended', 'refundReference', first_reference, 'refundOutcome', 'issued'));

  -- Fresh chat shares eligibility but must verify again before it can retrieve the old reference.
  perform public.finchpay_create_session(workspace, jsonb_set(base, '{id}', to_jsonb(second_id::text)));
  perform public.finchpay_claim_turn(workspace, second_id, lease);
  state := jsonb_set(state, '{id}', to_jsonb(second_id::text));
  perform public.finchpay_save_turn(workspace, second_id, lease, state);
  perform public.finchpay_claim_turn(workspace, second_id, lease);
  begin
    perform public.finchpay_issue_refund(workspace, second_id, lease, 'CH-101');
    raise exception 'New chat retrieved a reference before verification';
  exception when sqlstate '42501' then null; end;
  perform public.finchpay_verify_identity(workspace, second_id, lease, '2468');
  result := public.finchpay_issue_refund(workspace, second_id, lease, 'CH-101');
  if result->>'created' <> 'false' or result->>'reference' <> first_reference then
    raise exception 'New chat reset payment history';
  end if;
  if (select count(*) from public.finchpay_refunds where workspace_hash = workspace) <> 1 then
    raise exception 'Charge uniqueness failed';
  end if;

  -- Different visitor gets an independent mock charge.
  perform public.finchpay_create_session(other_workspace, jsonb_set(base, '{id}', to_jsonb(other_id::text)));
  perform public.finchpay_claim_turn(other_workspace, other_id, lease);
  state := jsonb_set(state, '{id}', to_jsonb(other_id::text));
  perform public.finchpay_save_turn(other_workspace, other_id, lease, state);
  perform public.finchpay_claim_turn(other_workspace, other_id, lease);
  perform public.finchpay_verify_identity(other_workspace, other_id, lease, '2468');
  result := public.finchpay_issue_refund(other_workspace, other_id, lease, 'CH-101');
  if result->>'created' <> 'true' or result->>'reference' = first_reference then
    raise exception 'Different visitors shared eligibility';
  end if;

  -- Failed code is terminal even if the handler dies before saving its final snapshot.
  perform public.finchpay_create_session(workspace, jsonb_set(base, '{id}', to_jsonb(failed_id::text)));
  perform public.finchpay_claim_turn(workspace, failed_id, lease);
  state := jsonb_set(state, '{id}', to_jsonb(failed_id::text));
  perform public.finchpay_save_turn(workspace, failed_id, lease, state);
  perform public.finchpay_claim_turn(workspace, failed_id, lease);
  if public.finchpay_verify_identity(workspace, failed_id, lease, '0000') then
    raise exception 'Wrong code succeeded';
  end if;
  begin
    perform public.finchpay_verify_identity(workspace, failed_id, lease, '2468');
    raise exception 'Failed code attempt was reset';
  exception when sqlstate '42501' then null; end;
  perform public.finchpay_release_turn(workspace, failed_id, lease);
  result := public.finchpay_claim_turn(workspace, failed_id, replacement);
  if result->>'status' <> 'ended' then raise exception 'Crash reset the failed-code policy'; end if;
end;
$$;
rollback;
select 'PASS: service-only access, session ownership, verification authority, null/expired/stale leases, duplicate prevention, visitor isolation, and failed-code crash recovery' as result;
