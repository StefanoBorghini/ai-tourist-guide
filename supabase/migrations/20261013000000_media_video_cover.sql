-- Media: brevi video ambientali (con immagine poster) e copertina della destinazione.
-- I video non entrano nel pacchetto offline: si caricano solo quando servono, senza audio automatico.

alter table media_assets drop constraint if exists media_assets_kind_check;
alter table media_assets add constraint media_assets_kind_check check (kind in ('image', 'video'));

alter table media_assets
  add column poster_path text,
  add column is_cover    boolean not null default false,
  add constraint media_assets_video_poster check (kind <> 'video' or poster_path is not null);
