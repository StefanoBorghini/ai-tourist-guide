-- Luoghi in vendita anche senza racconti (decisione del 2026-10-18): conta solo la scelta dello Studio (A pagamento,
-- Introduttivo, Gratuito), non se il luogo ha già racconti. I racconti aggiunti dopo entrano nel file a pagamento del
-- luogo alla pubblicazione successiva. Cambia solo catalog_problem_place: nessuna tabella, nessun dato.

-- Perché un luogo non si può vendere (null se si può): esplorazione gratuita, luogo introduttivo o gratuito.
create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'introPlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo introduttivo: è già gratuito', (select slug from nodes where id = p_place))
    when coalesce(pk.config -> 'access' -> 'freePlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo gratuito (pagina Vendita): non si vende', (select slug from nodes where id = p_place))
  end
  from packs pk where pk.id = p_pack;
$$;
