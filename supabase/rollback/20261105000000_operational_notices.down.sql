-- Revoca di 20261105000000_operational_notices.sql. Non cancella mai avvisi: se ce n'è anche uno solo si ferma senza
-- cambiare nulla (esportali o eliminali prima, consapevolmente).
do $$
begin
  if exists (select 1 from operational_notices) then
    raise exception 'REVOCA AVVISI interrotta, nulla è stato modificato: ci sono % avvisi operativi', (select count(*) from operational_notices);
  end if;
end $$;

drop function if exists public_operational_notices(text, text);
drop function if exists studio_delete_operational_notice(uuid);
drop function if exists studio_set_operational_notice_publication(uuid, text);
drop function if exists studio_verify_operational_notice(uuid, text);
drop function if exists studio_save_operational_notice(text, uuid, jsonb, boolean);
drop function if exists studio_operational_notices(text);
drop function if exists studio_operational_notice_json(operational_notices);
drop table if exists operational_notices;
drop function if exists operational_notice_today(text);
drop function if exists operational_notices_guard();
drop function if exists operational_notices_prepare();
drop function if exists operational_notice_clean_labels(text, jsonb);
drop type if exists operational_notice_status;
drop type if exists operational_notice_publication;
