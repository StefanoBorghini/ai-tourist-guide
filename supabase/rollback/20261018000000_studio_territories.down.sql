-- Revoca di 20261018000000_studio_territories.sql (i territori creati restano: si tolgono solo funzioni e permessi).
drop function if exists studio_create_route(text, jsonb);
drop function if exists studio_units(text);
drop function if exists studio_create_unit(text, jsonb);
drop function if exists studio_create_assertion(text, jsonb);
drop function if exists studio_sources(text);
drop function if exists studio_create_source(text, jsonb);
drop function if exists studio_create_place(text, jsonb);
drop function if exists studio_set_pack_status(text, text, jsonb);
drop function if exists studio_publish_blockers(text);
drop function if exists studio_update_pack(text, jsonb);
drop function if exists studio_create_pack(jsonb);
drop function if exists studio_check_dependencies(text, jsonb);
drop function if exists studio_pack(text);
drop function if exists studio_creation_scopes();
drop function if exists studio_clean_texts(jsonb);
drop function if exists studio_free_slug(text, text[]);
drop function if exists studio_slugify(text);
revoke execute on function pack_snapshot(text) from authenticated;
drop policy if exists pack_dependencies_editor_write on pack_dependencies;
drop policy if exists packs_editor_insert on packs;
-- studio_packs torna alla versione della milestone 4.
create or replace function studio_packs()
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'kind', p.kind, 'title', p.title, 'version', p.version, 'releaseStage', p.release_stage,
    'places', (select count(*) from nodes n join places pl on pl.node_id = n.id where n.pack_id = p.id),
    'routes', (select count(*) from routes r where r.pack_id = p.id),
    'media', (select count(*) from media_assets m where m.pack_id = p.id),
    'assertions', (select coalesce(jsonb_object_agg(s.status, s.n), '{}')
                   from (select status, count(*) n from assertions a where a.pack_id = p.id group by status) s),
    'canEdit', can_edit_pack(p.id), 'canVerify', can_verify_pack(p.id)) order by p.id), '[]')
  from packs p where is_pack_staff(p.id);
$$;
