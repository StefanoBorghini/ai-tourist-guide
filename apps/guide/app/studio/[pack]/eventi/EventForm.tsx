import { saveLocalEvent } from "../../actions-events";
import {
  CATEGORY_LABELS, EVENT_CATEGORIES, EVENT_STATUS_LABELS, EVENT_STATUSES, MONTHLY_LABELS, PRICE_LABELS, PRICES, RECURRENCE_LABELS,
  WEEKDAY_LABELS, type FormValues,
} from "../../../../lib/studio/local-events";
import { MONTHLY_MODES } from "../../../../lib/local-events";

/**
 * Modulo dell'evento, uguale per creazione e modifica. Date e orari sono quelli locali del territorio; i controlli
 * del browser aiutano soltanto, decide il database.
 */
export function EventForm({ pack, id, values, locales, defaultLocale, places, published, readOnly }: {
  pack: string;
  id?: string;
  values: FormValues;
  locales: string[];
  defaultLocale: string;
  places: { slug: string; name: string }[];
  published: boolean;
  readOnly: boolean;
}) {
  const v = (k: string) => values[k] ?? "";
  return (
    <form action={saveLocalEvent} className="st-form">
      <input type="hidden" name="pack" value={pack} />
      {id && <input type="hidden" name="id" value={id} />}
      <fieldset disabled={readOnly}>
        <legend>Evento</legend>
        {locales.map((l) => (
          <div key={l} className="st-row">
            <label>
              Titolo ({l}){l === defaultLocale ? " *" : ""}
              <input name={`title_${l}`} maxLength={140} defaultValue={v(`title_${l}`)} required={l === defaultLocale} />
            </label>
            <label>
              Descrizione breve ({l})
              <input name={`summary_${l}`} maxLength={300} defaultValue={v(`summary_${l}`)} />
            </label>
          </div>
        ))}
        {locales.map((l) => (
          <label key={l}>
            Descrizione ({l})
            <textarea name={`description_${l}`} maxLength={4000} rows={3} defaultValue={v(`description_${l}`)} />
          </label>
        ))}
        <div className="st-row">
          <label>
            Categoria *
            <select name="category" defaultValue={v("category")} required>
              <option value="" disabled>Scegli…</option>
              {EVENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </label>
          {!id && (
            <label>
              Identificativo (facoltativo)
              <input name="slug" maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="dal titolo e dalla data" defaultValue={v("slug")} />
            </label>
          )}
        </div>
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>Quando (ora locale del territorio)</legend>
        <div className="st-row">
          <label>
            Data di inizio *
            <input name="startDate" type="date" defaultValue={v("startDate")} required />
          </label>
          <label>
            Ora di inizio
            <input name="startTime" type="time" defaultValue={v("startTime")} />
          </label>
          <label>
            Data di fine
            <input name="endDate" type="date" defaultValue={v("endDate")} />
          </label>
          <label>
            Ora di fine
            <input name="endTime" type="time" defaultValue={v("endTime")} />
          </label>
        </div>
        <p className="st-hint">
          Senza ora l&apos;evento vale per tutta la giornata («orario da confermare»). Per un evento oltre la mezzanotte
          indica come data di fine il giorno dopo. Se l&apos;evento si ripete, qui va la prima data: le altre le calcola la
          ricorrenza qui sotto, con gli stessi orari.
        </p>
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>Si ripete</legend>
        <div className="st-row">
          <label>
            Ricorrenza
            <select name="recurrence" defaultValue={v("recurrence") || "none"}>
              {(Object.keys(RECURRENCE_LABELS) as (keyof typeof RECURRENCE_LABELS)[]).map((r) => (
                <option key={r} value={r}>{RECURRENCE_LABELS[r]}</option>
              ))}
            </select>
          </label>
          <label>
            Ogni quanti giorni, settimane, mesi o anni
            <input name="recurrenceInterval" type="number" min={1} max={99} defaultValue={v("recurrenceInterval") || "1"} />
          </label>
          <label>
            Fino al (facoltativo)
            <input name="recurrenceUntil" type="date" defaultValue={v("recurrenceUntil")} />
          </label>
        </div>
        <div className="st-row" role="group" aria-label="Giorni della settimana (ricorrenza settimanale)">
          <span className="st-hint">Giorni della settimana (solo «Ogni settimana»; nessuno = il giorno della data di inizio):</span>
          {WEEKDAY_LABELS.map((name, i) => (
            <label key={name} className="st-inline">
              <input type="checkbox" name={`weekday_${i + 1}`} defaultChecked={v(`weekday_${i + 1}`) === "on"} />
              {name}
            </label>
          ))}
        </div>
        <label>
          Ogni mese, ripeti (solo «Ogni mese»)
          <select name="recurrenceMonthly" defaultValue={v("recurrenceMonthly") || "day"}>
            {MONTHLY_MODES.map((m) => (
              <option key={m} value={m}>{MONTHLY_LABELS[m]}</option>
            ))}
          </select>
        </label>
        <label>
          Date escluse (facoltative: es. 2027-08-15, 22/08/2027)
          <textarea name="recurrenceExcept" rows={2} defaultValue={v("recurrenceExcept")} />
        </label>
        <p className="st-hint">
          «Ogni 2» con «Ogni settimana» vuol dire una settimana sì e una no. Senza data di fine la serie continua finché non la
          cambi. Annullato, rinviato e da confermare valgono per tutta la serie: per saltare una sola data aggiungila alle date
          escluse. Dopo il salvataggio, in cima alla pagina trovi le prossime date calcolate.
        </p>
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>Dove</legend>
        <div className="st-row">
          <label>
            Nome del luogo dell&apos;evento *
            <input name="venueName" maxLength={160} defaultValue={v("venueName")} required />
          </label>
          <label>
            Luogo del territorio (facoltativo)
            <select name="place" defaultValue={v("place")}>
              <option value="">— nessuno —</option>
              {places.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="st-row">
          <label>
            Indirizzo
            <input name="venueAddress" maxLength={240} defaultValue={v("venueAddress")} />
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
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>Fonte e informazioni</legend>
        <div className="st-row">
          <label>
            Fonte ufficiale (obbligatoria per pubblicare)
            <input name="sourceUrl" type="url" maxLength={500} placeholder="https://" defaultValue={v("sourceUrl")} />
          </label>
          <label>
            Organizzatore
            <input name="organizer" maxLength={160} defaultValue={v("organizer")} />
          </label>
        </div>
        <div className="st-row">
          <label>
            Informazioni
            <input name="infoUrl" type="url" maxLength={500} placeholder="https://" defaultValue={v("infoUrl")} />
          </label>
          <label>
            Prenotazione
            <input name="bookingUrl" type="url" maxLength={500} placeholder="https://" defaultValue={v("bookingUrl")} />
          </label>
        </div>
        <div className="st-row">
          <label>
            Prezzo
            <select name="price" defaultValue={v("price") || "unknown"}>
              {PRICES.map((p) => (
                <option key={p} value={p}>{PRICE_LABELS[p]}</option>
              ))}
            </select>
          </label>
          <label>
            Nota sul prezzo
            <input name="priceNote" maxLength={160} defaultValue={v("priceNote")} />
          </label>
          <label>
            Lingue dell&apos;evento (es. it, en)
            <input name="languages" maxLength={40} defaultValue={v("languages")} />
          </label>
        </div>
        {!id && (
          <div className="st-row">
            <label>
              Stato
              <select name="status" defaultValue={v("status") || "scheduled"}>
                {EVENT_STATUSES.map((s) => (
                  <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </label>
            <label>
              Nota sullo stato (pubblica)
              <input name="statusNote" maxLength={300} defaultValue={v("statusNote")} />
            </label>
          </div>
        )}
        {id && (
          <>
            <input type="hidden" name="status" value={v("status")} />
            <input type="hidden" name="statusNote" value={v("statusNote")} />
          </>
        )}
        <label className="st-inline">
          <input type="checkbox" name="verify" />
          Ho verificato ora sulla fonte ufficiale date, orari e luogo
        </label>
        {published && (
          <p className="st-hint">
            L&apos;evento è pubblicato: se cambi date, orari, ricorrenza, luogo o fonte devi spuntare la verifica, altrimenti il
            salvataggio viene rifiutato (in alternativa ritiralo prima).
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
