-- Revoca di 20261031000000_local_events.sql: toglie il calendario degli eventi e il fuso orario delle destinazioni.
--
-- Non cancella mai dati per errore: se esiste anche un solo evento, o una destinazione con un fuso orario diverso da
-- quello predefinito, si ferma PRIMA di cambiare qualcosa. Gli eventi vanno esportati (lo storico è anche in
-- content_revisions) ed eliminati a mano prima di tornare indietro. Tutto in una transazione: o si applica per intero
-- o non cambia nulla. Il blocco delle tabelle impedisce che qualcuno inserisca un evento tra il controllo e la revoca.
begin;
set local lock_timeout = '10s';
lock table destinations, local_events in access exclusive mode;

do $$
declare v_events bigint; v_zones bigint;
begin
  select count(*) into v_events from local_events;
  select count(*) into v_zones from destinations where timezone <> 'Europe/Rome';
  if v_events > 0 or v_zones > 0 then
    raise exception 'REVOCA EVENTI interrotta, nulla è stato modificato: % eventi e % destinazioni con un fuso orario diverso da Europe/Rome. Esporta ed elimina gli eventi (e riporta i fusi a Europe/Rome) prima di revocare.', v_events, v_zones;
  end if;
end $$;

drop function if exists public_local_events(text, date, date, text);
drop function if exists studio_delete_local_event(uuid);
drop function if exists studio_set_local_event_status(uuid, text, text);
drop function if exists studio_set_local_event_publication(uuid, text);
drop function if exists studio_verify_local_event(uuid, text);
drop function if exists studio_save_local_event(text, uuid, jsonb, boolean);
drop function if exists local_event_url(jsonb, text, text);
drop function if exists local_event_text(jsonb, text);
drop function if exists studio_local_events(text);
drop function if exists studio_local_event_json(local_events);

drop trigger if exists destinations_timezone_recompute_trg on destinations;
drop function if exists destinations_timezone_recompute();
drop table if exists local_events;
drop function if exists local_events_guard();
drop function if exists local_events_prepare();
drop function if exists local_event_clean_labels(text, jsonb);
drop function if exists local_event_instant(date, time, text);
drop function if exists is_public_https_url(text);
drop type if exists local_event_price;
drop type if exists local_event_category;
drop type if exists local_event_status;
drop type if exists local_event_publication;

drop trigger if exists destinations_timezone_guard_trg on destinations;
drop function if exists destinations_timezone_guard();
alter table destinations drop column if exists timezone;

commit;
