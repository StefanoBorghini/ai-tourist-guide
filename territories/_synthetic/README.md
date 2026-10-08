# Territori sintetici (di test)

Pack **interamente inventati**, usati dai test e dalla CI per garantire che l'engine
funzioni con qualsiasi territorio e non dipenda da Portovenere.

- Luoghi, persone, eventi, leggende e fonti sono fittizi.
- Le coordinate sono volutamente vicine a 0,0 (in mezzo all'oceano).
- I pack sono marcati `fictional: true`: il validatore impedisce a un pack reale
  di dipendere da questi pack o di citarne le fonti.

| Pack | Tipo | Scopo |
|---|---|---|
| `it.test` | area | temi, persone e organizzazioni condivisi (prova delle dipendenze tra pack) |
| `it.test.borgo-di-prova` | destination | un piccolo borgo con luoghi, geofence, ancora, affermazioni, controversia, leggenda, unità narrative e un percorso |
