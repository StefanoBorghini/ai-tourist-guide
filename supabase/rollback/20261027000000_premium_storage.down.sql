-- Revoca di 20261027000000_premium_storage.sql: tolte policy e funzioni del bucket «premium», poi il bucket.
-- Non cancella mai contenuti: se nel bucket ci sono file si ferma prima di cambiare qualcosa (vanno prima tolti
-- dalla pipeline o a mano, con una decisione esplicita). Senza le policy nessuno legge più i file a pagamento.
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'premium') then
    raise exception 'REVOCA PREMIUM interrotta, nulla è stato modificato: il bucket «premium» contiene file';
  end if;
end $$;
drop policy if exists premium_files_entitled_read on storage.objects;
drop policy if exists premium_files_publisher_read on storage.objects;
drop policy if exists premium_files_publisher_insert on storage.objects;
drop policy if exists premium_files_publisher_delete on storage.objects;
drop function if exists premium_object_readable(text);
drop function if exists premium_object_name_ok(text);
delete from storage.buckets where id = 'premium';
