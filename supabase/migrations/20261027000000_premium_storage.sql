-- Contenuti a pagamento: bucket privato «premium» e lettura solo per chi ha il diritto (PIANO-COMMERCIALE.md §6,
-- CONSEGNA-CONTENUTI.md). Nessuna tabella nuova: il diritto si ricava dal nome del file e dai diritti esistenti.
--
-- Nome dei file: <destinazione>/<lingua>/<pubblicazione>/explore.<impronta>.json
--                <destinazione>/<lingua>/<pubblicazione>/route-<percorso>.<impronta>.json
-- - explore: si legge solo con il diritto «explore» attivo su quella destinazione;
-- - route-<percorso>: solo con il diritto «route» attivo su QUEL percorso (un pacchetto è già un diritto per percorso).
-- Non basta che il contenuto sia diventato gratuito: in quel caso è già nel bundle pubblico, e il file a pagamento
-- rimasto (di una pubblicazione precedente) resta riservato a chi l'aveva comprato.
-- Il bucket non è pubblico: nessun indirizzo diretto funziona senza autorizzazione; l'app chiede un indirizzo
-- firmato di pochi minuti con la sessione dell'utente, che passa da queste policy. Nessuna chiave di servizio.
-- Scrive solo la pipeline di pubblicazione, nella cartella della propria pubblicazione in corso; nessuna
-- sovrascrittura (nessuna policy di UPDATE); la pulizia cancella solo le pubblicazioni superate.

insert into storage.buckets (id, name, public) values ('premium', 'premium', false)
on conflict (id) do update set public = false;

create or replace function premium_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select coalesce(p_name ~ ('^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}/'
                            '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                            '(explore|route-[a-z0-9]+(-[a-z0-9]+)*)\.[0-9a-f]{16,64}\.json$'), false);
$$;

-- Il visitatore può leggere questo file? Solo con un diritto attivo e valido ora (has_active_right usa auth.uid()).
create or replace function premium_object_readable(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_pack text;
  v_file text;
  v_route uuid;
begin
  if auth.uid() is null or not premium_object_name_ok(p_name) then return false; end if;
  v_pack := split_part(p_name, '/', 1);
  v_file := split_part(p_name, '/', 4);
  if v_file like 'explore.%' then
    return has_active_right('explore', v_pack, null);
  end if;
  select r.id into v_route from routes r
  where r.pack_id = v_pack and r.slug = substring(v_file from '^route-([a-z0-9-]+)\.[0-9a-f]+\.json$');
  return v_route is not null and has_active_right('route', v_pack, v_route);
end;
$$;

revoke execute on function premium_object_name_ok(text), premium_object_readable(text) from public, anon;
grant execute on function premium_object_name_ok(text), premium_object_readable(text) to authenticated, service_role;

-- ---------------------------------------------------------------- lettura
drop policy if exists premium_files_entitled_read on storage.objects;
create policy premium_files_entitled_read on storage.objects for select to authenticated
  using (bucket_id = 'premium' and public.premium_object_readable(name));

-- Chi pubblica il territorio vede i file (serve alla pulizia e alle verifiche della pipeline).
drop policy if exists premium_files_publisher_read on storage.objects;
create policy premium_files_publisher_read on storage.objects for select to authenticated
  using (bucket_id = 'premium' and public.premium_object_name_ok(name) and public.can_publish_pack((storage.foldername(name))[1]));

-- ---------------------------------------------------------------- scrittura: solo la propria pubblicazione in corso
drop policy if exists premium_files_publisher_insert on storage.objects;
create policy premium_files_publisher_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'premium' and public.premium_object_name_ok(name)
              and public.can_publish_pack((storage.foldername(name))[1])
              and public.studio_publication_writable((storage.foldername(name))[1], (storage.foldername(name))[3]));

-- Cancellazione: solo i file delle pubblicazioni superate del proprio territorio (stessa regola dei bundle).
drop policy if exists premium_files_publisher_delete on storage.objects;
create policy premium_files_publisher_delete on storage.objects for delete to authenticated
  using (bucket_id = 'premium' and public.premium_object_name_ok(name)
         and public.can_publish_pack((storage.foldername(name))[1])
         and public.studio_publication_dead((storage.foldername(name))[1], (storage.foldername(name))[3]));
