/**
 * AI TOURIST GUIDE — Definizioni dei tool della guida AI (v0.1, proposta)
 *
 * Regole di progetto:
 *  - L'AI NON ha web search né accesso a fonti non verificate.
 *    Tutti i fatti arrivano da questi tool, che leggono SOLO claim
 *    con verification_status = 'verified'.
 *  - Ogni fatto restituito porta il suo `claim_id` e il suo `certainty`:
 *    il modello deve citarli nel testo (marker ⟦c:<id>⟧, rimossi prima del TTS)
 *    e il validatore lato server controlla che date/nomi/numeri citati
 *    esistano nei claim forniti.
 *  - La posizione arriva dal client come snapshot "grossolano" (POI corrente,
 *    POI vicini, direzione), non come traccia GPS.
 *  - I tool "client_action" non leggono dati: chiedono all'app di fare qualcosa
 *    (riprodurre un audio, mostrare la mappa). L'app li esegue e risponde con l'esito.
 *
 * Il fact sheet del POI corrente è già nel contesto (prefisso in cache),
 * quindi la maggior parte delle domande ("quanti anni ha?") NON richiede tool:
 * i tool servono per uscire dal POI corrente, pianificare, citare fonti.
 */

import type Anthropic from "@anthropic-ai/sdk";

type ToolGroup = "context" | "knowledge" | "tour" | "client_action" | "memory" | "partner";

export interface GuideTool {
  group: ToolGroup;
  /** Eseguito sul server (lettura KB) o sul client (azione nell'app). */
  executes: "server" | "client";
  /** Disponibile anche offline (eseguito dal runtime locale sul content pack). */
  offlineCapable: boolean;
  definition: Anthropic.Tool;
}

const LOCALE = { type: "string", description: "Codice lingua BCP-47, es. 'it', 'en'." } as const;

