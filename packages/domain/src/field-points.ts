import { z } from "zod";

/**
 * Rilievi sul campo (formato di scambio, versione 2).
 *
 * Li produce la modalità debug dell'app e li legge `guide-pack field`. Non aggiornano mai il pack
 * da soli: sono proposte da rivedere prima di cambiare coordinate e raggi.
 */
export const FIELD_POINTS_FORMAT = "guide-field-points/2";

/** Tipo di rilevazione. */
export const FIELD_POINT_KINDS = [
  "poi_position", // punto in cui il luogo va riconosciuto (es. davanti all'ingresso)
  "geofence_edge", // punto in cui il racconto dovrebbe iniziare (bordo del geofence)
  "note", // osservazione con posizione, senza luogo o con luogo facoltativo
] as const;
export type FieldPointKind = (typeof FIELD_POINT_KINDS)[number];

export const fieldPointSchema = z.strictObject({
  /** Slug del luogo nel pack (es. "san-lorenzo"); null per una nota libera. */
  poi_id: z.string().nullable(),
  /** Riferimento completo del luogo (es. "pack.id:san-lorenzo"). */
  poi_ref: z.string().nullable(),
  kind: z.enum(FIELD_POINT_KINDS),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0),
  /** Raggio del geofence nel pack al momento del rilievo. */
  geofence_radius_pack_m: z.number().nullable(),
  /** Raggio suggerito da chi rileva (facoltativo). */
  geofence_radius_suggested_m: z.number().positive().nullable(),
  /** Distanza tra il punto rilevato e le coordinate del luogo nel pack. */
  distance_from_pack_m: z.number().nullable(),
  /** Stato delle coordinate del luogo nel pack al momento del rilievo. */
  pack_coordinate_status: z.string().nullable(),
  /** Momento della registrazione. */
  recorded_at: z.iso.datetime(),
  /** Momento della posizione usata (ultimo dato del GPS): se lontano da recorded_at, la posizione era vecchia. */
  position_at: z.iso.datetime(),
  device: z.string().nullable(),
  /** "gps": posizione reale del dispositivo; "simulated": camminata simulata (non usare per le coordinate). */
  position_source: z.enum(["gps", "simulated"]),
  note: z.string().nullable(),
});
export type FieldPointRecord = z.infer<typeof fieldPointSchema>;

export const fieldPointsExportSchema = z.strictObject({
  format: z.literal(FIELD_POINTS_FORMAT),
  destination: z.string(),
  bundle_hash: z.string().nullable(),
  exported_at: z.iso.datetime(),
  device: z.string().nullable(),
  /** Sempre true: i rilievi vanno rivisti prima di modificare il Territory Pack. */
  review_required: z.literal(true),
  points: z.array(fieldPointSchema),
});
export type FieldPointsExport = z.infer<typeof fieldPointsExportSchema>;
