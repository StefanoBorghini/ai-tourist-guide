-- Protezione delle tabelle rimaste senza RLS.
--
-- Su Supabase le tabelle di `public` sono raggiungibili dall'API con la chiave pubblica: senza RLS
-- chiunque le potrebbe leggere e modificare. Trovate dalla verifica sul progetto reale
-- (supabase/tests/remote-check.sql), che ora controlla che nessuna tabella resti scoperta.
-- Stesse regole delle tabelle vicine: lo staff del territorio legge, chi lo redige scrive.

alter table organizations enable row level security;
alter table locales enable row level security;
alter table predicates enable row level security;
alter table media_license_rules enable row level security;
alter table pack_dependencies enable row level security;
alter table node_external_ids enable row level security;
alter table territory_memberships enable row level security;
alter table walk_edges enable row level security;
alter table audio_assets enable row level security;

-- Organizzazioni: ciascuno vede quelle di cui fa parte; le gestisce l'amministratore.
create policy organizations_member_read on organizations for select
  using (is_platform_admin() or exists (select 1 from memberships m where m.organization_id = organizations.id and m.user_id = auth.uid()));
create policy organizations_admin_write on organizations for all
  using (is_platform_admin()) with check (is_platform_admin());

-- Vocabolari (lingue, predicati, licenze): leggibili da chi ha un account, modificabili solo
-- con una migrazione (rispecchiano packages/domain).
create policy locales_read on locales for select to authenticated using (true);
create policy predicates_read on predicates for select to authenticated using (true);
create policy media_license_rules_read on media_license_rules for select to authenticated using (true);

-- Dipendenze tra pack: struttura dei territori, la decide l'amministratore.
create policy pack_dependencies_staff_read on pack_dependencies for select using (is_pack_staff(pack_id));
create policy pack_dependencies_admin_write on pack_dependencies for all
  using (is_platform_admin()) with check (is_platform_admin());

create policy node_external_ids_staff_read on node_external_ids for select
  using (exists (select 1 from nodes n where n.id = node_id and is_pack_staff(n.pack_id)));
create policy node_external_ids_editor_write on node_external_ids for all
  using (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = node_id and can_edit_pack(n.pack_id)));

create policy territory_memberships_staff_read on territory_memberships for select
  using (exists (select 1 from nodes n where n.id = territory_node_id and is_pack_staff(n.pack_id)));
create policy territory_memberships_editor_write on territory_memberships for all
  using (exists (select 1 from nodes n where n.id = territory_node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = territory_node_id and can_edit_pack(n.pack_id)));

-- Tempi di cammino: appartengono al territorio del luogo di partenza.
create policy walk_edges_staff_read on walk_edges for select
  using (exists (select 1 from nodes n where n.id = from_node_id and is_pack_staff(n.pack_id)));
create policy walk_edges_editor_write on walk_edges for all
  using (exists (select 1 from nodes n where n.id = from_node_id and can_edit_pack(n.pack_id)))
  with check (exists (select 1 from nodes n where n.id = from_node_id and can_edit_pack(n.pack_id)));

-- Audio: generato dal servizio di pubblicazione (che non passa da RLS); lo staff lo ascolta.
create policy audio_assets_staff_read on audio_assets for select
  using (exists (select 1 from narrative_units u where u.id = unit_id and is_pack_staff(u.pack_id)));
