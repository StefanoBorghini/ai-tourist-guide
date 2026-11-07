# Condivisione su Instagram

Decisione del 2026-11-07: nella scheda di ogni luogo e sottoluogo la guida invita a raccontarlo su Instagram, taggando
l'account della destinazione (per Portovenere `@portovenere_com`, hashtag `#Portovenere`).

## Cosa permette Instagram (e cosa no)

- Da un sito o da una PWA **non c'è un modo documentato per precompilare** un post, un Reel o una Storia con testo o tag.
- La Storia «pronta» (sfondo e adesivo) funziona solo da un'**app nativa** che passa un ID app Facebook
  (documentazione Meta «Sharing to Stories», obbligatorio da gennaio 2023): possibile in futuro con Capacitor.
- L'API di pubblicazione di Instagram pubblica solo sul **proprio** account Business: non per conto dei visitatori.
- Il menu «Condividi» del telefono (Web Share API con file) passa una foto a Instagram, che propone Post, Reel o
  Storia; il testo passato insieme viene ignorato (e su iOS testo + file possono far perdere il file).
- Non si usano collegamenti non ufficiali (`instagram://…`): possono smettere di funzionare senza preavviso.

## Come funziona nella guida

Riga discreta in fondo alla scheda del luogo («Racconta *luogo* su Instagram · Entra nella community di @account»),
che apre un foglio dal basso:

1. **Testo pronto** (`📍 Luogo · Destinazione` e `@account #hashtag`) con «Copia il testo».
2. **Telefono**: «Scegli una foto o un video» (il testo si copia in quel momento), poi «Condividi su Instagram» apre il
   menu del sistema; nel menu si sceglie Instagram e poi Post, Reel o Storia, e si incolla il testo.
3. **«Apri Instagram»**: il profilo dell'account (sul telefono si apre nell'app); copia anche il testo.
4. **«Copia il link del luogo»**: indirizzo della guida con `?d=<destinazione>&p=<luogo>`, utile per l'adesivo «Link»
   delle Storie. Il link apre la destinazione con la scheda di quel luogo.
5. **Computer** (niente menu «Condividi» con file): restano copia e «Apri Instagram», con l'indicazione di incollare.

La foto non passa dai nostri server: va dal dispositivo all'app scelta dal visitatore. Nessun dato di Instagram entra
nel database, nessun token, nessuna raccolta automatica di post.

## Configurazione

- Formato del pack: `config.social.instagram = { handle, hashtags }` (solo destinazioni; account senza `@`, fino a 5
  hashtag senza `#`), in `packages/domain/src/pack-schema.ts`; il validatore rifiuta `social` fuori dalle destinazioni.
- Studio: pagina Panoramica della destinazione, riquadro «Condivisione su Instagram» (lo cambia chi pubblica:
  `studio_social` / `studio_set_social`, migrazione `20261110000000_social_sharing.sql`, nessuna tabella nuova). Account
  vuoto = nessun invito. Nell'app cambia alla prossima pubblicazione.
- Bundle: `content.social` solo se configurato (le destinazioni senza hanno bundle identici a prima).
- App: `lib/share-instagram.ts` (logica pura, testata), `components/ShareSheet.tsx`, riga in `components/PlaceCard.tsx`,
  `?p=` in `lib/nav-history.ts` e `components/GuideApp.tsx`.

## Contest «La foto del mese» (non implementato)

Proposta in attesa del parere legale (concorsi a premio, DPR 430/2001; regole di Instagram per le promozioni;
liberatoria per l'uso delle foto; GDPR): hashtag dedicato, solo Post e Reel pubblici, raccolta manuale della redazione,
selezione editoriale. Nessuna raccolta automatica dei contenuti senza verifica dei permessi.
