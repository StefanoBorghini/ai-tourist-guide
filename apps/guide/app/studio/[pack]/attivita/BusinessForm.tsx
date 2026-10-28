import { saveLocalBusiness } from "../../actions-businesses";
import { BUSINESS_CATEGORIES, BUSINESS_CATEGORY_LABELS, type FormValues } from "../../../../lib/studio/local-businesses";

/**
 * Modulo dell'attività, uguale per creazione e modifica. Nessun campo di affiliazione o priorità: la directory è
 * neutrale. I controlli del browser aiutano soltanto, decide il database.
 */
export function BusinessForm({ pack, id, values, locales, defaultLocale, published, readOnly }: {
  pack: string;
  id?: string;
  values: FormValues;
  locales: string[];
  defaultLocale: string;
  published: boolean;
  readOnly: boolean;
}) {
  const v = (k: string) => values[k] ?? "";
  return (
    <form action={saveLocalBusiness} className="st-form">
      <input type="hidden" name="pack" value={pack} />
      {id && <input type="hidden" name="id" value={id} />}
      <fieldset disabled={readOnly}>
        <legend>Attività</legend>
        <div className="st-row">
          <label>
            Nome *
            <input name="name" maxLength={120} defaultValue={v("name")} required />
          </label>
          <label>
            Categoria *
            <select name="category" defaultValue={v("category")} required>
              <option value="" disabled>Scegli…</option>
              {BUSINESS_CATEGORIES.map((c) => (
                <option key={c} value={c}>{BUSINESS_CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </label>
          <label>
            Tipo (facoltativo)
            <input name="subcategory" maxLength={60} placeholder="es. pizzeria, gelateria, B&amp;B" defaultValue={v("subcategory")} />
          </label>
        </div>
        {!id && (
          <label>
            Identificativo (facoltativo)
            <input name="slug" maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="dal nome" defaultValue={v("slug")} />
          </label>
        )}
        {locales.map((l) => (
          <div key={l} className="st-row">
            <label>
              Descrizione ({l}){l === defaultLocale ? "" : " — facoltativa"}
              <textarea name={`description_${l}`} maxLength={1000} rows={2} defaultValue={v(`description_${l}`)} />
            </label>
            <label>
              Orari ({l})
              <input name={`hours_${l}`} maxLength={300} placeholder="es. tutti i giorni 12–15 e 19–23, chiuso il martedì" defaultValue={v(`hours_${l}`)} />
            </label>
          </div>
        ))}
        <p className="st-hint">
          Descrizione breve e fattuale, senza giudizi né classifiche. Gli orari si mostrano nella guida solo per 180 giorni
          dall&apos;ultima verifica, poi compare «orari da verificare».
        </p>
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>Dove e come contattarla</legend>
        <div className="st-row">
          <label>
            Indirizzo
            <input name="address" maxLength={240} defaultValue={v("address")} />
          </label>
          <label>
            Latitudine
            <input name="lat" inputMode="decimal" placeholder="44.0505" defaultValue={v("lat")} />
          </label>
          <label>
            Longitudine
            <input name="lng" inputMode="decimal" placeholder="9.8357" defaultValue={v("lng")} />
          </label>
        </div>
        <div className="st-row">
          <label>
            Telefono
            <input name="phone" type="tel" maxLength={40} placeholder="+39 0187 000000" defaultValue={v("phone")} />
          </label>
          <label>
            Email
            <input name="email" type="email" maxLength={160} defaultValue={v("email")} />
          </label>
          <label>
            Sito
            <input name="website" type="url" maxLength={500} placeholder="https://" defaultValue={v("website")} />
          </label>
        </div>
        <p className="st-hint">Con le coordinate la guida ordina le attività dalla più vicina e offre le indicazioni stradali.</p>
        <label className="st-inline">
          <input type="checkbox" name="verify" />
          Ho verificato ora questi dati (sul posto, al telefono o sul sito dell&apos;attività)
        </label>
        {published && (
          <p className="st-hint">
            L&apos;attività è pubblicata: se cambi i dati devi spuntare la verifica, altrimenti il salvataggio viene
            rifiutato (in alternativa ritirala prima).
          </p>
        )}
      </fieldset>

      {!readOnly && (
        <div className="st-actions">
          <button className="st-btn st-primary" type="submit">{id ? "Salva le modifiche" : "Crea in bozza"}</button>
        </div>
      )}
    </form>
  );
}
