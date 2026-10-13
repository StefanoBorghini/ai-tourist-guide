import { requireStaff, rpc } from "../../../../../lib/studio/server";
import { createPlace } from "../../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";

export default async function NewPlacePage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const { data: k } = await rpc<{ canEdit: boolean; defaultLocale: string }>(session.supabase, "studio_pack", { p_pack: pack });
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: `/studio/${encodeURIComponent(pack)}/luoghi`, label: pack }, { label: "Nuovo luogo" }]} />
      <PackTabs pack={pack} current="luoghi" />
      <h1>Nuovo luogo</h1>
      <Notice errore={one(q.errore)} />
      {!k?.canEdit ? (
        <p>Il tuo ruolo non aggiunge luoghi a questo territorio.</p>
      ) : (
        <form action={createPlace} className="st-form">
          <input type="hidden" name="pack" value={pack} />
          <fieldset>
            <legend>Nome</legend>
            {(["it", "en"] as const).map((l) => (
              <div key={l} className="st-row">
                <label>
                  Nome ({l})
                  <input name={`name_${l}`} maxLength={120} required={l === k.defaultLocale} />
                </label>
                <label>
                  Descrizione breve ({l})
                  <input name={`short_${l}`} maxLength={240} />
                </label>
              </div>
            ))}
          </fieldset>
          <fieldset>
            <legend>Posizione</legend>
            <p className="st-hint">
              Le coordinate entrano come «preliminari»: si dichiarano verificate solo dopo il controllo su mappa o il rilievo sul posto.
              Il luogo riceve un'area di arrivo circolare (il raggio si può cambiare).
            </p>
            <div className="st-row">
              <label>
                Longitudine
                <input name="lng" inputMode="decimal" required placeholder="es. 9.8345" />
              </label>
              <label>
                Latitudine
                <input name="lat" inputMode="decimal" required placeholder="es. 44.0517" />
              </label>
              <label>
                Raggio di arrivo (m)
                <input name="radiusM" type="number" min={5} max={2000} defaultValue={40} />
              </label>
            </div>
            <label>
              Come sono state ottenute
              <input name="coordinateMethod" required maxLength={300} placeholder="es. rilievo GPS sul posto, precisione 4 m" />
            </label>
          </fieldset>
          <fieldset>
            <legend>Visita</legend>
            <div className="st-row">
              <label>
                Tipo
                <select name="placeKind" defaultValue="poi">
                  <option value="poi">Punto d'interesse</option>
                  <option value="site">Sito (con parti)</option>
                  <option value="feature">Elemento (dettaglio di un luogo)</option>
                </select>
              </label>
              <label>
                Importanza (1–5)
                <input name="importance" type="number" min={1} max={5} defaultValue={3} />
              </label>
              <label>
                Sosta (minuti)
                <input name="dwellMin" type="number" min={1} max={240} defaultValue={10} />
              </label>
            </div>
            <label>
              Categorie (separate da virgole)
              <input name="categories" placeholder="es. chiesa, architettura" />
            </label>
          </fieldset>
          <div className="st-actions">
            <button className="st-btn st-primary" type="submit">Crea il luogo</button>
          </div>
        </form>
      )}
    </main>
  );
}
