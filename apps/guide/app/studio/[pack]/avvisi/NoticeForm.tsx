import { saveOperationalNotice } from "../../actions-notices";
import { NOTICE_LIMITS, NOTICE_STATUS_LABELS, NOTICE_STATUSES, type FormValues } from "../../../../lib/studio/operational-notices";

/**
 * Modulo dell'avviso, uguale per creazione e modifica. Le date sono giorni del territorio (fuso della destinazione),
 * estremi compresi. I controlli del browser aiutano soltanto, decide il database.
 */
export function NoticeForm({ pack, id, values, locales, defaultLocale, places, routes, published, readOnly }: {
  pack: string;
  id?: string;
  values: FormValues;
  locales: string[];
  defaultLocale: string;
  places: { slug: string; name: string }[];
  routes: { slug: string; name: string }[];
  published: boolean;
  readOnly: boolean;
}) {
  const v = (k: string) => values[k] ?? "";
  return (
    <form action={saveOperationalNotice} className="st-form">
      <input type="hidden" name="pack" value={pack} />
      {id && <input type="hidden" name="id" value={id} />}
      <fieldset disabled={readOnly}>
        <legend>Avviso</legend>
        <div className="st-row">
          <label>
            Stato *
            <select name="status" defaultValue={v("status")} required>
              <option value="" disabled>Scegli…</option>
              {NOTICE_STATUSES.map((s) => (
                <option key={s} value={s}>{NOTICE_STATUS_LABELS[s]}</option>
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
        {locales.map((l) => (
          <div key={l} className="st-row">
            <label>
              Titolo ({l}){l === defaultLocale ? " *" : ""}
              <input name={`title_${l}`} maxLength={NOTICE_LIMITS.title} defaultValue={v(`title_${l}`)} required={l === defaultLocale} placeholder="es. Sentiero chiuso per frana" />
            </label>
            <label>
              Testo ({l})
              <textarea name={`text_${l}`} maxLength={NOTICE_LIMITS.text} rows={2} defaultValue={v(`text_${l}`)} placeholder="Cosa vale, dove, alternative: solo ciò che dice la fonte" />
            </label>
          </div>
        ))}
        <p className="st-hint">
          Gaia riferisce l&apos;avviso con le sue date e cita la fonte: scrivi solo ciò che la fonte afferma, senza
          ipotesi su cause o durate.
        </p>
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>A cosa si riferisce</legend>
        <div className="st-row">
          <label>
            Luogo
            <select name="place" defaultValue={v("place")}>
              <option value="">— nessuno —</option>
              {places.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            Percorso
            <select name="route" defaultValue={v("route")}>
              <option value="">— nessuno —</option>
              {routes.map((r) => (
                <option key={r.slug} value={r.slug}>{r.name}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="st-hint">Un luogo o un percorso, non entrambi. Senza nessuno dei due l&apos;avviso vale per tutta la destinazione.</p>
      </fieldset>

      <fieldset disabled={readOnly}>
        <legend>Validità e fonte</legend>
        <div className="st-row">
          <label>
            Valido dal *
            <input name="validFrom" type="date" defaultValue={v("validFrom")} required />
          </label>
          <label>
            Valido fino al (compreso) *
            <input name="validUntil" type="date" defaultValue={v("validUntil")} required />
          </label>
        </div>
        <p className="st-hint">Al massimo {NOTICE_LIMITS.days} giorni. Se la fonte dice «fino a nuovo avviso», scegli una data vicina e ricontrolla.</p>
        <label>
          Fonte ufficiale (obbligatoria per pubblicare)
          <input name="sourceUrl" type="url" maxLength={500} placeholder="https://" defaultValue={v("sourceUrl")} />
        </label>
        <label className="st-inline">
          <input type="checkbox" name="verify" />
          Ho verificato ora sulla fonte ufficiale stato, date e luogo
        </label>
        {published && (
          <p className="st-hint">
            L&apos;avviso è pubblicato: se cambi stato, testi, date, luogo o fonte devi spuntare la verifica, altrimenti il
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
