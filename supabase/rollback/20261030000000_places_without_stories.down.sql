-- Revoca di 20261030000000_places_without_stories.sql: torna la versione di 20261029000000 (un luogo senza racconti
-- non si vende). Non tocca prodotti già creati: quelli di luoghi senza racconti risulteranno «Non vendibile».
create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'introPlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo introduttivo: è già gratuito', (select slug from nodes where id = p_place))
    when coalesce(pk.config -> 'access' -> 'freePlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo gratuito (pagina Vendita): non si vende', (select slug from nodes where id = p_place))
    when not exists (select 1 from narrative_units u where u.anchor_node_id = p_place)
      then format('«%s» non ha racconti: non c''è niente da vendere', (select slug from nodes where id = p_place))
  end
  from packs pk where pk.id = p_pack;
$$;
