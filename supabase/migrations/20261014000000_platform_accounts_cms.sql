-- =====================================================================
-- Piattaforma: CMS per territorio, account dei visitatori, pubblicazione,
-- storico delle versioni, file su storage e predisposizione dei contenuti premium.
-- =====================================================================
--
-- Estende lo schema v0.2 senza sostituirlo:
--   • ruoli: amministratore della piattaforma; scrittura diretta per gli editor del proprio territorio;
--     verifica delle affermazioni solo a esperti e redazione (mai dall'autore: regola dei quattro occhi);
--   • stato editoriale: bozza → in revisione → verificato/pubblicato, con storico di ogni modifica;
--   • pubblicazione: l'app continua a leggere solo i bundle (CDN), compilati dai contenuti pubblicati;
--   • media: immagini, video e audio su Storage; nel database solo metadati e riferimenti;
--   • visitatori: profilo, preferenze, preferiti, avanzamento dei percorsi, consensi, cancellazione;
--   • premium (senza pagamenti): livello di accesso dei contenuti, prodotti senza prezzo, diritti
--     di accesso (entitlement) e acquisti da riconciliare con un fornitore futuro; tutto verificato lato server.
--
-- Revoca: vedi supabase/rollback/20261014000000_platform_accounts_cms.down.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RUOLI
-- ---------------------------------------------------------------------

-- Il valore 'platform_admin' di member_role è aggiunto dalla migrazione precedente.

-- Amministratore della piattaforma: ogni permesso, su ogni territorio.
create or replace function is_platform_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.user_id = auth.uid() and m.role = 'platform_admin');
$$;

-- Chi può modificare i contenuti di un territorio (bozze, luoghi, percorsi, media).
create or replace function can_edit_pack(p_pack text)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_platform_admin()
      or has_role(array['platform_editor', 'territory_editor']::member_role[], p_pack);
$$;

-- Chi può verificare un'affermazione (mai l'autore: lo impone il vincolo dei quattro occhi).
create or replace function can_verify_pack(p_pack text)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_platform_admin()
      or has_role(array['platform_editor', 'expert']::member_role[], p_pack);
$$;

-- Chi può pubblicare un territorio (e quindi farlo arrivare all'app).
create or replace function can_publish_pack(p_pack text)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_platform_admin()
      or has_role(array['platform_editor', 'territory_editor']::member_role[], p_pack);
$$;

-- Chi lavora sui contenuti di un territorio (anche solo in lettura).
create or replace function is_pack_staff(p_pack text)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_platform_admin()
      or has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], p_pack);
$$;

-- Solo l'amministratore assegna i ruoli; ciascuno vede i propri (policy già esistente).
create policy memberships_admin_all on memberships for all
  using (is_platform_admin()) with check (is_platform_admin());

-- ---------------------------------------------------------------------
-- 2. TERRITORI: metadati per il CMS
-- ---------------------------------------------------------------------

alter table packs
  add column locales     text[] not null default '{}',
  add column title       jsonb not null default '{}',   -- { "it": "...", "en": "..." }
  add column description jsonb not null default '{}';

alter table destinations
  add column slug            text unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  add column cover_media_id  uuid,
  add column published_at    timestamptz,
  add column published_by    uuid references auth.users (id),
  add column updated_at      timestamptz not null default now();

-- ---------------------------------------------------------------------
-- 3. SCRITTURA PER TERRITORIO (le policy di sola lettura dello staff restano)
-- ---------------------------------------------------------------------
-- Prima scriveva solo la redazione centrale; ora anche l'editor del territorio, nel proprio ambito.
-- Le regole sugli stati (chi verifica, chi pubblica) sono nei trigger della sezione 4.

drop policy if exists nodes_platform_write on nodes;
drop policy if exists assertions_platform_write on assertions;

create policy packs_admin_write on packs for all
  using (is_platform_admin()) with check (is_platform_admin());
create policy packs_editor_update on packs for update
  using (can_edit_pack(id)) with check (can_edit_pack(id));

create policy nodes_editor_write on nodes for all
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy node_labels_staff_read on node_labels for select
  using (exists (select 1 from nodes n where n.id = node_id and is_pack_staff(n.pack_id)));
