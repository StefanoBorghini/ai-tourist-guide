/**
 * Preparazione delle foto nel browser prima del caricamento (foto dei luoghi e delle attività): riduzione, impronta e
 * nomi leggibili di licenze e provenienze. Solo codice per il browser (canvas, crypto.subtle).
 */

export const LICENSE_LABELS: Record<string, string> = {
  own: "Nostra (diritti propri)",
  "public-domain": "Pubblico dominio",
  cc0: "CC0",
  "cc-by-4.0": "CC BY 4.0",
  "cc-by-sa-4.0": "CC BY-SA 4.0",
  "cc-by-nc-4.0": "CC BY-NC 4.0 (non commerciale)",
  "cc-by-nc-sa-4.0": "CC BY-NC-SA 4.0 (non commerciale)",
  licensed: "Concessa per iscritto",
  "all-rights-reserved": "Tutti i diritti riservati (non pubblicabile)",
};
export const SOURCE_LABELS: Record<string, string> = {
  own_photo: "Foto nostra",
  institution: "Ente o istituzione",
  archive: "Archivio",
  web: "Web (con indirizzo originale)",
  other: "Altro",
};

/** Lato lungo massimo delle foto pubblicate: basta per lo schermo di un telefono e pesa poco offline. */
const MAX_SIDE = 2048;
const REDUCE_ABOVE_BYTES = 1.5 * 1024 * 1024;

/**
 * Riduce una foto troppo grande prima del caricamento (lato lungo 2048 px, JPEG o WebP di buona qualità).
 * Toglie anche i metadati EXIF (posizione GPS compresa), che non servono all'app. Se il browser non ce la fa,
 * resta l'originale.
 */
export async function reduceImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= REDUCE_ABOVE_BYTES) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/webp"; // PNG → WebP: conserva la trasparenza
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]*$/, "") + (type === "image/jpeg" ? ".jpg" : ".webp");
    return new File([blob], name, { type });
  } catch {
    return file;
  }
}

export async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
