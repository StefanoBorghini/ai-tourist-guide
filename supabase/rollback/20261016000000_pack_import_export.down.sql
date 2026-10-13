-- Revoca di 20261016000000_pack_import_export.sql.
drop function if exists pack_snapshot(text);
drop function if exists import_pack(jsonb, uuid);
drop function if exists pack_node_labels(uuid);
drop function if exists pack_full_ref(uuid);
drop function if exists pack_text_array(jsonb);
drop function if exists pack_lnglat(geography);
drop function if exists pack_point(jsonb);
drop function if exists pack_ref_source(text);
drop function if exists pack_ref_node(text);

alter table assertions drop constraint if exists assertions_certainty_required;
alter table assertions add constraint assertions_check1 check ((type in ('fact', 'interpretation')) = (certainty is not null));

alter table route_sources drop column if exists position;
alter table media_subjects drop column if exists position;
alter table unit_hooks drop column if exists position;
alter table unit_concepts drop column if exists position;
alter table unit_assertions drop column if exists position;
alter table evidence drop column if exists position;
alter table geofences drop column if exists position;
alter table places drop column if exists part_of_node_id;
