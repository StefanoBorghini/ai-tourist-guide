-- Legame affermazione-fonte esplicito o dedotto (es. in un'importazione).
-- Un'affermazione non si verifica solo su fonti dedotte: lo impone il validatore dei pack.
create type evidence_attribution as enum ('explicit', 'inferred');
alter table evidence add column attribution evidence_attribution not null default 'explicit';