create policy node_labels_editor_write on node_labels for all
  using (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)));

create policy places_staff_read on places for select
  using (exists (select 1 from nodes n where n.id = node_id and is_pack_staff(n.pack_id)));
create policy places_editor_write on places for all
  using (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)));
create policy geofences_staff_read on geofences for select
  using (exists (select 1 from nodes n where n.id = place_node_id and is_pack_staff(n.pack_id)));
create policy geofences_editor_write on geofences for all
  using (exists (select 1 from nodes n where n.id = place_node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = place_node_id and can_edit_pack(n.pack_id)));
create policy territories_staff_read on territories for select
  using (exists (select 1 from nodes n where n.id = node_id and is_pack_staff(n.pack_id)));
create policy territories_editor_write on territories for all
  using (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)));

create policy sources_staff_read on sources for select using (is_pack_staff(pack_id));
create policy sources_editor_write on sources for all
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
-- Le affermazioni le scrivono anche gli esperti (che le verificano), oltre agli editor.
create policy assertions_editor_write on assertions for all
  using (can_edit_pack(pack_id) or can_verify_pack(pack_id))
  with check (can_edit_pack(pack_id) or can_verify_pack(pack_id));
create policy assertion_texts_staff_read on assertion_texts for select
  using (exists (select 1 from assertions a where a.id = assertion_id and is_pack_staff(a.pack_id)));
create policy assertion_texts_editor_write on assertion_texts for all
  using (exists (select 1 from assertions a where a.id = assertion_id and (can_edit_pack(a.pack_id) or can_verify_pack(a.pack_id))))
  with check (exists (select 1 from assertions a where a.id = assertion_id and (can_edit_pack(a.pack_id) or can_verify_pack(a.pack_id))));
create policy evidence_staff_read on evidence for select
  using (exists (select 1 from assertions a where a.id = assertion_id and is_pack_staff(a.pack_id)));
create policy evidence_editor_write on evidence for all
  using (exists (select 1 from assertions a where a.id = assertion_id and (can_edit_pack(a.pack_id) or can_verify_pack(a.pack_id))))
  with check (exists (select 1 from assertions a where a.id = assertion_id and (can_edit_pack(a.pack_id) or can_verify_pack(a.pack_id))));
create policy disputes_staff_read on disputes for select using (is_pack_staff(pack_id));
create policy disputes_editor_write on disputes for all
  using (can_edit_pack(pack_id) or can_verify_pack(pack_id)) with check (can_edit_pack(pack_id) or can_verify_pack(pack_id));

create policy units_editor_write on narrative_units for all
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy unit_assertions_staff_read on unit_assertions for select
  using (exists (select 1 from narrative_units u where u.id = unit_id and is_pack_staff(u.pack_id)));
create policy unit_assertions_editor_write on unit_assertions for all
  using (exists (select 1 from narrative_units u where u.id = unit_id and can_edit_pack(u.pack_id)))
  with check (exists (select 1 from narrative_units u where u.id = unit_id and can_edit_pack(u.pack_id)));

create policy routes_staff_read on routes for select using (is_pack_staff(pack_id));
create policy routes_editor_write on routes for all
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy route_stops_staff_read on route_stops for select
  using (exists (select 1 from routes r where r.id = route_id and is_pack_staff(r.pack_id)));
create policy route_stops_editor_write on route_stops for all
  using (exists (select 1 from routes r where r.id = route_id and can_edit_pack(r.pack_id)))
  with check (exists (select 1 from routes r where r.id = route_id and can_edit_pack(r.pack_id)));

create policy bundles_staff_read on bundles for select using (is_pack_staff(pack_id));

alter table destinations enable row level security;
create policy destinations_staff_read on destinations for select using (is_pack_staff(pack_id));
create policy destinations_editor_write on destinations for all
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));

-- ---------------------------------------------------------------------
-- 4. STATI EDITORIALI: le regole valgono anche se il CMS sbaglia
-- ---------------------------------------------------------------------
-- I controlli si applicano agli utenti autenticati (CMS). Le importazioni dai Territory Pack
-- girano con il ruolo di servizio e conservano autori e verificatori del pack.
-- Le funzioni girano con i privilegi di chi chiama (non security definer): così current_user è il
-- ruolo reale della richiesta ('authenticated' per il CMS).

