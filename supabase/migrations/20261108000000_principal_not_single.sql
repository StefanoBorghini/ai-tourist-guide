-- Acquisto progressivo, correzione del 2026-11-01: un luogo principale non si vende come contenuto singolo. Si compra
-- solo intero (prodotto «place»), con i suoi sottoluoghi; come contenuto singolo si vendono solo i sottoluoghi. I
-- racconti propri del principale restano un'unità nel conteggio dello sconto (comprati con il luogo, la destinazione o
-- tutte) e nel tetto dei singoli valgono la tariffa del contenuto singolo.
--
-- Cambia solo catalog_problem_unit: i prodotti «Contenuto singolo» di luoghi principali già creati escono subito dal
-- listino pubblico e non si possono più comprare; «Metti in vendita i contenuti singoli» li passa a «ritirato». Nessun
-- dato cancellato: chi li ha già comprati tiene il diritto e il file.
create or replace function catalog_problem_unit(p_pack text, p_node uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il contenuto è già gratuito'
    when not exists (select 1 from commerce_units(p_pack) u where u.node_id = p_node)
      then format('«%s» non ha contenuti a pagamento pubblicati e verificati (luogo gratuito, racconti in revisione o non '
                  'ancora pubblicati: verifica i fatti, poi «Ripubblica con le modifiche»)', (select slug from nodes where id = p_node))
    when place_parent(p_node) is null
      then format('«%s» è un luogo principale: si vende il luogo intero, che comprende i suoi sottoluoghi',
                  (select slug from nodes where id = p_node))
    when (select count(*) from commerce_units(p_pack) u
          where u.principal_id = coalesce(place_parent(p_node), p_node)) < 2
      then format('«%s» è l''unico contenuto del suo luogo: si vende il luogo, allo stesso prezzo del singolo',
                  (select slug from nodes where id = p_node))
  end
  from packs pk where pk.id = p_pack;
$$;
