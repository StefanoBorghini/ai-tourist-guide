-- Dopo la revoca riuscita di 20261024000000 (M3): modello precedente ripristinato e nessun diritto concesso.
\set ON_ERROR_STOP 1
do $$ begin
  if to_regprocedure('grant_product(uuid, uuid, text, uuid, text)') is not null or to_regprocedure('has_active_right(text, text, uuid)') is not null
     or to_regclass('public.product_routes') is not null then
    raise exception 'FALLITO: la revoca ha lasciato funzioni o tabelle del modello per ambito';
  end if;
  if exists (select 1 from products) or exists (select 1 from entitlements) then
    raise exception 'FALLITO: dopo la revoca esistono prodotti o diritti';
  end if;
  if exists (select 1 from routes r where can_access_route(r.id) is distinct from (r.access_tier = 'free')) then
    raise exception 'FALLITO: dopo la revoca un percorso è accessibile oltre il suo livello';
  end if;
end $$;
