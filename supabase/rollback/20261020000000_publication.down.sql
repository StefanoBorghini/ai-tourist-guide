-- Revoca di 20261020000000_publication.sql: si tolgono funzioni e policy; pubblicazioni, bundle e file restano.
drop policy if exists bundles_files_publisher_update on storage.objects;
drop policy if exists bundles_files_publisher_insert on storage.objects;
drop function if exists public_bundle_index();
drop function if exists studio_publication_finish(text, boolean, jsonb, jsonb);
drop function if exists studio_request_publication(text, jsonb);
drop function if exists studio_can_publish_any();
