-- Luogo principale gratuito con sottoluoghi a pagamento (decisione del 2026-10-22): i suoi racconti restano tutti
-- gratuiti, ma si vende lo stesso per sbloccare i suoi sottoluoghi (il suo file a pagamento contiene solo quelli).
-- Cambia solo catalog_problem_place: nessuna tabella, nessun dato.

-- Perché un luogo non si può vendere (null se si può): esplorazione gratuita, sottoluogo (si vende con il suo
-- principale), o luogo gratuito senza sottoluoghi a pagamento (non avrebbe niente da sbloccare).
create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when place_parent(p_place) is not null
      then format('«%s» è un sottoluogo di «%s»: si vende con il suo luogo principale',
                  (select slug from nodes where id = p_place), (select slug from nodes where id = place_parent(p_place)))
    when coalesce(pk.config -> 'access' -> 'freePlaces' ? (select slug from nodes where id = p_place), false)
         and not exists (
           select 1 from places cp join nodes c on c.id = cp.node_id
           where cp.part_of_node_id = p_place and place_parent(cp.node_id) = p_place
             and not coalesce(pk.config -> 'access' -> 'freePlaces' ? c.slug, false))
      then format('«%s» è un luogo gratuito senza sottoluoghi a pagamento (pagina Vendita): non si vende',
                  (select slug from nodes where id = p_place))
  end
  from packs pk where pk.id = p_pack;
$$;
