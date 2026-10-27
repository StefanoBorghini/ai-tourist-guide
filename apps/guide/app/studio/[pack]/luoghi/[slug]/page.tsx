import Link from "next/link";
import { requireStaff, rpc, signedMediaUrls } from "../../../../../lib/studio/server";
import { STUDIO_TIME_ZONE } from "../../../../../lib/format";
import { territoryToday } from "../../../../../lib/local-events";
import { isExpired, PRACTICAL_KIND_LABELS, PRACTICAL_LIMITS, validUntil, type PracticalItem } from "../../../../../lib/studio/practical";
import { COORDINATE_LABELS, deleteHref, friendlyError } from "../../../../../lib/studio/shared";
import { savePractical, setPlaceParent, updatePlace } from "../../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../../ui";

interface PlaceDetail {
  slug: string;
  labels: Record<string, { name: string; short?: string }>;
  placeKind: string;
  categories: string[];
  location: [number, number];
  importance: number;
  dwellMin: number;
  walkable: boolean;
  coordinates: { status: string; method: string | null; verifiedAt: string | null; mapVerifiedAt: string | null; previousLocation: [number, number] | null };
  storyStatus: string | null;
  fieldNotes: string[];
  media: { slug: string; kind: string; path: string; poster: string | null; alt: string | null; author: string | null; license: string }[];
  /** Luogo principale di cui fa parte (null se è principale) e sottoluoghi (migrazione 20261101000000). */
  parent?: string | null;
  children?: string[];
  /** Informazioni pratiche (migrazione 20261104000000). */
  practical?: PracticalItem[];
  canEdit: boolean;
}

interface PlaceRow {
  slug: string;
  name: string;
  parent?: string | null;
}

