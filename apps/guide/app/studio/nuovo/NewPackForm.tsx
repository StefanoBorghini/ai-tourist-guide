"use client";

import { useState } from "react";
import { PACK_ID_RE, suggestPackId, withinScopes } from "../../../lib/studio/shared";
import { createPack } from "../actions";

interface Parent {
  id: string;
  name: string;
  kind: string;
}

/** Modulo del nuovo territorio: l'identificativo si propone da solo (contenitore + nome) e si può correggere. */
export function NewPackForm(props: { anywhere: boolean; scopes: string[]; admin: boolean; organizations: { id: string; name: string }[]; parents: Parent[] }) {
  const parents = props.parents.filter((p) => p.kind !== "destination");
  const defaultParent = props.anywhere ? "" : (props.scopes[0] ?? "");
  const [parent, setParent] = useState(defaultParent);
  const [name, setName] = useState("");
  const [id, setId] = useState(suggestPackId(defaultParent, ""));
  const [idTouched, setIdTouched] = useState(false);
  const shownId = idTouched ? id : suggestPackId(parent, name);
  const idProblem = !shownId
    ? null
    : !PACK_ID_RE.test(shownId)
      ? "Solo minuscole, cifre e trattini; livelli separati da punti."
      : !withinScopes(shownId, props.anywhere, props.scopes)
        ? `Fuori dai tuoi territori: deve iniziare con ${props.scopes.join(" oppure ")}.`
        : null;

  return (
    <form action={createPack} className="st-form">
      <fieldset>
        <legend>Identità</legend>
        <div className="st-row">
          <label>
            Nome (italiano)
            <input name="title_it" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="es. Lerici" />
          </label>
          <label>
            Nome (inglese)
            <input name="title_en" maxLength={120} />
          </label>
        </div>
        <div className="st-row">
          <label>
            Tipologia
            <select name="kind" defaultValue="destination">
              <option value="destination">Destinazione (luogo da visitare con la guida)</option>
              <option value="area">Area (raggruppa destinazioni vicine)</option>
              <option value="region">Regione (contenitore di aree e destinazioni)</option>
            </select>
          </label>
          <label>
            Dentro il territorio
            <select
              name="dependsOn"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              {props.anywhere && <option value="">— nessuno (territorio di primo livello) —</option>}
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Identificativo
          <input
            name="id"
            required
            value={shownId}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value.trim());
            }}
            aria-describedby="id-help"
          />
        </label>
        <p id="id-help" className={idProblem ? "st-notice st-error" : "st-hint"}>
          {idProblem ?? "Gerarchico, dal generale al particolare (es. it.liguria.sp.lerici). È la chiave di tutti i contenuti: non si cambia."}
        </p>
        {props.admin && props.organizations.length > 1 && (
          <label>
            Organizzazione
            <select name="organizationId" defaultValue="">
              <option value="">quella del territorio che lo contiene</option>
              {props.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      <fieldset>
        <legend>Descrizione e lingue</legend>
        <label>
          Descrizione (italiano)
          <textarea name="description_it" rows={3} maxLength={1000} />
        </label>
        <label>
          Descrizione (inglese)
          <textarea name="description_en" rows={3} maxLength={1000} />
        </label>
        <div className="st-row">
          <label>
            Lingua principale
            <select name="defaultLocale" defaultValue="it">
              <option value="it">Italiano</option>
              <option value="en">Inglese</option>
            </select>
          </label>
          <div className="st-checks" role="group" aria-label="Lingue supportate">
            <label className="st-inline">
              <input type="checkbox" name="locales" value="it" defaultChecked /> Italiano
            </label>
            <label className="st-inline">
              <input type="checkbox" name="locales" value="en" defaultChecked /> Inglese
            </label>
          </div>
        </div>
        <label>
          Stadio
          <select name="releaseStage" defaultValue="research">
            <option value="research">Ricerca: anteprima con contenuti in revisione dichiarati</option>
            <option value="field_test">Prova sul campo: anteprima</option>
            <option value="production">Produzione: solo contenuti verificati e luoghi rilevati sul posto</option>
          </select>
        </label>
      </fieldset>
      <div className="st-actions">
        <button className="st-btn st-primary" type="submit" disabled={!!idProblem || !shownId || !name.trim()}>
          Crea il territorio
        </button>
      </div>
    </form>
  );
}
