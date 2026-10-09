-- Verifica cartografica delle coordinate, distinta dalla calibrazione GPS sul campo.
-- map_verified = controllate su cartografia con fonti dichiarate, rilievo sul posto ancora da fare
-- (etichetta redazionale MAP_VERIFIED_FIELD_PENDING).
alter type coordinate_status add value 'map_verified' after 'preliminary';

alter table places
  add column coordinate_map_verified_at date,
  add column coordinate_sources        jsonb not null default '[]',  -- fonti cartografiche: titolo, url, affidabilità, valore
  add column previous_location         geography (point, 4326);      -- coordinate prima della verifica
