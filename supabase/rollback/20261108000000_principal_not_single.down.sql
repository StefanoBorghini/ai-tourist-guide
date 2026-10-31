-- Revoca di 20261108000000_principal_not_single.sql: torna la versione di 20261107000000 (anche il luogo principale
-- si vende come contenuto singolo). Non tocca prodotti né diritti.
create or replace function catalog_problem_unit(p_pack text, p_node uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il contenuto è già gratuito'
    when not exists (select 1 from commerce_units(p_pack) u where u.node_id = p_node)
      then format('«%s» non ha contenuti a pagamento pubblicati e verificati (luogo gratuito, racconti in revisione o non '
                  'ancora pubblicati: verifica i fatti, poi «Ripubblica con le modifiche»)', (select slug from nodes where id = p_node))
    when (select count(*) from commerce_units(p_pack) u
          where u.principal_id = coalesce(place_parent(p_node), p_node)) < 2
      then format('«%s» è l''unico contenuto del suo luogo: si vende il luogo, allo stesso prezzo del singolo',
                  (select slug from nodes where id = p_node))
  end
  from packs pk where pk.id = p_pack;
$$;
