-- Revoca di 20261103000000_question_gaps.sql: toglie il registro delle domande senza risposta.
--
-- Cancella le domande raccolte: sono dati operativi a scadenza, non contenuti. Chi vuole conservarle le esporti
-- prima dallo Studio. Tutto in una transazione: o si applica per intero o non cambia nulla.
begin;
set local lock_timeout = '10s';

drop function if exists studio_delete_question_gap(uuid);
drop function if exists studio_set_question_gap_status(uuid, text);
drop function if exists studio_question_gaps(text);
drop function if exists studio_question_gap_json(question_gaps);
drop function if exists gap_record(text, text, text, text, text, text, text, text, jsonb, text, text);
drop table if exists question_gap_daily;
drop table if exists question_gaps;
drop type if exists question_gap_review;
drop type if exists question_gap_kind;

commit;
