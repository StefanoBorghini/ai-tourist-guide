-- Revoca di 20261019000000_studio_delete.sql: si tolgono le funzioni; le copie salvate in content_revisions restano.
drop function if exists studio_delete_pack(text, text);
drop function if exists studio_delete(text, text, text);
drop function if exists studio_delete_plan(text, text, text);
drop function if exists studio_assertion_label(uuid);
drop function if exists studio_orphan_files(uuid[]);
drop function if exists studio_ref(text, text, text);
drop function if exists studio_archive_snapshot(text, jsonb);