export default async function PlacePage({ params, searchParams }: { params: Promise<{ pack: string; slug: string }>; searchParams: SearchParams }) {
  const { pack, slug } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data: place, error }, { data: all }, { data: sources }] = await Promise.all([
    rpc<PlaceDetail>(session.supabase, "studio_place", { p_pack: pack, p_slug: slug }),
    rpc<PlaceRow[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<{ slug: string; title: string }[]>(session.supabase, "studio_sources", { p_pack: pack }),
  ]);
  const base = `/studio/${encodeURIComponent(pack)}`;
  if (!place) {
    return (
      <main className="st-page">
        <StudioHeader session={session} crumbs={[{ href: `${base}/luoghi`, label: pack }, { label: slug }]} />
        <Notice errore={error ? friendlyError(error) : "Luogo non trovato o non visibile con il tuo ruolo."} />
      </main>
    );
  }
  const urls = await signedMediaUrls(session.supabase, place.media.map((m) => (m.kind === "video" ? (m.poster ?? "") : m.path)));
  const ro = !place.canEdit;
  const [lng, lat] = place.location;
  // Possibili luoghi principali: gli altri luoghi che non sono a loro volta sottoluoghi (un solo livello).
  const principals = (all ?? []).filter((p) => p.slug !== slug && !p.parent);
  const nameOf = new Map((all ?? []).map((p) => [p.slug, p.name]));
  const children = place.children ?? [];
  const today = territoryToday(STUDIO_TIME_ZONE);
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ href: `${base}/luoghi`, label: pack }, { label: place.labels.it?.name ?? slug }]} />
      <PackTabs pack={pack} current="luoghi" />
      <h1>{place.labels.it?.name ?? slug}</h1>
      <p className="st-meta">
        {slug} · {place.placeKind} · <span className={`st-status st-coord-${place.coordinates.status}`}>{COORDINATE_LABELS[place.coordinates.status]}</span>
        {place.storyStatus ? ` · ${place.storyStatus}` : ""}
        {place.parent ? ` · sottoluogo di ${nameOf.get(place.parent) ?? place.parent}` : ""}
      </p>
      <Notice ok={one(q.ok)} errore={one(q.errore)} />
      {ro && <p className="st-hint">Sola lettura: il tuo ruolo non modifica i luoghi di questo territorio.</p>}
      {!ro && (
        <p><Link className="st-delete-link" href={deleteHref(pack, "place", slug)}>Elimina questo luogo…</Link></p>
      )}

      <form action={updatePlace} className="st-form st-grid">
        <input type="hidden" name="pack" value={pack} />
        <input type="hidden" name="slug" value={slug} />
        <fieldset disabled={ro}>
          <legend>Nome e descrizione</legend>
          {(["it", "en"] as const).map((l) => (
            <div key={l} className="st-row">
              <label>
                Nome ({l})
                <input name={`name_${l}`} defaultValue={place.labels[l]?.name ?? ""} required={l === "it"} maxLength={120} />
              </label>
              <label>
                Descrizione breve ({l})
                <input name={`short_${l}`} defaultValue={place.labels[l]?.short ?? ""} maxLength={240} />
              </label>
            </div>
          ))}
        </fieldset>
        <fieldset disabled={ro}>
          <legend>Visita</legend>
          <div className="st-row">
            <label>
              Importanza (1–5)
              <input name="importance" type="number" min={1} max={5} defaultValue={place.importance} required />
            </label>
            <label>
              Sosta (minuti)
              <input name="dwellMin" type="number" min={1} max={240} defaultValue={place.dwellMin} required />
            </label>
          </div>
          <label>
            Categorie (separate da virgole)
            <input name="categories" defaultValue={place.categories.join(", ")} required />
          </label>
          <label>
            Note di campo (una per riga)
            <textarea name="fieldNotes" rows={4} defaultValue={place.fieldNotes.join("\n")} />
          </label>
        </fieldset>
        <fieldset disabled={ro}>
          <legend>Coordinate</legend>
          <p className="st-hint">
            Le coordinate non si correggono a memoria. Se le cambi, indica come le hai ottenute: tornano «preliminari» finché non
            vengono verificate sul posto.
            {place.coordinates.method ? ` Metodo attuale: ${place.coordinates.method}.` : ""}
          </p>
          <input type="hidden" name="lng_before" value={String(lng)} />
          <input type="hidden" name="lat_before" value={String(lat)} />
          <div className="st-row">
            <label>
              Longitudine
              <input name="lng" inputMode="decimal" defaultValue={String(lng)} />
            </label>
            <label>
              Latitudine
              <input name="lat" inputMode="decimal" defaultValue={String(lat)} />
            </label>
          </div>
          <label>
            Come sono state ottenute (obbligatorio se cambiano)
            <input name="coordinateMethod" placeholder="es. rilievo GPS sul posto, precisione 4 m" maxLength={300} />
          </label>
          <a className="st-link" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=19/${lat}/${lng}`} target="_blank" rel="noreferrer">
            Apri la posizione su OpenStreetMap
          </a>
        </fieldset>
        {!ro && (
          <div className="st-actions">
            <button className="st-btn st-primary" type="submit">Salva il luogo</button>
          </div>
        )}
      </form>

      <form action={setPlaceParent} className="st-form">
        <input type="hidden" name="pack" value={pack} />
        <input type="hidden" name="slug" value={slug} />
        <fieldset disabled={ro || children.length > 0}>
          <legend>Luogo principale o sottoluogo</legend>
          {children.length > 0 ? (
            <p className="st-hint">
              È un luogo principale con {children.length === 1 ? "un sottoluogo" : `${children.length} sottoluoghi`}:{" "}
              {children.map((c) => nameOf.get(c) ?? c).join(", ")}. Chi lo acquista li sblocca tutti. Un luogo con sottoluoghi non
              può diventare a sua volta un sottoluogo.
            </p>
          ) : (
            <p className="st-hint">
              Un sottoluogo fa parte di un luogo principale (per esempio una grotta di un&apos;isola): non si vende da solo, si sblocca
              acquistando il luogo principale. Del luogo principale resta gratuita la panoramica.
            </p>
          )}
          {children.length === 0 && (
            <>
              <label className="st-inline">
                <input type="checkbox" name="isSub" value="1" defaultChecked={Boolean(place.parent)} /> È un sottoluogo di
              </label>
              <label>
                Luogo principale
                <select name="parent" defaultValue={place.parent ?? ""} aria-label="Luogo principale">
                  <option value="">—</option>
                  {principals.map((p) => (
                    <option key={p.slug} value={p.slug}>{p.name}</option>
                  ))}
                </select>
              </label>
            </>
          )}
        </fieldset>
        {!ro && children.length === 0 && (
          <div className="st-actions">
            <button className="st-btn" type="submit">Salva luogo principale / sottoluogo</button>
          </div>
        )}
      </form>

      <section>
        <h2>Informazioni pratiche</h2>
        <p className="st-hint">
          Orari, accesso, biglietti, trasporti, permessi e note di sicurezza, con la data in cui le hai controllate. Gaia le usa per
          rispondere sullo stato di oggi («è aperto?») solo finché sono valide; dopo la scadenza dice che vanno ricontrollate e
          rimanda alla fonte. Indica sempre la fonte ufficiale (sito dell&apos;ente): è il collegamento che il visitatore vede.
          Valgono nell&apos;app dalla prossima «Ripubblica».
        </p>
        {(place.practical ?? []).length === 0 && <p className="st-hint">Nessuna informazione pratica.</p>}
        {(place.practical ?? []).map((item) => (
          <PracticalForm key={item.id} pack={pack} slug={slug} item={item} sources={sources ?? []} disabled={ro} today={today} />
        ))}
        {!ro && (place.practical ?? []).length < PRACTICAL_LIMITS.maxItems && (
          <PracticalForm pack={pack} slug={slug} sources={sources ?? []} disabled={false} today={today} />
        )}
      </section>

      <section>
        <h2>Foto del luogo</h2>
        {place.media.length === 0 && <p className="st-hint">Nessuna foto. Aggiungila dalla sezione <Link href={`${base}/media`}>Foto</Link>.</p>}
        <ul className="st-thumbs">
          {place.media.map((m) => {
            const src = urls.get(m.kind === "video" ? (m.poster ?? "") : m.path);
            return (
              <li key={m.slug}>
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element -- indirizzo temporaneo del bucket privato
                  <img src={src} alt={m.alt ?? ""} loading="lazy" />
                ) : (
                  <span className="st-nofile">file non ancora nel bucket</span>
                )}
                <span className="st-meta">
                  {m.slug}
                  {m.kind === "video" ? " · video" : ""} · {m.author ?? "—"} · {m.license}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

/** Una voce delle informazioni pratiche (modifica e rimozione), o il modulo per aggiungerne una (senza item). */
function PracticalForm(props: { pack: string; slug: string; item?: PracticalItem; sources: { slug: string; title: string }[]; disabled: boolean; today: string }) {
  const { pack, slug, item, sources, disabled, today } = props;
  const expired = item ? isExpired(item, today) : false;
  return (
    <div className="st-form">
      <form action={savePractical}>
        <input type="hidden" name="pack" value={pack} />
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="op" value={item ? "update" : "add"} />
        {item && <input type="hidden" name="id" value={item.id} />}
        <fieldset disabled={disabled}>
          <legend>
            {item ? `${PRACTICAL_KIND_LABELS[item.kind]} · ` : "Aggiungi un'informazione pratica"}
            {item && (
              <span className={expired ? "st-status st-coord-preliminary" : "st-status"}>
                {expired ? `scaduta il ${validUntil(item)}: da ricontrollare` : `valida fino al ${validUntil(item)}`}
              </span>
            )}
          </legend>
          <div className="st-row">
            <label>
              Tipo
              <select name="kind" defaultValue={item?.kind ?? "opening_hours"} disabled={Boolean(item)}>
                {Object.entries(PRACTICAL_KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              {item && <input type="hidden" name="kind" value={item.kind} />}
            </label>
            <label>
              Fonte (consigliata)
              <select name="source" defaultValue={item?.source ?? ""}>
                <option value="">—</option>
                {sources.map((s) => (
                  <option key={s.slug} value={s.slug}>{s.title}</option>
                ))}
              </select>
            </label>
          </div>
          {(["it", "en"] as const).map((l) => (
            <label key={l}>
              Testo ({l}){l === "it" ? "" : " — facoltativo"}
              <textarea name={`text_${l}`} rows={2} maxLength={PRACTICAL_LIMITS.textChars} defaultValue={item?.text[l] ?? ""} required={l === "it"} />
            </label>
          ))}
          <div className="st-row">
            <label>
              Controllata il
              <input name="checkedAt" type="date" max={today} defaultValue={item?.checkedAt ?? today} required />
            </label>
            <label>
              Da ricontrollare dopo (giorni)
              <input name="recheckAfterDays" type="number" min={PRACTICAL_LIMITS.minDays} max={PRACTICAL_LIMITS.maxDays} defaultValue={item?.recheckAfterDays ?? PRACTICAL_LIMITS.defaultDays} required />
            </label>
          </div>
        </fieldset>
        {!disabled && (
          <div className="st-actions">
            <button className="st-btn st-primary" type="submit">{item ? "Salva" : "Aggiungi"}</button>
          </div>
        )}
      </form>
      {item && !disabled && (
        <form action={savePractical} className="st-actions">
          <input type="hidden" name="pack" value={pack} />
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="op" value="delete" />
          <input type="hidden" name="id" value={item.id} />
          <button className="st-btn" type="submit">Togli</button>
        </form>
      )}
    </div>
  );
}
