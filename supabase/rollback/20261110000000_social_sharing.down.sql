-- Revoca di 20261110000000_social_sharing.sql: toglie le due funzioni dello Studio. Non tocca packs.config: un
-- account Instagram già salvato resta nella configurazione (e nei bundle già pubblicati) finché non lo si toglie.
drop function if exists studio_set_social(text, jsonb);
drop function if exists studio_social(text);