create or replace function editorial_assertion_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.authored_by := auth.uid()::text;
    if new.status not in ('draft', 'in_review') then
      raise exception 'una nuova affermazione nasce in bozza o in revisione';
    end if;
    return new;
  end if;
  -- Chi non verifica non può cambiare un'affermazione già verificata senza riportarla in revisione.
  if new.status is distinct from old.status and new.status in ('verified', 'rejected', 'blocked', 'deprecated') then
    if not can_verify_pack(new.pack_id) then
      raise exception 'solo un esperto o la redazione possono portare un''affermazione a %', new.status;
    end if;
    if new.status = 'verified' then
      new.verified_by := auth.uid()::text;   -- il vincolo dei quattro occhi impedisce che sia l'autore
      new.verified_at := now();
    end if;
  end if;
  -- Un'affermazione verificata modificata nel contenuto torna in revisione.
  if old.status = 'verified' and new.status = 'verified'
     and (new.type, new.certainty, new.year_from, new.year_to, new.amount, new.subject_id, new.object_id)
         is distinct from (old.type, old.certainty, old.year_from, old.year_to, old.amount, old.subject_id, old.object_id) then
    new.status := 'in_review';
    new.verified_by := null;
    new.verified_at := null;
  end if;
  new.authored_by := old.authored_by;
  new.updated_at := now();
  return new;
end;
$$;
create trigger editorial_assertion_guard_trg
before insert or update on assertions
for each row execute function editorial_assertion_guard();

-- Un testo modificato di un'affermazione verificata la riporta in revisione.
create or replace function editorial_assertion_text_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' and (tg_op = 'INSERT' or new.statement is distinct from old.statement) then
    update assertions set status = 'in_review', verified_by = null, verified_at = null, updated_at = now()
    where id = new.assertion_id and status = 'verified' and not can_verify_pack(pack_id);
    new.reviewed := false;
  end if;
  return new;
end;
$$;
create trigger editorial_assertion_text_guard_trg
before insert or update on assertion_texts
for each row execute function editorial_assertion_text_guard();

-- Un'unità narrativa si pubblica solo se ogni affermazione che usa è verificata.
create or replace function editorial_unit_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published' or new.text is distinct from old.text) then
    if not can_publish_pack(new.pack_id) then
      raise exception 'non hai i permessi per pubblicare in %', new.pack_id;
    end if;
    if tg_op = 'UPDATE' and exists (
      select 1 from unit_assertions ua join assertions a on a.id = ua.assertion_id
      where ua.unit_id = new.id and a.status <> 'verified'
    ) then
      raise exception 'l''unità usa affermazioni non verificate: non si può pubblicare';
    end if;
    if tg_op = 'INSERT' then
      raise exception 'un''unità nasce in bozza: si pubblica dopo aver collegato le affermazioni verificate';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger editorial_unit_guard_trg
before insert or update on narrative_units
for each row execute function editorial_unit_guard();

-- Pubblicare (o ritirare) un territorio, un percorso o un nodo richiede il permesso di pubblicazione.
create or replace function editorial_publish_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.status = 'published')
     or (tg_op = 'UPDATE' and new.status is distinct from old.status and 'published' in (new.status::text, old.status::text)) then
    if not can_publish_pack(new.pack_id) then
      raise exception 'non hai i permessi per pubblicare in %', new.pack_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger editorial_publish_guard_routes before insert or update on routes
  for each row execute function editorial_publish_guard();
create trigger editorial_publish_guard_nodes before insert or update on nodes
  for each row execute function editorial_publish_guard();
create trigger editorial_publish_guard_destinations before insert or update on destinations
  for each row execute function editorial_publish_guard();

-- ---------------------------------------------------------------------
-- 5. STORICO DELLE VERSIONI
-- ---------------------------------------------------------------------
-- Ogni inserimento, modifica o eliminazione dei contenuti lascia una riga: chi, quando, prima e dopo.
-- Serve a ripristinare una versione precedente e a sapere chi ha cambiato cosa.

