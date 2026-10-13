# Lumi — assistente vocale da scrivania

> Nome provvisorio. Progetto personale, ispirato a [Pixel Pet](https://github.com/DrIce99/pet), da cui riprende struttura e scelte tecniche.

Lumi è un piccolo volto sempre presente sullo schermo: due occhi verticali stilizzati, senza bocca e su sfondo trasparente. Lumi ti ascolta, ti risponde a voce con una voce naturale ed espressiva e **guarda davvero quello che succede sullo schermo**: segue il testo che compare, la riga che stai scrivendo, la notifica appena arrivata o la frase di cui sta parlando.

L'obiettivo è che sembri **il più umano possibile**, cioè con poca latenza, turni di parola naturali, emozioni nella voce e nello sguardo, e la possibilità di essere interrotto. Tutto deve funzionare **gratis**: in locale oppure con i piani gratuiti dei servizi di IA.

---

## Indice

1. [Cosa sa fare](#cosa-sa-fare)
2. [Architettura](#architettura)
3. [Il volto](#il-volto)
4. [Percezione dello schermo e sguardo](#percezione-dello-schermo-e-sguardo)
5. [Pipeline vocale](#pipeline-vocale)
6. [Il cervello: servizi supportati](#il-cervello-servizi-supportati)
7. [Sintesi vocale (TTS)](#sintesi-vocale-tts)
8. [Riconoscimento vocale (STT)](#riconoscimento-vocale-stt)
9. [Profili hardware](#profili-hardware)
10. [Struttura del progetto](#struttura-del-progetto)
11. [Protocollo app ↔ sidecar](#protocollo-app--sidecar)
12. [Impostazioni](#impostazioni)
13. [Privacy](#privacy)
14. [Roadmap](#roadmap)
15. [Avvio e sviluppo](#avvio-e-sviluppo)

---

## Cosa sa fare

- **Sempre in primo piano**: una finestra trasparente, senza bordi e trascinabile. I clic passano attraverso tutto ciò che non sono gli occhi, e la finestra è esclusa dalle catture e dalle condivisioni dello schermo.
- **Occhi vivi**: battito di ciglia naturale (con doppi battiti occasionali), saccadi, micro-movimenti ed espressioni fatte solo con la forma degli occhi.
- **Sguardo che segue lo schermo**: il cursore del testo mentre scrivi, il testo nuovo che appare (che Lumi "legge" riga per riga), le zone che cambiano, il mouse e ciò di cui sta parlando.
- **Conversazione a voce**: push-to-talk, parola di attivazione oppure ascolto continuo. Puoi interromperlo mentre parla e lui si ferma e ti ascolta.
- **Voce espressiva in italiano**: emozioni decise dal modello e applicate sia alla voce sia agli occhi.
- **Vede lo schermo**: legge il testo con l'OCR locale in tempo reale e, quando serve, manda uno screenshot a un modello con visione.
- **Cervello a scelta**: Ollama in locale, Google Gemini, Groq, OpenRouter (modelli `:free`) o qualsiasi API compatibile OpenAI (LM Studio…).
- **Memoria persistente** e **momenti autonomi** (commenti spontanei nelle pause), come in Pixel Pet.
- **Modalità lettura / audiolibri** (fase successiva): lo stesso motore TTS converte testi lunghi in audio.

---

## Architettura

Il progetto ha due processi.

```
┌──────────────────────────── Electron (TypeScript) ────────────────────────────┐
│ main                                                                          │
│  ├─ window.ts       finestra trasparente, always-on-top, click-through        │
│  ├─ perception/     cattura schermo, rilevamento cambiamenti, caret, focus,   │
│  │                  attenzione (decide DOVE guardare)                         │
│  ├─ brain/          provider IA (portati da Pixel Pet), prompt, tool, memoria │
│  ├─ voice/          gestore dei turni: VAD → STT → LLM → TTS, interruzioni    │
│  └─ sidecar.ts      avvia e sorveglia il processo Python                      │
│ renderer                                                                      │
│  ├─ face/           disegno occhi, blink, sguardo, espressioni                │
│  └─ audio/          microfono (AEC), VAD, riproduzione TTS in streaming       │
└───────────────────────────────▲───────────────────────────────────────────────┘
                                │ WebSocket + HTTP su 127.0.0.1
┌───────────────────────────────┴──── Sidecar (Python 3.11+) ───────────────────┐
│  stt/   faster-whisper | Parakeet | (remoto: Groq Whisper)                    │
│  tts/   Qwen3-TTS | Chatterbox Multilingual | Kokoro                          │
│  ocr/   Windows OCR (winocr) | RapidOCR                                       │
│  uia/   UI Automation: elemento con il focus, caret, testo e rettangoli       │
│  text/  normalizzazione italiana (numeri, date, sigle → parole)               │
└───────────────────────────────────────────────────────────────────────────────┘
```

Il sidecar Python esiste perché tutti i modelli di voce e OCR sono in Python. Electron lo avvia all'apertura, controlla `/health` e lo riavvia se cade. Senza sidecar, Lumi funziona in **modalità testo**: gli occhi e lo sguardo restano attivi, ma non parla e non ascolta.

Gli elementi ripresi da Pixel Pet sono `providers/` (con `compat.ts`, `openai.ts` e `ollama.ts`), l'uso di `net.fetch` di Electron per proxy e certificati aziendali, `desktop.ts` (koffi + user32/dwmapi), le chiavi cifrate con DPAPI, `run.mjs` (che evita `ELECTRON_RUN_AS_NODE`) e i test con `node:test`.

---

## Il volto

### Forma

Il volto è composto da due occhi verticali **a capsula** (rettangoli con le estremità superiore e inferiore completamente arrotondate), stile `| |`. Non c'è la bocca.

| Parametro | Valore iniziale |
| --- | --- |
| Finestra | 160 × 120 px (scalabile 0,5×–3×) |
| Occhio | 14 × 44 px, raggio = larghezza / 2 |
| Distanza tra gli occhi | 22 px |
| Colore | bianco caldo `#F5F3EE` con un leggero bagliore |
| Contorno | ombra scura sfumata di 1–2 px, per restare visibile sia su sfondi chiari sia scuri |

Il volto si disegna su `<canvas>` (o SVG) nel renderer, a 60 fps solo mentre qualcosa si muove, poi in pausa. Il **hit test** considera solo i pixel opachi degli occhi, come gli sprite di Pixel Pet. Il resto della finestra lascia passare i clic (`setIgnoreMouseEvents(true, { forward: true })`).

### Battito di ciglia

- Intervallo casuale (log-normale, media circa 4 s, minimo 1,5 s, massimo 9 s).
- Durata circa 150 ms: chiusura in 60 ms, pausa di 20 ms, riapertura in 90 ms. L'occhio si schiaccia in altezza fino al 10% senza cambiare larghezza.
- Doppio battito nel 15% dei casi.
- **Battito sincronizzato con le saccadi ampie** (oltre 25° di spostamento), come succede negli esseri umani.
- Mentre parla sbatte un po' più spesso, soprattutto a fine frase. Quando è assonnato le palpebre si abbassano lentamente.

### Sguardo

- Il bersaglio è in coordinate dello schermo e viene convertito in uno spostamento degli occhi dentro la finestra:
  `offset = maxOffset · tanh(distanza / k) · direzione`, con `maxOffset` di circa 9 px orizzontali e 7 px verticali.
- **Saccadi**: spostamenti rapidi di 30–60 ms con easing. **Fissazioni**: 250–800 ms. **Micro-saccadi**: tremolio di ±0,5 px ogni 0,5–1,5 s durante la fissazione.
- **Inseguimento morbido** solo per bersagli che si muovono con continuità (il mouse che si sposta).
- Leggera **vergenza** (occhi che si avvicinano) quando il bersaglio è molto vicino al volto.
- Quando non ha niente da guardare, vaga piano o guarda verso di te (in basso al centro dello schermo).

### Espressioni (solo con gli occhi)

| Emozione | Forma |
| --- | --- |
| neutra | capsule dritte |
| gioia | occhi più bassi e larghi, leggero rimbalzo verso l'alto |
| tristezza | occhi più bassi, inclinati verso l'esterno, sguardo in basso |
| sorpresa | +20% in altezza, +10% in larghezza, breve pausa del battito |
| rabbia / fastidio | inclinati verso l'interno (skew), più stretti |
| pensiero | sguardo in alto a destra, un occhio leggermente più piccolo |
| ascolto | leggermente più alti, fissi su di te, pochi movimenti |
| sonno | metà altezza, battiti lenti |
| imbarazzo | sguardo che scappa di lato, breve "tremolio" |

**Mentre parla**, al posto della bocca: l'altezza degli occhi pulsa di ±5% seguendo l'ampiezza (RMS) dell'audio in uscita, con un leggero rimbalzo all'inizio di ogni frase. Le transizioni tra espressioni durano 150–300 ms e tutti i parametri si interpolano.

---

## Percezione dello schermo e sguardo

### È possibile leggere lo schermo in tempo reale?

**Sì**, a patto di non affidare tutto a un modello di visione, che è troppo lento per seguire lo sguardo. Si usano **più livelli economici in locale**, sempre attivi, e il modello di visione solo quando serve capire il contenuto.

| Livello | Cosa produce | Frequenza | Costo |
| --- | --- | --- | --- |
| Puntatore e finestra in primo piano (koffi: `GetCursorPos`, `GetForegroundWindow`) | posizione del mouse, finestra attiva | 30–60 Hz | nullo |
| **Caret** (koffi: `GetGUIThreadInfo`; UIA `TextPattern2` per Chrome, VS Code ed Electron, che non usano il caret di sistema) | dove stai scrivendo | 20 Hz / a eventi | nullo |
| **UI Automation** (eventi di focus, testo e rettangoli dell'elemento attivo) | campo con il focus, testo selezionato | a eventi | basso |
| **Rilevamento cambiamenti** (`desktopCapturer` a bassa risoluzione, differenza tra blocchi 32×32) | rettangoli delle zone che sono cambiate | 4–5 fps | basso |
| **OCR locale** solo sulle zone cambiate (Windows OCR, con fallback RapidOCR) | parole e righe con i loro rettangoli | 1–2 fps | medio |
| Modello con visione (`look_at_screen`) | comprensione del contenuto | su richiesta | alto |

La finestra di Lumi ha `setContentProtection(true)`, quindi non compare nelle proprie catture.

### Il modulo di attenzione (`perception/attention.ts`)

Ogni livello produce **candidati** del tipo `{ rect, kind, salience, t }`. Il modulo di attenzione sceglie dove guardare con un punteggio che decade nel tempo e con una certa isteresi, per non saltare di continuo.

Priorità predefinite, dalla più alta alla più bassa:

1. **Ciò di cui Lumi sta parlando**: il modello cita un testo, che viene cercato nei risultati OCR o UIA, e lo sguardo va lì.
2. **Caret mentre scrivi**: lo sguardo segue la riga che stai scrivendo.
3. **Testo nuovo appena comparso** (un messaggio in chat, una notifica, un output nel terminale): Lumi lo **legge**.
4. **Zona che cambia** senza testo (video, animazioni): occhiate brevi.
5. **Mouse in movimento**: inseguimento morbido.
6. **Te**: quando ti ascolta o ti parla, guarda verso il basso al centro, come se guardasse chi sta davanti allo schermo.

### Simulazione della lettura

Quando l'OCR trova un blocco di testo nuovo, lo sguardo lo **percorre come farebbe una persona**:

- fissazioni ogni 7–9 caratteri lungo la riga, di 200–250 ms ciascuna (circa 250 parole al minuto);
- ritorno rapido all'inizio della riga successiva;
- piccole regressioni casuali (10%);
- si ferma dopo circa 6 righe oppure se arriva un bersaglio con priorità più alta.

Il testo letto viene inserito nel **contesto percettivo** del cervello (vedi sotto). In questo modo Lumi può davvero commentare quello che ha appena "letto".

### Contesto percettivo per il cervello

`perception/` mantiene un riassunto continuo con l'app attiva, il titolo della finestra, il testo sotto il focus e le ultime righe nuove lette dall'OCR. Il riassunto entra nel prompt in modo compatto (al massimo circa 1.500 caratteri). Lo screenshot vero e proprio viene inviato solo con il tool `look_at_screen`.

Per far "guardare" qualcosa a Lumi mentre ne parla, il modello usa il tool `look_at({ text })` oppure scrive nel `say` un riferimento `look: "..."`. La stringa viene cercata con una ricerca approssimata nei risultati OCR o UIA, il che costa molto meno che chiedere coordinate al modello di visione. Se non viene trovata, si usa il rettangolo della finestra attiva.

### Note

- **DPI**: `desktopCapturer` lavora in pixel fisici, mentre Electron usa pixel indipendenti dal dispositivo (DIP). Conviene convertire sempre con `screen.dipToScreenRect` / `screenToDipRect` e lavorare per singolo monitor.
- **Più monitor**: si cattura solo il monitor con la finestra attiva, più quello in cui si trova Lumi.
- **Prestazioni**: l'OCR va solo sulle zone cambiate e mai su tutto lo schermo a ogni fotogramma. La percezione si mette in pausa quando lo schermo è bloccato, quando l'utente è assente da più di 5 minuti o in modalità "Non disturbare".

---

## Pipeline vocale

```
microfono ─► AEC del browser ─► VAD (Silero) ─► STT in streaming ─► fine turno?
                                                                       │
          ◄── riproduzione ◄── TTS in streaming ◄── frasi ◄── LLM in streaming
                 │
                 └─► RMS → animazione degli occhi
```

### Perché sembri umano

- **Latenza**: l'obiettivo è meno di 1 s tra la fine della tua frase e l'inizio della risposta. Per arrivarci tutto procede in streaming: l'LLM genera, il testo viene **diviso in frasi** (punteggiatura, oppure una virgola dopo 60 caratteri) e ogni frase passa subito al TTS. La prima frase va sintetizzata il prima possibile.
- **Fine del turno**: il solo silenzio non basta, perché le persone fanno pause a metà frase. Si combinano il VAD (silenzio oltre 500 ms) e un controllo semantico: un modello di turn detection come *Smart Turn* di Pipecat, oppure un'euristica sull'ultima parola ("e", "ma", "quindi" → aspetta). Se il turno è incerto, l'attesa arriva fino a 1,2 s.
- **Interruzioni (barge-in)**: se il VAD rileva la tua voce mentre Lumi parla per più di 300 ms, la riproduzione si ferma con una dissolvenza di 80 ms, lo stream dell'LLM viene annullato e **nella cronologia resta solo la parte effettivamente pronunciata**, segnata come interrotta.
- **Cancellazione dell'eco**: l'audio TTS si riproduce **nel renderer** (WebAudio), nello stesso processo di `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`, così l'AEC di Chromium ha il riferimento. Le cuffie restano comunque l'opzione più affidabile.
- **Segnali di ascolto (backchannel)**: durante le tue frasi lunghe, nelle pause brevi, Lumi a volte fa un "mh", un "sì" o un "ah" a basso volume, da clip pre-generate con la sua voce e senza passare dall'LLM. Gli occhi annuiscono con un piccolo movimento verticale.
- **Riempitivi**: se la prima frase non è pronta entro circa 1,2 s, Lumi dice un "allora…" o un "vediamo…" (da clip in cache) e intanto gli occhi mostrano l'espressione di pensiero.
- **Emozioni**: il modello parla tramite il tool `say({ text, emotion, intensity, look? })`, come in Pixel Pet. L'emozione arriva al TTS (istruzione di stile) e al volto.
- **Stile di risposta**: il prompt chiede frasi brevi e parlate, niente elenchi, niente markdown, niente "Certo! Ecco…", e una domanda per volta.
- **Normalizzazione del testo** prima del TTS: numeri, date, ore, valute, sigle, URL ed emoji vengono convertiti in parole italiane (`num2words` con `lang="it"` e regole proprie).

### Modalità di ascolto

| Modalità | Come |
| --- | --- |
| Push-to-talk (predefinita) | tieni premuto `Ctrl+Alt+Spazio` |
| Parola di attivazione | openWakeWord con una parola personalizzata (es. "Ehi Lumi") |
| Conversazione continua | dopo una risposta resta in ascolto per 8 s senza bisogno della parola di attivazione |
| Testo | clic sugli occhi → riquadro di chat, come in Pixel Pet |

---

## Il cervello: servizi supportati

Si usa lo stesso schema di Pixel Pet: un modello per la **conversazione** e uno (eventualmente più piccolo) per i **momenti autonomi**. "Rileva modelli" e "Prova la connessione" sono nelle impostazioni.

| Servizio | Costo | Note per un assistente vocale |
| --- | --- | --- |
| **Ollama** | gratis, locale | privato. `qwen3` per parlare, `qwen2.5vl` o `mistral-small3.2` per la visione |
| **Groq** | gratis con limiti | **la latenza più bassa**: ottimo per la conversazione. Ha anche Whisper per l'STT |
| **Google Gemini** | gratis con limiti giornalieri | `gemini-flash-lite-latest` / `gemini-flash-latest`, con visione inclusa |
| **OpenRouter** | gratis con i modelli `:free` | molta scelta, latenza variabile |
| Compatibile OpenAI | dipende | LM Studio, llama.cpp server, ecc. |

Per la voce conta il **tempo al primo token**. Un servizio remoto veloce (Groq) con TTS e STT locali dà spesso l'esperienza più "umana" su PC senza una GPU grande.

Tool esposti al modello:

- `say({ text, emotion, intensity, look? })`
- `look_at({ text | region })`
- `look_at_screen()` (screenshot al modello con visione)
- `remember({ fact })`
- `set_reminder({ when, text })`
- `stay_quiet()`

---

## Sintesi vocale (TTS)

Il motore si sceglie nelle impostazioni. Tutti girano nel sidecar con la stessa interfaccia:

```python
class TTSEngine:
    def stream(self, text: str, emotion: str, intensity: float, voice: str) -> Iterator[bytes]: ...
    # PCM 16-bit mono 24 kHz, a blocchi
```

| Motore | Italiano | Emozioni | Clonazione voce | Licenza | Uso consigliato |
| --- | --- | --- | --- | --- | --- |
| **Qwen3-TTS 1.7B** (CustomVoice / VoiceDesign) | sì | sì, con istruzione testuale | sì (modello Base) | Apache 2.0 | **predefinito**: assistente e audiolibri |
| Qwen3-TTS 0.6B | sì | no | sì | Apache 2.0 | PC con poca VRAM |
| **Chatterbox Multilingual** | sì | sì (`exaggeration`) | sì, zero-shot | MIT | voce personalizzata clonata |
| Kokoro | sì | no | no | Apache 2.0 | fallback leggero, anche su CPU |

Le emozioni del modello vengono tradotte per ogni motore:

```json
{
  "gioia":     { "qwen_instruct": "Parla con tono allegro e vivace", "chatterbox_exaggeration": 0.7 },
  "tristezza": { "qwen_instruct": "Parla piano, con tono triste e dolce", "chatterbox_exaggeration": 0.4 },
  "sorpresa":  { "qwen_instruct": "Parla con stupore, tono che sale", "chatterbox_exaggeration": 0.8 },
  "neutra":    { "qwen_instruct": "Parla in modo naturale e colloquiale", "chatterbox_exaggeration": 0.5 }
}
```

L'intensità (da 0 a 1) modula l'istruzione ("leggermente", "molto") o il parametro numerico. La **voce di Lumi deve restare la stessa** tra una frase e l'altra: con Qwen si fissano speaker e seed, con Chatterbox si usa sempre lo stesso campione di riferimento.

Le clip di backchannel e dei riempitivi vengono **pre-generate all'avvio** con la voce scelta e salvate in cache.

---

## Riconoscimento vocale (STT)

| Motore | Dove | Note |
| --- | --- | --- |
| **faster-whisper** `large-v3-turbo` (int8) | locale (GPU, o CPU lenta) | **predefinito**: ottimo italiano |
| Parakeet TDT 0.6B v3 | locale (GPU) | molto veloce, multilingue europeo |
| whisper.cpp | locale (CPU) | per PC senza GPU |
| Groq Whisper | remoto, gratis con limiti | latenza bassissima, l'audio esce dal PC |

Il VAD (Silero) gira **nel renderer** (`@ricky0123/vad-web`, ONNX). Al sidecar arrivano solo i segmenti di voce. I risultati parziali servono al rilevamento della fine del turno e a far "reagire" gli occhi mentre parli.

Vocabolario personalizzato: una lista di parole (nomi, termini tecnici) passata come `initial_prompt` a Whisper.

---

## Profili hardware

Le cifre sono indicative e vanno verificate sul proprio PC.

| Profilo | Cervello | STT | TTS | VRAM |
| --- | --- | --- | --- | --- |
| **Leggero** (nessuna GPU) | Groq / Gemini | Groq Whisper | Kokoro (CPU) | 0 |
| **Bilanciato** (6–8 GB) | Groq / Gemini | faster-whisper turbo | Qwen3-TTS 1.7B | circa 6 GB |
| **Tutto locale** (16 GB o più) | Ollama `qwen3` 8B | faster-whisper turbo | Qwen3-TTS 1.7B | circa 12–14 GB |

Al primo avvio una procedura guidata rileva la GPU (`nvidia-smi`) e propone il profilo.

---

## Struttura del progetto

```
lumi/
├─ app/                        Electron + TypeScript
│  ├─ src/main/
│  │  ├─ main.ts
│  │  ├─ window.ts             finestra trasparente, top-most, hit test, drag
│  │  ├─ tray.ts
│  │  ├─ settings.ts           JSON in %APPDATA%\Lumi + chiavi DPAPI
│  │  ├─ sidecar.ts            spawn, health check, riavvio
│  │  ├─ perception/
│  │  │  ├─ desktop.ts         koffi: finestre, foreground, cursore, caret
│  │  │  ├─ capture.ts         desktopCapturer + diff a blocchi
│  │  │  ├─ attention.ts       candidati → bersaglio dello sguardo (puro, testato)
│  │  │  ├─ reading.ts         simulazione della lettura (puro, testato)
│  │  │  └─ context.ts         riassunto percettivo per il prompt
│  │  ├─ brain/
│  │  │  ├─ brain.ts  prompt.ts  tools.ts  memory.ts
│  │  │  └─ providers/         compat.ts  openai.ts  ollama.ts  (da Pixel Pet)
│  │  └─ voice/
│  │     ├─ turns.ts           macchina a stati: idle/listening/thinking/speaking
│  │     ├─ chunker.ts         divide lo stream LLM in frasi (puro, testato)
│  │     └─ endpoint.ts        fine turno: VAD + euristiche/Smart Turn
│  ├─ src/renderer/
│  │  ├─ face/                 face.ts  blink.ts  gaze.ts  expressions.ts
│  │  ├─ audio/                mic.ts  vad.ts  player.ts  rms.ts
│  │  └─ settings/
│  ├─ src/shared/              protocol.ts  emotions.ts  types.ts
│  ├─ test/
│  ├─ build.mjs  run.mjs  package.json  tsconfig.json
├─ sidecar/                    Python 3.11+
│  ├─ server.py                FastAPI + WebSocket su 127.0.0.1:<porta casuale>
│  ├─ stt/                     base.py  faster_whisper.py  parakeet.py
│  ├─ tts/                     base.py  qwen3.py  chatterbox.py  kokoro.py
│  ├─ ocr/                     winocr_engine.py  rapidocr_engine.py
│  ├─ uia/                     focus.py  caret.py  (eventi UIA)
│  ├─ text/                    normalize_it.py
│  ├─ pyproject.toml
│  └─ tests/
├─ CLAUDE.md
└─ README.md
```

Come in Pixel Pet: interfaccia in italiano, codice e commenti in inglese. La logica pura (attenzione, lettura, chunker, endpoint, normalizzazione) va in moduli senza dipendenze, coperti da test.

---

## Protocollo app ↔ sidecar

Il sidecar ascolta solo su `127.0.0.1`, con una porta casuale e un token generato da Electron e passato come variabile d'ambiente.

| Endpoint | Tipo | Ingresso → uscita |
| --- | --- | --- |
| `GET /health` | HTTP | → `{ ok, engines, gpu }` |
| `/stt` | WS | PCM 16 kHz → `{ partial }` / `{ final, words[] }` |
| `/tts` | WS | `{ id, text, emotion, intensity }` → blocchi PCM + `{ id, done }`; `{ cancel: id }` |
| `POST /ocr` | HTTP | PNG + rettangoli → `{ lines: [{ text, rect, words[] }] }` |
| `/uia` | WS | → eventi `{ focus, caret, selection }` con rettangoli |
| `POST /tts/batch` | HTTP | testo lungo → file audio (modalità audiolibro) |

---

## Impostazioni

`%APPDATA%\Lumi\settings.json` (le chiavi sono salvate a parte, cifrate):

```json
{
  "profile": "bilanciato",
  "brain":   { "chat": { "provider": "groq", "model": "..." }, "idle": { "provider": "ollama", "model": "qwen3" } },
  "stt":     { "engine": "faster-whisper", "model": "large-v3-turbo", "vocabulary": ["Sme.UP", "RPG"] },
  "tts":     { "engine": "qwen3", "model": "1.7B-CustomVoice", "voice": "...", "speed": 1.0 },
  "listen":  { "mode": "push-to-talk", "hotkey": "Ctrl+Alt+Space", "wakeWord": "ehi_lumi", "followUpSeconds": 8 },
  "face":    { "scale": 1.0, "color": "#F5F3EE" },
  "perception": {
    "enabled": true, "ocr": "windows", "captureFps": 4, "ocrFps": 1.5,
    "pauseInApps": ["KeePass", "1Password", "Bitwarden"],
    "sendScreenshots": "ask"
  },
  "sociability": "normale"
}
```

---

## Privacy

- **OCR, UIA e catture restano sul PC.** Al servizio di IA arriva solo il riassunto testuale breve del contesto percettivo e, con `look_at_screen`, lo screenshot. Con Ollama non esce nulla.
- `sendScreenshots`: `never` | `ask` (Lumi chiede prima, con un fumetto) | `always`.
- La percezione si **ferma da sola** nelle app indicate in `pauseInApps`, nelle finestre in incognito e con lo schermo bloccato.
- Sui piani gratuiti alcuni servizi (per esempio Gemini) possono usare i dati inviati per migliorare i propri modelli: verificane le condizioni prima di usarli con dati di lavoro.
- **Clonazione della voce**: usa solo la tua voce o voci per cui hai il consenso.
- I log di debug non salvano né l'audio né il testo OCR, a meno che non si attivi `LUMI_DEBUG_PERCEPTION=1`.

---

## Roadmap

Ogni fase si chiude con `npm run check` e `pytest` verdi e una prova manuale.

1. **Volto**: finestra trasparente, hit test, trascinamento, tray, occhi, battito e sguardo che segue il mouse.
2. **Cervello in testo**: provider portati da Pixel Pet, chat con riquadro, tool `say` → espressioni.
3. **Voce in uscita**: sidecar, TTS in streaming (Qwen3, poi Chatterbox e Kokoro), chunker, animazione RMS, normalizzazione italiana.
4. **Voce in entrata**: microfono con AEC, VAD, STT, push-to-talk, fine turno, barge-in con troncamento della cronologia.
5. **Percezione base**: caret, finestra in primo piano, rilevamento cambiamenti, modulo di attenzione.
6. **Lettura**: OCR sulle zone cambiate, simulazione della lettura, contesto percettivo, `look_at({ text })`.
7. **Visione**: `look_at_screen` con modelli multimodali, policy `sendScreenshots`.
8. **Umanità**: backchannel, riempitivi, Smart Turn, parola di attivazione, momenti autonomi, memoria, promemoria.
9. **Audiolibri**: `POST /tts/batch`, import di `.txt`/`.epub`, capitoli, voci diverse per i dialoghi, esportazione `.m4b`.
10. **Distribuzione**: installer Electron + sidecar impacchettato (embedded Python / `uv`) e download dei modelli al primo avvio.

---

## Avvio e sviluppo

Requisiti: Windows 10/11, Node.js 20+, Python 3.11+ (consigliato [uv](https://docs.astral.sh/uv/)) e, facoltativi, una GPU NVIDIA con CUDA e [Ollama](https://ollama.com).

```bash
# app
cd app
npm install
npm start          # avvia sempre tramite run.mjs
npm run debug      # con DevTools
npm run check      # typecheck + test

# sidecar (in sviluppo si può avviare a parte)
cd sidecar
uv sync
uv run python server.py --port 8765 --dev
uv run pytest
```

Variabili di debug (stesso stile di Pixel Pet):

- `LUMI_SIDECAR_URL`: usa un sidecar già avviato.
- `LUMI_DEBUG_GAZE=1`: disegna sullo schermo i candidati e il bersaglio.
- `LUMI_DEBUG_PERCEPTION=1`: registra OCR e UIA.
- `LUMI_DEBUG_SAY="testo|emozione"`: fa parlare Lumi senza LLM.
- `LUMI_DEBUG_CAPTURE=<prefisso>`: salva in PNG i fotogrammi del volto.

Log in `%APPDATA%\Lumi\logs\`.