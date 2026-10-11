import { requireStaff, rpc } from "../../../../lib/studio/server";
import { friendlyError, STATUS_LABELS } from "../../../../lib/studio/shared";
import { createUnit } from "../../actions";
import { Notice, one, PackTabs, StudioHeader, type SearchParams } from "../../ui";

interface UnitRow {
  slug: string;
  anchor: string;
  unitType: string;
  locale: string;
  durationS: number;
  text: string;
  assertions: { slug: string; status: string }[];
}

const TYPES: Record<string, string> = {
  opening: "Apertura (all'arrivo)",
  context: "Contesto",
  detail: "Dettaglio",
  curiosity: "Curiosità",
  legend: "Leggenda",
  closing: "Chiusura",
  transition: "Passaggio",
};

export default async function UnitsPage({ params, searchParams }: { params: Promise<{ pack: string }>; searchParams: SearchParams }) {
  const { pack } = await params;
  const q = await searchParams;
  const session = await requireStaff();
  const [{ data, error }, k, places, assertions] = await Promise.all([
    rpc<UnitRow[]>(session.supabase, "studio_units", { p_pack: pack }),
    rpc<{ canEdit: boolean; locales: string[]; defaultLocale: string; releaseStage: string }>(session.supabase, "studio_pack", { p_pack: pack }),
    rpc<{ slug: string; name: string }[]>(session.supabase, "studio_places", { p_pack: pack }),
    rpc<{ slug: string; text: string | null; status: string; subject: string }[]>(session.supabase, "studio_assertions", { p_pack: pack }),
  ]);
  const units = data ?? [];
  const usable = (assertions.data ?? []).filter((a) => a.status === "verified" || a.status === "in_review" || a.status === "draft");
  return (
    <main className="st-page">
      <StudioHeader session={session} crumbs={[{ label: pack }]} />
      <PackTabs pack={pack} current="racconti" />
      <h1>Racconti</h1>
      <p className="st-hint">
        Un racconto è il testo che la guida legge in un luogo. Si appoggia su affermazioni: la guida lo usa solo se tutte sono
        verificate{k.data?.releaseStage !== "production" ? " (in anteprima anche se in revisione, dichiarato all'utente)" : ""}; mai su bozze.
      </p>
      <Notice ok={one(q.ok)} errore={one(q.errore) ?? (error ? friendlyError(error) : undefined)} />
      {k.data?.canEdit && (
        <details className="st-create" open={units.length === 0}>
          <summary>Scrivi un racconto</summary>
          {(places.data ?? []).length === 0 || usable.length === 0 ? (
            <p className="st-hint">Servono prima almeno un luogo e un'affermazione (con la sua fonte).</p>
          ) : (
            <form action={createUnit} className="st-form">
              <input type="hidden" name="pack" value={pack} />
              <div className="st-row">
                <label>
                  Luogo
                  <select name="anchor" required>
                    {(places.data ?? []).map((p) => (
                      <option key={p.slug} value={p.slug}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tipo
                  <select name="unitType" defaultValue="opening">
                    {Object.entries(TYPES).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Lingua
                  <select name="locale" defaultValue={k.data.defaultLocale}>
                    {k.data.locales.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Durata (secondi)
                  <input name="durationS" type="number" min={5} max={120} defaultValue={30} />
                </label>
              </div>
              <label>
                Testo
                <textarea name="text" rows={4} required maxLength={2000} placeholder="Scrivi solo ciò che le affermazioni collegate sostengono." />
              </label>
              <label>
                Affermazioni su cui si basa
                <select name="assertions" multiple required size={Math.min(6, Math.max(3, usable.length))}>
                  {usable.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      [{STATUS_LABELS[a.status]}] {a.subject}: {(a.text ?? a.slug).slice(0, 90)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="st-actions">
                <button className="st-btn st-primary" type="submit">Crea il racconto</button>
              </div>
            </form>
          )}
        </details>
      )}
      {units.length === 0 && !error && <p>Nessun racconto.</p>}
      <ul className="st-assertions">
        {units.map((u) => {
          const blocked = u.assertions.some((a) => a.status !== "verified" && !(a.status === "in_review" && k.data?.releaseStage !== "production"));
          return (
            <li key={u.slug} className="st-assertion">
              <div className="st-assertion-head">
                <span className={`st-status ${blocked ? "st-draft" : "st-verified"}`}>{blocked ? "non ancora raccontabile" : "raccontabile"}</span>
                <span className="st-meta">
                  {u.anchor} · {TYPES[u.unitType] ?? u.unitType} · {u.locale} · {u.durationS} s
                </span>
              </div>
              <p className="st-assertion-text">{u.text}</p>
              <p className="st-meta">
                Affermazioni: {u.assertions.map((a) => `${a.slug} (${STATUS_LABELS[a.status]?.toLowerCase() ?? a.status})`).join(", ")}
              </p>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
