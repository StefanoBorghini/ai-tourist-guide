-- Ruolo di amministratore della piattaforma (gestisce utenti, ruoli e ogni territorio).
-- Migrazione a sé: un nuovo valore di enum non si può usare nella stessa transazione in cui nasce.
alter type member_role add value if not exists 'platform_admin' before 'platform_editor';
