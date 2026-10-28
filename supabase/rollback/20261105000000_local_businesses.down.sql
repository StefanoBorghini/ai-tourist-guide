-- Revoca di 20261105000000_local_businesses.sql: toglie la directory delle attività locali.
--
-- Non cancella mai dati per errore: se esiste anche una sola attività si ferma PRIMA di cambiare qualcosa. Le attività
-- vanno esportate (lo storico è anche in content_revisions) ed eliminate a mano prima di tornare indietro. Tutto in
-- una transazione; il blocco della tabella impedisce inserimenti tra il controllo e la revoca.
begin;
set local lock_timeout = '10s';
lock table local_businesses in access exclusive mode;

do $$
declare v bigint;
begin
  select count(*) into v from local_businesses;
  if v > 0 then
    raise exception 'REVOCA ATTIVITÀ interrotta, nulla è stato modificato: % attività. Esportale ed eliminale prima di revocare.', v;
  end if;
end $$;

drop function if exists public_local_businesses(text, text);
drop function if exists studio_delete_local_business(uuid);
drop function if exists studio_set_local_business_publication(uuid, text);
drop function if exists studio_verify_local_business(uuid, text);
drop function if exists studio_save_local_business(text, uuid, jsonb, boolean);
drop function if exists studio_local_businesses(text);
drop function if exists studio_local_business_json(local_businesses);
drop table if exists local_businesses;
drop function if exists local_businesses_guard();
drop function if exists local_businesses_prepare();
drop function if exists local_business_clean_labels(text, jsonb);
drop type if exists local_business_category;
drop type if exists local_business_publication;

commit;
