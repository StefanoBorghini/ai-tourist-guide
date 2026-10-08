/**
 * Legge posizione GPS e data di scatto dai metadati EXIF di una foto JPEG.
 *
 * Le foto scattate sul posto con la localizzazione attiva diventano così la fonte
 * delle coordinate dei luoghi: misurate, non stimate da una mappa.
 * Formati: JPEG (la maggior parte dei telefoni Android e le foto "più compatibili" di iPhone).
 * HEIC non è supportato: va esportato in JPEG.
 */

export interface PhotoLocation {
  /** [longitudine, latitudine] */
  location: [number, number];
  altitudeM?: number;
  /** Data di scatto (AAAA-MM-GG), se presente. */
  takenAt?: string;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LON_REF = 3;
const GPS_LON = 4;
const GPS_ALT_REF = 5;
const GPS_ALT = 6;

class Tiff {
  constructor(
    private readonly view: DataView,
    private readonly base: number,
    private readonly little: boolean,
  ) {}

  u16(off: number) {
    return this.view.getUint16(this.base + off, this.little);
  }
  u32(off: number) {
    return this.view.getUint32(this.base + off, this.little);
  }

  /** Voci di una IFD: tag → { tipo, numero, offset del valore }. */
  ifd(offset: number): Map<number, { type: number; count: number; valueOffset: number }> {
    const entries = new Map<number, { type: number; count: number; valueOffset: number }>();
    const n = this.u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      // Valori fino a 4 byte sono nella voce stessa, gli altri a un offset.
      const valueOffset = size * count <= 4 ? e + 8 : this.u32(e + 8);
      entries.set(this.u16(e), { type, count, valueOffset });
    }
    return entries;
  }

  ascii(offset: number, count: number): string {
    let s = "";
    for (let i = 0; i < count; i++) {
      const c = this.view.getUint8(this.base + offset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  rational(offset: number): number {
    const den = this.u32(offset + 4);
    return den === 0 ? 0 : this.u32(offset) / den;
  }
}

function findExif(view: DataView): number | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // non è un JPEG
  let pos = 2;
  while (pos + 4 <= view.byteLength) {
    if (view.getUint8(pos) !== 0xff) return null;
    const marker = view.getUint8(pos + 1);
    const length = view.getUint16(pos + 2);
    if (marker === 0xe1 && pos + 10 <= view.byteLength) {
      // "Exif\0\0"
      const sig = [0x45, 0x78, 0x69, 0x66, 0, 0].every((b, i) => view.getUint8(pos + 4 + i) === b);
      if (sig) return pos + 10;
    }
    if (marker === 0xda) return null; // inizio dei dati dell'immagine: niente EXIF
    pos += 2 + length;
  }
  return null;
}

export function readPhotoLocation(data: Uint8Array): PhotoLocation | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tiffStart = findExif(view);
  if (tiffStart === null) return null;
  const order = view.getUint16(tiffStart);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const tiff = new Tiff(view, tiffStart, order === 0x4949);
  try {
    const ifd0 = tiff.ifd(tiff.u32(4));

    let takenAt: string | undefined;
    const exifPtr = ifd0.get(TAG_EXIF_IFD);
    if (exifPtr) {
      const dt = tiff.ifd(tiff.u32(exifPtr.valueOffset)).get(TAG_DATETIME_ORIGINAL);
      const raw = dt ? tiff.ascii(dt.valueOffset, dt.count) : "";
      const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(raw);
      if (m) takenAt = `${m[1]}-${m[2]}-${m[3]}`;
    }

    const gpsPtr = ifd0.get(TAG_GPS_IFD);
    if (!gpsPtr) return null;
    const gps = tiff.ifd(tiff.u32(gpsPtr.valueOffset));
    const lat = gps.get(GPS_LAT);
    const lon = gps.get(GPS_LON);
    const latRef = gps.get(GPS_LAT_REF);
    const lonRef = gps.get(GPS_LON_REF);
    if (!lat || !lon || !latRef || !lonRef) return null;
    const dms = (o: number) => tiff.rational(o) + tiff.rational(o + 8) / 60 + tiff.rational(o + 16) / 3600;
    let latitude = dms(lat.valueOffset);
    let longitude = dms(lon.valueOffset);
    if (tiff.ascii(latRef.valueOffset, 2) === "S") latitude = -latitude;
    if (tiff.ascii(lonRef.valueOffset, 2) === "W") longitude = -longitude;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return null;

    const result: PhotoLocation = { location: [round(longitude), round(latitude)] };
    const alt = gps.get(GPS_ALT);
    if (alt) {
      const below = gps.get(GPS_ALT_REF);
      const value = tiff.rational(alt.valueOffset);
      result.altitudeM = Math.round((below && view.getUint8(tiffStart + below.valueOffset) === 1 ? -value : value) * 10) / 10;
    }
    if (takenAt) result.takenAt = takenAt;
    return result;
  } catch {
    return null; // EXIF malformato
  }
}

const round = (n: number) => Math.round(n * 1e7) / 1e7;
