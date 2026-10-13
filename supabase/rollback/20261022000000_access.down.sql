-- Revoca di 20261022000000_access.sql: toglie le funzioni e i controlli dell'accesso a pagamento e ripristina
-- packs_guard() di 20261021000000_cms_hardening.sql.
-- ATTENZIONE: toglie anche la configurazione «access» dai territori. Senza la migrazione il codice precedente non
-- la riconosce (config.yaml rifiuta chiavi sconosciute) e la pubblicazione si fermerebbe. Annotala prima, se serve.

drop function if exists studio_set_access(text, jsonb);
drop function if exists studio_access(text);
drop trigger if exists routes_access_guard_trg on routes;
drop trigger if exists nodes_access_guard_trg on nodes;
drop function if exists access_refs_guard();
update packs set config = config - 'access' where config ? 'access';

create or replace function packs_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' or is_platform_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.kind = 'core' then raise exception 'solo l''amministratore crea territori di tipo core'; end if;
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'solo l''amministratore della piattaforma cambia l''organizzazione di un territorio';
  end if;
  if new.kind is distinct from old.kind then raise exception 'la tipologia di un territorio non cambia'; end if;
  if new.fictional is distinct from old.fictional then raise exception 'solo l''amministratore cambia «fittizio»'; end if;
  if (new.release_stage is distinct from old.release_stage and 'production' in (new.release_stage::text, old.release_stage::text))
     or new.config is distinct from old.config or new.quality_tier is distinct from old.quality_tier then
    perform studio_require(can_publish_pack(new.id), 'stadio di produzione, configurazione e livello di qualità li cambia chi pubblica');
  end if;
  return new;
end;
$$;
