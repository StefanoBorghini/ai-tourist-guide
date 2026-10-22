-- Revoca di 20261102000000_free_principal_sale.sql: torna la versione di 20261101000000 (un luogo gratuito non si
-- vende mai). Non tocca prodotti: quelli di principali gratuiti risulteranno «Non vendibile».
create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'freePlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo gratuito (pagina Vendita): non si vende', (select slug from nodes where id = p_place))
    when place_parent(p_place) is not null
      then format('«%s» è un sottoluogo di «%s»: si vende con il suo luogo principale',
                  (select slug from nodes where id = p_place), (select slug from nodes where id = place_parent(p_place)))
  end
  from packs pk where pk.id = p_pack;
$$;