create table content_revisions (
  id          bigint generated always as identity primary key,
  pack_id     text not null,
  table_name  text not null,
  row_id      text not null,
  operation   text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id    uuid,                        -- null = importazione o servizio
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index content_revisions_row_idx on content_revisions (table_name, row_id, created_at desc);
create index content_revisions_pack_idx on content_revisions (pack_id, created_at desc);
alter table content_revisions enable row level security;
create policy content_revisions_staff_read on content_revisions for select using (is_pack_staff(pack_id));
-- Nessuna policy di scrittura: le righe le crea solo il trigger.

create or replace function record_revision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  pack text := coalesce(rec ->> 'pack_id', (
    select n.pack_id from nodes n where n.id = coalesce((rec ->> 'node_id')::uuid, (rec ->> 'place_node_id')::uuid)
  ));
  key text := coalesce(rec ->> 'id', rec ->> 'node_id', rec ->> 'slug');
begin
  if pack is null then
    return coalesce(new, old);
  end if;
  insert into content_revisions (pack_id, table_name, row_id, operation, actor_id, before, after)
  values (pack, tg_table_name, key, tg_op, auth.uid(),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['nodes', 'places', 'sources', 'assertions', 'narrative_units', 'routes', 'media_assets', 'destinations'] loop
    execute format('create trigger %I after insert or update or delete on %I for each row execute function record_revision()', t || '_revision_trg', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. PUBBLICAZIONE
-- ---------------------------------------------------------------------
-- Una pubblicazione = i contenuti pubblicati di un territorio compilati in bundle (uno per lingua) e
-- copiati sulla CDN. L'app legge l'indice dei bundle: nessun nuovo deploy del frontend.

create type publication_status as enum ('requested', 'building', 'published', 'failed', 'rolled_back');

create table publications (
  id           uuid primary key default gen_random_uuid(),
  pack_id      text not null references destinations (pack_id),
  status       publication_status not null default 'requested',
  requested_by uuid not null references auth.users (id),
  note         text,
  report       jsonb,                      -- esito del validatore e della compilazione
  bundle_ids   uuid[] not null default '{}',
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
alter table publications enable row level security;
create policy publications_staff_read on publications for select using (is_pack_staff(pack_id));
-- Si chiede una pubblicazione; la compilazione e l'esito li scrive solo il servizio di pubblicazione.
create policy publications_request on publications for insert
  with check (requested_by = auth.uid() and status = 'requested' and can_publish_pack(pack_id));

-- ---------------------------------------------------------------------
-- 7. MEDIA: audio, metadati dei file e Storage
-- ---------------------------------------------------------------------

alter table media_assets drop constraint if exists media_assets_kind_check;
alter table media_assets add constraint media_assets_kind_check check (kind in ('image', 'video', 'audio'));
alter table media_assets
  add column mime_type   text,
  add column bytes       bigint check (bytes > 0),
  add column width       integer check (width > 0),
  add column height      integer check (height > 0),
  add column duration_s  real check (duration_s > 0),
  add column status      text not null default 'ready' check (status in ('uploading', 'processing', 'ready', 'rejected')),
  add column uploaded_by uuid references auth.users (id),
  add column updated_at  timestamptz not null default now(),
  -- Formati e dimensioni ammessi (gli stessi limiti valgono nel bucket di Storage).
  add constraint media_assets_mime_check check (mime_type is null or (
       (kind = 'image' and mime_type in ('image/jpeg', 'image/png', 'image/webp'))
    or (kind = 'video' and mime_type in ('video/mp4', 'video/webm'))
    or (kind = 'audio' and mime_type in ('audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav')))),
  add constraint media_assets_size_check check (bytes is null or (
       (kind = 'image' and bytes <= 15 * 1024 * 1024)
    or (kind = 'video' and bytes <= 200 * 1024 * 1024)
    or (kind = 'audio' and bytes <= 50 * 1024 * 1024))),
  add constraint media_assets_path_check check (storage_path like pack_id || '/%');

alter table destinations
  add constraint destinations_cover_fk foreign key (cover_media_id) references media_assets (id) on delete set null;

create policy media_editor_write on media_assets for all
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
alter table media_subjects enable row level security;
alter table media_labels enable row level security;
create policy media_subjects_staff_read on media_subjects for select
  using (exists (select 1 from media_assets m where m.id = media_id and is_pack_staff(m.pack_id)));
create policy media_subjects_editor_write on media_subjects for all
  using (exists (select 1 from media_assets m where m.id = media_id and can_edit_pack(m.pack_id)))
  with check (exists (select 1 from media_assets m where m.id = media_id and can_edit_pack(m.pack_id)));
create policy media_labels_staff_read on media_labels for select
  using (exists (select 1 from media_assets m where m.id = media_id and is_pack_staff(m.pack_id)));
create policy media_labels_editor_write on media_labels for all
  using (exists (select 1 from media_assets m where m.id = media_id and can_edit_pack(m.pack_id)))
  with check (exists (select 1 from media_assets m where m.id = media_id and can_edit_pack(m.pack_id)));

-- Bucket: «media» privato (originali della redazione, percorso <pack_id>/<file>);
-- «bundles» pubblico in lettura (lo legge l'app), scritto solo dal servizio di pubblicazione.
insert into storage.buckets (id, name, public) values ('media', 'media', false), ('bundles', 'bundles', true)
on conflict (id) do nothing;

create policy media_files_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.is_pack_staff((storage.foldername(name))[1]));
create policy media_files_editor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.can_edit_pack((storage.foldername(name))[1]));
create policy media_files_editor_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.can_edit_pack((storage.foldername(name))[1]));
create policy media_files_editor_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.can_edit_pack((storage.foldername(name))[1]));
create policy bundles_public_read on storage.objects for select
  using (bucket_id = 'bundles');

-- ---------------------------------------------------------------------
-- 8. VISITATORI: profilo, preferenze, preferiti, percorsi, consensi
-- ---------------------------------------------------------------------
-- La registrazione è facoltativa: tutto ciò che serve a visitare funziona senza account.
-- Nessuna posizione GPS sul server. I download offline restano sul dispositivo.

create table profiles (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  display_name     text check (char_length(display_name) <= 80),
  preferred_locale text references locales (code),
  listening        jsonb not null default '{}',   -- modalità della guida, velocità, voce
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table favorites (
  user_id    uuid not null references auth.users (id) on delete cascade,
  pack_id    text not null references packs (id) on delete cascade,
  place_id   uuid references nodes (id) on delete cascade,
  route_id   uuid references routes (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((place_id is null) <> (route_id is null)),
  unique nulls not distinct (user_id, place_id, route_id)
);

create table route_progress (
  user_id      uuid not null references auth.users (id) on delete cascade,
  route_id     uuid not null references routes (id) on delete cascade,
  reached      uuid[] not null default '{}',    -- luoghi raggiunti (nodi), nell'ordine
  skipped      uuid[] not null default '{}',
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, route_id)
);

-- Registro dei consensi: si aggiunge, non si modifica.
create table consents (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('terms', 'privacy', 'sync', 'marketing')),
  granted    boolean not null,
  version    text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table favorites enable row level security;
alter table route_progress enable row level security;
alter table consents enable row level security;
create policy profiles_own on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy favorites_own on favorites for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy route_progress_own on route_progress for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy consents_own_read on consents for select using (user_id = auth.uid());
create policy consents_own_insert on consents for insert with check (user_id = auth.uid());

-- Il profilo nasce con l'account (lingua scelta alla registrazione, se indicata).
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare lang text := new.raw_user_meta_data ->> 'locale';
begin
  insert into profiles (user_id, preferred_locale)
  values (new.id, case when lang in (select code from locales where enabled) then lang end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

-- Cancellazione dell'account su richiesta dell'interessato: profilo, preferiti, percorsi, consensi,
-- diritti di accesso spariscono a cascata. (Gli acquisti futuri vanno conservati per obblighi fiscali:
-- vedi sezione 9, il collegamento all'utente diventa nullo.)
create or replace function delete_my_account()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then
    raise exception 'serve un utente autenticato';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke execute on function delete_my_account() from anon;

-- ---------------------------------------------------------------------
-- 9. CONTENUTI PREMIUM: predisposizione, senza prezzi né pagamenti
-- ---------------------------------------------------------------------
-- Livello di accesso dei contenuti; prodotti (cosa sbloccano, non quanto costano);
-- diritti di accesso per utente; acquisti da riconciliare con un fornitore ancora da scegliere.
-- Il diritto di accesso si verifica SOLO lato server (funzioni qui sotto), mai dal frontend.

create type access_tier as enum ('free', 'premium');
alter table routes add column access_tier access_tier not null default 'free';
alter table narrative_units add column access_tier access_tier not null default 'free';

create table products (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind        text not null check (kind in ('pack_access', 'route_access', 'feature')),
  pack_id     text references packs (id),
  route_id    uuid references routes (id),
  feature     text,
  labels      jsonb not null default '{}',     -- nome e descrizione per lingua
  status      text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  created_at  timestamptz not null default now(),
  check ((kind = 'pack_access') = (pack_id is not null and route_id is null)),
  check ((kind = 'route_access') = (route_id is not null)),
  check ((kind = 'feature') = (feature is not null))
);

-- Acquisto presso un fornitore esterno (da riconciliare); nessun dato di pagamento qui.
create table purchases (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users (id) on delete set null,
  product_id   uuid not null references products (id),
  provider     text not null,
  provider_ref text not null,
  status       text not null check (status in ('pending', 'completed', 'refunded', 'failed', 'disputed')),
  raw          jsonb,                       -- ultimo evento del fornitore, per la riconciliazione
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);

create table entitlements (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  product_id  uuid not null references products (id),
  source      text not null check (source in ('purchase', 'grant', 'promo', 'partner')),
  purchase_id uuid references purchases (id),
  status      text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  valid_from  timestamptz not null default now(),
  valid_until timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  check (source <> 'purchase' or purchase_id is not null),
  check (valid_until is null or valid_until > valid_from)
);
create index entitlements_user_idx on entitlements (user_id) where status = 'active';

alter table products enable row level security;
alter table purchases enable row level security;
alter table entitlements enable row level security;
-- I prodotti attivi sono visibili a tutti (nomi e descrizioni); li gestisce l'amministratore.
create policy products_public_read on products for select using (status = 'active' or is_platform_admin());
create policy products_admin_write on products for all using (is_platform_admin()) with check (is_platform_admin());
-- Ognuno vede i propri acquisti e diritti; nessuno li crea per sé: li scrive il server (ruolo di servizio)
-- dopo la conferma del fornitore, oppure l'amministratore (concessioni manuali).
create policy purchases_own_read on purchases for select using (user_id = auth.uid() or is_platform_admin());
create policy entitlements_own_read on entitlements for select using (user_id = auth.uid() or is_platform_admin());
create policy entitlements_admin_write on entitlements for all using (is_platform_admin()) with check (is_platform_admin());

-- Ha l'utente corrente diritto a un prodotto attivo, adesso?
create or replace function has_entitlement(p_product uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.product_id = p_product and e.status = 'active'
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
  );
$$;

-- Può l'utente corrente accedere a un percorso? Gratuito: sì. Premium: serve un diritto sul percorso
-- o sul territorio. Da chiamare lato server prima di servire un contenuto premium.
create or replace function can_access_route(p_route uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select r.access_tier = 'free'
        or exists (
          select 1 from products p
          where p.status = 'active'
            and (p.route_id = r.id or (p.kind = 'pack_access' and p.pack_id = r.pack_id))
            and has_entitlement(p.id))
    from routes r where r.id = p_route
  ), false);
$$;

-- ---------------------------------------------------------------------
-- 10. DATI PERSONALI
-- ---------------------------------------------------------------------

-- Esportazione dei propri dati (diritto di accesso).
create or replace function export_my_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where p.user_id = auth.uid()),
    'favorites', coalesce((select jsonb_agg(to_jsonb(f)) from favorites f where f.user_id = auth.uid()), '[]'),
    'route_progress', coalesce((select jsonb_agg(to_jsonb(r)) from route_progress r where r.user_id = auth.uid()), '[]'),
    'consents', coalesce((select jsonb_agg(to_jsonb(c)) from consents c where c.user_id = auth.uid()), '[]'),
    'entitlements', coalesce((select jsonb_agg(to_jsonb(e)) from entitlements e where e.user_id = auth.uid()), '[]')
  );
$$;
