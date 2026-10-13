-- Revoca di 20261017000000_studio.sql.
drop function if exists studio_register_media(text, jsonb);
drop function if exists studio_media(text);
drop function if exists studio_confirm_evidence(text, text, int, text);
drop function if exists studio_review_assertion(text, text, text, text);
drop function if exists studio_assertions(text, text);
drop function if exists studio_set_route_stops(text, text, jsonb);
drop function if exists studio_route(text, text);
drop function if exists studio_routes(text);
drop function if exists studio_update_place(text, text, jsonb);
drop function if exists studio_place(text, text);
drop function if exists studio_places(text);
drop function if exists studio_packs();
drop function if exists studio_me();
drop function if exists studio_place_ref(text, text);
drop function if exists studio_require(boolean, text);
drop function if exists studio_node_name(uuid);
update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'media';
alter table assertions drop column if exists review_note;
