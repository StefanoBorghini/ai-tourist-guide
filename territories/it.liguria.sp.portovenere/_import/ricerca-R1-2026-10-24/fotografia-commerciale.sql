-- Fotografia commerciale di Porto Venere — SOLA LETTURA (nessun insert, update o delete).
-- Da eseguire nel SQL Editor di Supabase PRIMA e DOPO le correzioni dei luoghi, poi esportare il risultato (CSV).
-- Confrontando le due versioni si vede se accessi gratuiti, prodotti, prezzi e percorsi a pagamento sono rimasti
-- invariati. Il risultato è una sola riga JSON. È un'unica SELECT: non modifica niente.
select jsonb_pretty(jsonb_build_object(
  'scattata_il', now(),
  'destinazione', (select jsonb_build_object('stato', d.status, 'creata', d.created_at)
                   from destinations d where d.pack_id = 'it.liguria.sp.portovenere'),
  'accesso', (select p.config -> 'access' from packs p where p.id = 'it.liguria.sp.portovenere'),
  'pubblicazioni_recenti', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
      select status, created_at, finished_at, note from publications
      where pack_id = 'it.liguria.sp.portovenere' order by created_at desc limit 5) x),
  'percorsi', (select coalesce(jsonb_agg(jsonb_build_object(
        'slug', r.slug, 'stato', r.status,
        'nome_it', r.labels -> 'it' ->> 'name', 'nome_en', r.labels -> 'en' ->> 'name',
        'tappe', (select count(*) from route_stops st where st.route_id = r.id),
        'prodotti', (select coalesce(jsonb_agg(pr.slug), '[]') from products pr
                     where pr.route_id = r.id
                        or pr.id in (select product_id from product_routes prr where prr.route_id = r.id)))
      order by r.slug), '[]')
      from routes r where r.pack_id = 'it.liguria.sp.portovenere'),
  'prodotti', (select coalesce(jsonb_agg(jsonb_build_object(
        'slug', pr.slug, 'tipo', pr.kind, 'stato', pr.status, 'disponibilita', pr.availability,
        'percorso', (select r.slug from routes r where r.id = pr.route_id),
        'luogo', (select n.slug from nodes n where n.id = pr.place_id),
        'percorsi_inclusi', (select coalesce(jsonb_agg(r.slug order by r.slug), '[]')
                             from product_routes prr join routes r on r.id = prr.route_id where prr.product_id = pr.id),
        'prezzo_pubblicato_cent', (select pp.unit_amount from product_prices pp
                                   where pp.product_id = pr.id and pp.status = 'published'),
        'prezzo_in_bozza_cent', (select pp.unit_amount from product_prices pp
                                 where pp.product_id = pr.id and pp.status = 'draft'),
        'acquisti', (select count(*) from purchases pu where pu.product_id = pr.id),
        'diritti_attivi', (select count(*) from entitlements e where e.product_id = pr.id and e.status = 'active'))
      order by pr.kind, pr.slug), '[]')
      from products pr where pr.pack_id = 'it.liguria.sp.portovenere')
)) as fotografia_commerciale;
