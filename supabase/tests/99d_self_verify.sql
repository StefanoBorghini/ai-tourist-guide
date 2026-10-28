-- Test della verifica dell'autore (20261104000000_admin_self_verify.sql):
--   V1 l'amministratore salva un fatto già verificato (con fonte) e verifica un suo fatto in revisione;
--   V2 senza fonte non si verifica nemmeno l'amministratore; «salva come verificato» è solo suo;
--   V3 per gli altri resta la regola dei quattro occhi (anche per l'esperto);
--   V4 riportato in revisione perde la verifica dell'autore; il pack la porta come selfVerified;
--   V5 il vincolo: selfVerified solo se chi verifica è chi ha scritto.
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
  ('9d000000-0000-0000-0000-000000000001', 'admin-v@prova.test', '{}'),
  ('9d000000-0000-0000-0000-000000000002', 'esperto-v@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9d000000-0000-0000-0000-000000000001', (select organization_id from memberships where role = 'platform_admin' limit 1), 'platform_admin', null),
  ('9d000000-0000-0000-0000-000000000002', (select organization_id from packs where id = 'it.test.borgo-di-prova'), 'expert', 'it.test.borgo-di-prova');

set role authenticated;
set request.jwt.claim.sub = '9d000000-0000-0000-0000-000000000001';
do $$
declare
  src text := (select slug from sources where pack_id = 'it.test.borgo-di-prova' order by slug limit 1);
  a jsonb;
begin
  -- V1
  a := studio_create_assertion('it.test.borgo-di-prova', jsonb_build_object(
    'slug', 'v-admin-subito', 'subject', 'belvedere', 'type', 'fact', 'certainty', 'established',
    'texts', '{"it":"Il belvedere guarda a sud."}'::jsonb, 'evidence', jsonb_build_array(jsonb_build_object('source', src, 'locator', 'p. 1')),
    'verify', true));
  if a ->> 'status' <> 'verified' or not (a ->> 'selfVerified')::boolean or a ->> 'verifiedBy' <> '9d000000-0000-0000-0000-000000000001' then
    raise exception 'FALLITO: l''amministratore salva un fatto già verificato (%)', a;
  end if;
  perform studio_create_assertion('it.test.borgo-di-prova', jsonb_build_object(
    'slug', 'v-admin-dopo', 'subject', 'belvedere', 'type', 'fact', 'certainty', 'probable',
    'texts', '{"it":"Dal belvedere si vede il mare."}'::jsonb, 'evidence', jsonb_build_array(jsonb_build_object('source', src)), 'submit', true));
  a := studio_review_assertion('it.test.borgo-di-prova', 'v-admin-dopo', 'verify');
  if a ->> 'status' <> 'verified' or not (a ->> 'selfVerified')::boolean then
    raise exception 'FALLITO: l''amministratore verifica un suo fatto in revisione';
  end if;

  -- V2
  begin
    perform studio_create_assertion('it.test.borgo-di-prova', jsonb_build_object(
      'slug', 'v-senza-fonte', 'subject', 'belvedere', 'type', 'legend', 'texts', '{"it":"Si racconta di un tesoro."}'::jsonb, 'verify', true));
    raise exception 'FALLITO: verifica senza fonte';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  if exists (select 1 from assertions where pack_id = 'it.test.borgo-di-prova' and slug = 'v-senza-fonte') then
    raise exception 'FALLITO: il fatto senza fonte non doveva restare';
  end if;

  -- V4
  a := studio_review_assertion('it.test.borgo-di-prova', 'v-admin-dopo', 'reopen', 'da ricontrollare');
  if a ->> 'status' <> 'in_review' or (a ->> 'selfVerified')::boolean then
    raise exception 'FALLITO: riportato in revisione perde la verifica dell''autore';
  end if;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '9d000000-0000-0000-0000-000000000002';
do $$
declare src text := (select slug from sources where pack_id = 'it.test.borgo-di-prova' order by slug limit 1);
begin
  -- V3
  perform studio_create_assertion('it.test.borgo-di-prova', jsonb_build_object(
    'slug', 'v-esperto', 'subject', 'belvedere', 'type', 'fact', 'certainty', 'established',
    'texts', '{"it":"Il belvedere ha una panchina."}'::jsonb, 'evidence', jsonb_build_array(jsonb_build_object('source', src)), 'submit', true));
  begin
    perform studio_review_assertion('it.test.borgo-di-prova', 'v-esperto', 'verify');
    raise exception 'FALLITO: l''esperto verifica un suo fatto';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_create_assertion('it.test.borgo-di-prova', jsonb_build_object(
      'slug', 'v-esperto-subito', 'subject', 'belvedere', 'type', 'fact', 'certainty', 'established',
      'texts', '{"it":"Il belvedere ha due panchine."}'::jsonb, 'evidence', jsonb_build_array(jsonb_build_object('source', src)), 'verify', true));
    raise exception 'FALLITO: «salva come verificato» è solo dell''amministratore';
  exception when insufficient_privilege then null; end;
  -- Ma verifica il fatto dell'amministratore (quattro occhi normali).
  if (studio_review_assertion('it.test.borgo-di-prova', 'v-admin-dopo', 'verify') ->> 'selfVerified')::boolean then
    raise exception 'FALLITO: verifica di un''altra persona segnata come dell''autore';
  end if;
end $$;
reset role;

-- V4 (pack) e V5
do $$
declare s jsonb := pack_snapshot('it.test.borgo-di-prova');
begin
  if not exists (select 1 from jsonb_array_elements(s -> 'assertions') x where x ->> 'id' = 'v-admin-subito' and (x ->> 'selfVerified')::boolean) then
    raise exception 'FALLITO: il pack porta selfVerified';
  end if;
  if exists (select 1 from jsonb_array_elements(s -> 'assertions') x where x ->> 'id' = 'v-admin-dopo' and x ? 'selfVerified') then
    raise exception 'FALLITO: selfVerified solo per la verifica dell''autore';
  end if;
  begin
    update assertions set verified_by = 'qualcun-altro' where pack_id = 'it.test.borgo-di-prova' and slug = 'v-admin-subito';
    raise exception 'FALLITO: selfVerified con un verificatore diverso dall''autore';
  exception when check_violation then null; end;
  begin
    update assertions set self_verified = false where pack_id = 'it.test.borgo-di-prova' and slug = 'v-admin-subito';
    raise exception 'FALLITO: autore e verificatore uguali senza selfVerified';
  exception when check_violation then null; end;
end $$;

\echo '99d_self_verify: ok'