export const guideTools: GuideTool[] = [
  // ---------------------------------------------------------------
  // CONTEXT — dove si trova il visitatore, cosa ha intorno
  // ---------------------------------------------------------------
  {
    group: "context",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "get_user_context",
      description:
        "Restituisce lo snapshot corrente del visitatore: POI in cui si trova (se dentro un geofence), " +
        "POI vicini con distanza e direzione relativa (davanti/dietro/sinistra/destra/sopra), " +
        "direzione dello sguardo se disponibile, stato del tour e della narrazione. " +
        "Usalo quando la domanda dipende da dove si trova o da cosa sta guardando.",
      strict: true,
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    group: "context",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_nearby_pois",
      description:
        "Elenca i POI pubblicati entro un raggio dal visitatore, ordinati per distanza, con categoria e importanza.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          radius_m: { type: "integer", description: "Raggio in metri (50-2000)." },
          category: { type: ["string", "null"], description: "Filtro categoria, es. 'church', 'castle'. null = tutte." },
          limit: { type: "integer", description: "Massimo risultati (1-20)." },
          locale: LOCALE,
        },
        required: ["radius_m", "category", "limit", "locale"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "context",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "identify_visible_poi",
      description:
        "Identifica il POI che il visitatore sta probabilmente guardando, usando i geofence 'viewpoint', " +
        "la direzione dello sguardo e la descrizione data dal visitatore (es. 'quel castello sopra di noi'). " +
        "Restituisce candidati con un punteggio di confidenza. Se la confidenza è bassa, chiedi conferma.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Cosa descrive il visitatore, con le sue parole." },
          bearing_deg: { type: ["number", "null"], description: "Direzione dello sguardo 0-359, se nota." },
          locale: LOCALE,
        },
        required: ["description", "bearing_deg", "locale"],
        additionalProperties: false,
      },
    },
  },

  // ---------------------------------------------------------------
  // KNOWLEDGE — solo fatti verificati
  // ---------------------------------------------------------------
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_poi_facts",
      description:
        "Restituisce il fact sheet verificato di un POI: claim atomici con claim_id, topic, certainty " +
        "(established/probable/debated/traditional/legendary), date strutturate. " +
        "Usalo per un POI diverso da quello corrente (il cui fact sheet è già nel contesto).",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          poi_id: { type: "string" },
          topics: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "identity", "dating", "construction", "architecture", "art", "history", "person",
                "etymology", "legend", "tradition", "nature", "geology", "literature", "curiosity",
                "restoration", "function", "context",
              ],
            },
            description: "Topic richiesti. Array vuoto = tutti.",
          },
          locale: LOCALE,
        },
        required: ["poi_id", "topics", "locale"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: false,
    definition: {
      name: "search_knowledge",
      description:
        "Ricerca semantica nella base di conoscenza verificata del territorio (claim ed entità). " +
        "Usala per domande che non riguardano il POI corrente, es. 'È vero che qui veniva Byron?'. " +
        "Se non trova claim pertinenti, NON rispondere con conoscenza propria: di' che non hai " +
        "informazioni verificate e chiama log_knowledge_gap.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          scope: { type: "string", enum: ["current_poi", "nearby", "territory"] },
          entity_kinds: {
            type: "array",
            items: {
              type: "string",
              enum: ["person", "event", "legend", "artwork", "architectural_feature", "tradition", "natural_feature", "period", "literary_work"],
            },
          },
          locale: LOCALE,
        },
        required: ["query", "scope", "entity_kinds", "locale"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_entity",
      description:
        "Dettaglio di un'entità (personaggio storico, evento, leggenda, opera, elemento architettonico, " +
        "tradizione) con i suoi claim verificati e i POI collegati.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { entity_id: { type: "string" }, locale: LOCALE },
        required: ["entity_id", "locale"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_timeline",
      description:
        "Cronologia verificata di un POI o di un territorio (claim con date), utile per 'raccontami la storia " +
        "dall'inizio' o per collocare un evento nel tempo.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          subject_type: { type: "string", enum: ["poi", "territory"] },
          subject_id: { type: "string" },
          from_year: { type: ["integer", "null"] },
          to_year: { type: ["integer", "null"] },
          locale: LOCALE,
        },
        required: ["subject_type", "subject_id", "from_year", "to_year", "locale"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_stories",
      description:
        "Storie editoriali approvate (con audio pre-registrato) per un POI, filtrate per tipo, pubblico e durata. " +
        "Preferisci SEMPRE una storia approvata esistente a una narrazione generata, se corrisponde alla richiesta.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          poi_id: { type: "string" },
          story_type: {
            type: ["string", "null"],
            enum: ["arrival_hook", "introduction", "history", "architecture", "art", "legend", "curiosity", "people", "nature", "closing", null],
          },
          audience: { type: "string", enum: ["general", "family", "kids", "expert"] },
          max_seconds: { type: "integer" },
          locale: LOCALE,
        },
        required: ["poi_id", "story_type", "audience", "max_seconds", "locale"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_sources",
      description:
        "Fonti bibliografiche/istituzionali a supporto di uno o più claim. Usalo quando il visitatore chiede " +
        "'come fai a saperlo?' o 'dove posso approfondire?'.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { claim_ids: { type: "array", items: { type: "string" } } },
        required: ["claim_ids"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "knowledge",
    executes: "server",
    offlineCapable: true,
    definition: {
      name: "get_practical_info",
      description:
        "Informazioni operative di un POI (orari, accessibilità, scale, biglietti). Non storiche: " +
        "possono cambiare, quindi indica sempre che vanno verificate sul posto.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { poi_id: { type: "string" }, locale: LOCALE },
        required: ["poi_id", "locale"],
        additionalProperties: false,
      },
    },
  },

  // ---------------------------------------------------------------
  // TOUR — percorsi curati e dinamici
  // ---------------------------------------------------------------
  {
    group: "tour",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "get_tour_state",
      description: "Stato del tour: itinerario, tappe visitate/saltate, prossima tappa, tempo residuo stimato.",
      strict: true,
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    group: "tour",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "plan_tour",
      description:
        "Pianifica (o ripianifica) un tour dinamico dalla posizione attuale entro un tempo dato, " +
        "massimizzando importanza e interessi. Eseguito dal route engine locale (funziona offline). " +
        "Usalo per 'Ho solo 30 minuti' o 'Mi restano 20 minuti, cosa vedo ancora?'.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          time_budget_min: { type: "integer" },
          interests: {
            type: "array",
            items: { type: "string", enum: ["history", "architecture", "art", "nature", "food", "legends", "people", "literature"] },
          },
          avoid_stairs: { type: "boolean" },
          end_poi_id: { type: ["string", "null"], description: "Punto di arrivo desiderato (es. imbarco traghetto)." },
        },
        required: ["time_budget_min", "interests", "avoid_stairs", "end_poi_id"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "tour",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "update_tour",
      description: "Modifica il tour in corso: salta, aggiungi o anticipa una tappa, oppure termina il tour.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["skip_stop", "add_stop", "move_stop_next", "end_tour"] },
          poi_id: { type: ["string", "null"] },
        },
        required: ["action", "poi_id"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "tour",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "get_directions",
      description:
        "Indicazioni pedonali sintetiche verso un POI (tempo, dislivello, scale, riferimenti visivi). " +
        "Non è navigazione turn-by-turn.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { poi_id: { type: "string" }, locale: LOCALE },
        required: ["poi_id", "locale"],
        additionalProperties: false,
      },
    },
  },

  // ---------------------------------------------------------------
  // CLIENT ACTIONS — l'app esegue
  // ---------------------------------------------------------------
  {
    group: "client_action",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "play_story",
      description: "Chiede all'app di riprodurre una storia approvata (audio pre-registrato) invece di generarne una.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { story_variant_id: { type: "string" } },
        required: ["story_variant_id"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "client_action",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "resume_narration",
      description:
        "Riprende la narrazione interrotta dal segmento salvato, usando la frase-ponte del segmento. " +
        "Se la tua risposta ha già coperto il segmento successivo, imposta skip_covered=true.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { skip_covered: { type: "boolean" } },
        required: ["skip_covered"],
        additionalProperties: false,
      },
    },
  },
  {
    group: "client_action",
    executes: "client",
    offlineCapable: true,
    definition: {
      name: "show_on_map",
      description: "Mostra uno o più POI sulla mappa (solo se il visitatore guarda lo schermo o lo chiede).",
      strict: true,
      input_schema: {
        type: "object",
        properties: { poi_ids: { type: "array", items: { type: "string" } } },
        required: ["poi_ids"],
        additionalProperties: false,
      },
    },
  },

  // ---------------------------------------------------------------
  // MEMORY / FEEDBACK
  // ---------------------------------------------------------------
  {
    group: "memory",
    executes: "server",
    offlineCapable: true, // in coda nell'outbox, inviato al ritorno della rete
    definition: {
      name: "log_knowledge_gap",
      description:
        "Registra una domanda a cui la base di conoscenza verificata non sa rispondere, per la redazione. " +
        "Rimuovi qualsiasi dato personale dalla domanda.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string" },
          poi_id: { type: ["string", "null"] },
          locale: LOCALE,
        },
        required: ["question", "poi_id", "locale"],
        additionalProperties: false,
      },
    },
  },

  // ---------------------------------------------------------------
  // PARTNER (feature flag, policy-gated) — es. Ductavia
  // ---------------------------------------------------------------
  {
    group: "partner",
    executes: "server",
    offlineCapable: false,
    definition: {
      name: "get_related_experiences",
      description:
        "Esperienze locali collegate a un tema già raccontato (es. vino, tradizioni marinare). " +
        "Usalo SOLO se il visitatore chiede esplicitamente come approfondire con un'esperienza, " +
        "oppure a narrazione conclusa e solo se il tool lo consente (il server applica consenso, " +
        "limiti di frequenza e pertinenza: può restituire una lista vuota). Mai durante una narrazione.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          topic: { type: "string" },
          trigger: { type: "string", enum: ["user_asked", "narration_closed"] },
          locale: LOCALE,
        },
        required: ["topic", "trigger", "locale"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Tool inviati al modello (che è sempre online). `offlineCapable` indica invece
 * che la stessa funzione è disponibile al runtime locale dell'app senza rete
 * (UI, comandi vocali base, FAQ offline).
 *
 * Ordine stabile e solo due varianti possibili (con/senza partner) per
 * mantenere alto il cache hit del prefisso del prompt.
 */
export function toolsForRequest(opts: { partnerSuggestionsEnabled: boolean }): Anthropic.Tool[] {
  return guideTools
    .filter((t) => t.group !== "partner" || opts.partnerSuggestionsEnabled)
    .map((t) => t.definition);
}
