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
7. [Visione locale](#visione-locale)
8. [Memoria a lungo termine](#memoria-a-lungo-termine)
9. [Abitudini e proattività](#abitudini-e-proattività)
10. [Sintesi vocale (TTS)](#sintesi-vocale-tts)
11. [Riconoscimento vocale (STT)](#riconoscimento-vocale-stt)
12. [Profili hardware](#profili-hardware)
13. [Struttura del progetto](#struttura-del-progetto)
14. [Protocollo app ↔ sidecar](#protocollo-app--sidecar)
15. [Impostazioni](#impostazioni)
16. [Privacy](#privacy)
17. [Roadmap](#roadmap)
18. [Avvio e sviluppo](#avvio-e-sviluppo)

---

## Cosa sa fare

- **Sempre in primo piano**: una finestra trasparente, senza bordi e trascinabile. I clic passano attraverso tutto ciò che non sono gli occhi, e la finestra è esclusa dalle catture e dalle condivisioni dello schermo.
- **Occhi vivi**: battito di ciglia naturale (con doppi battiti occasionali), saccadi, micro-movimenti ed espressioni fatte solo con la forma degli occhi.
- **Sguardo che segue lo schermo**: il cursore del testo mentre scrivi, il testo nuovo che appare (che Lumi "legge" riga per riga), le zone che cambiano, il mouse e ciò di cui sta parlando.
- **Conversazione a voce**: push-to-talk, parola di attivazione oppure ascolto continuo. Puoi interromperlo mentre parla e lui si ferma e ti ascolta.
- **Voce espressiva in italiano**: emozioni decise dal modello e applicate sia alla voce sia agli occhi.
- **Vede lo schermo**: legge il testo con l'OCR locale in tempo reale e, quando serve, manda uno screenshot a un modello con visione.
- **Cervello a scelta**: Ollama in locale, Google Gemini, Groq, OpenRouter (modelli `:free`) o qualsiasi API compatibile OpenAI (LM Studio…).
- **Memoria persistente** e **momenti autonomi** (commenti spontanei nelle pause), come in Pixel Pet. Ogni frase della conversazione finisce in un archivio locale (`archive.jsonl`): le parti più vecchie vengono riassunte in "episodi" che restano nel contesto, i fatti importanti su di te vengono estratti da soli, e a ogni domanda Lumi cerca nel suo passato i ricordi collegati (ricerca BM25 sull'italiano, tutta sul PC; tool `recall` per le ricerche esplicite, "ti ricordi quando…").
- **Memoria che dura anni** (fase 10, prevista): ricorda tutto ciò che è stato detto e lo ritrova per significato, per parole esatte o per data. Dà priorità a ciò che conta, ma non butta niente e dimentica solo quando glielo chiedi tu.
- **Impara le tue abitudini** (fase 11, prevista) e ti propone le cose prima che tu le chieda, senza mai agire da solo su azioni importanti.
- **Riconosce le voci**: un piccolo modello (WeSpeaker ResNet34, ONNX su CPU) misura l'"impronta" di ogni frase. La prima voce sentita al microfono è la tua; le altre diventano "Voce 2", "Voce 3"… finché non dici a Lumi chi sono ("quello che ha parlato è Marco", tool `name_voice`). Le impronte restano in `voices.json` e si cancellano dalle impostazioni.
- **Parla nelle chiamate Discord** (facoltativo, spento di default): un bot ti segue nei canali vocali dei server e parla con la voce di Lumi, così la sentono anche i tuoi amici; tu la senti in Discord (sul PC non suona due volte) e gli occhi continuano ad animarsi. Il bot entra "silenziato in ascolto" (non riceve l'audio di nessuno). Non funziona nelle chiamate private: i bot non possono entrarci.
- **Ascolta l'audio delle app** (facoltativo, spento di default): per esempio i tuoi amici su Discord. Windows cattura solo l'audio di quelle app (process loopback), mai la voce di Lumi, la musica o i video; il sidecar lo divide in frasi, lo trascrive in locale e riconosce chi parla. Le frasi entrano nella conversazione come contesto; Lumi risponde a un amico solo se lo chiama per nome, e durante una chiamata l'ascolto continuo aspetta la parola di attivazione.
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
| Contorno | ombra morbida e bordo sottile che si adattano allo sfondo (vedi [Ombra e contrasto](#ombra-e-contrasto)) |

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
| gioia | occhi più larghi, **tagliati dal basso** da una curva (le guance che salgono: occhi ad arco), leggero rimbalzo verso l'alto |
| tristezza | occhi più bassi, **palpebra tagliata in alto e scesa verso l'esterno** (angoli interni alzati), sguardo in basso |
| sorpresa | +28% in altezza, +14% in larghezza, breve pausa del battito |
| rabbia / fastidio | **palpebra tagliata in alto e scesa verso il naso** (cipiglio), più stretti |
| pensiero | sguardo in alto a destra, un occhio più piccolo, palpebre appena abbassate |
| ascolto | leggermente più alti, fissi su di te, pochi movimenti |
| sonno | palpebre dritte calate a metà, battiti lenti |
| imbarazzo | sguardo che scappa di lato, leggero taglio dal basso, breve "tremolio" |

I tagli sono parametri interpolati come gli altri (`lidTop`, `lidAngle`, `cheek` in `face/expressions.ts`): gli occhi tagliati si disegnano su un livello a parte, così bagliore, ombra e bordo seguono la forma tagliata.

**Mentre parla**, al posto della bocca: l'altezza degli occhi pulsa di ±5% seguendo l'ampiezza (RMS) dell'audio in uscita, con un leggero rimbalzo all'inizio di ogni frase. Le transizioni tra espressioni durano 150–300 ms e tutti i parametri si interpolano.

### Espressione sincronizzata con la voce

L'emozione di ogni `say` viaggia **insieme alla frase** fino al renderer (`AudioBegin { id, emotion, intensity }`, poi i blocchi PCM con lo stesso `id`). L'espressione cambia **quando quella frase sta per suonare**, non quando il testo viene generato: generazione e TTS sono in anticipo sulla riproduzione, quindi applicarla subito sarebbe fuori sincrono. Per cambiare emozione a metà risposta il modello usa più chiamate `say`.

- L'espressione parte circa 120 ms **prima** dell'audio, perché anche negli esseri umani il viso anticipa la voce. Il player del renderer manda l'evento `lead` 120 ms prima dell'inizio programmato della frase (subito, se la frase parte prima di così); per le frasi successive lo programma mentre la precedente sta ancora suonando. Main applica emozione e sguardo al `lead`, oppure allo `start` se il `lead` non è arrivato.
- L'intensità scala lo scostamento dalla forma neutra: 0,3 è un accenno, 1,0 è l'espressione piena.
- A fine risposta, dopo 1,5–3 s, l'espressione torna verso la neutra oppure verso lo stato di ascolto, se la conversazione continua.
- Se la risposta viene interrotta, l'espressione passa subito ad "ascolto".
- Quando il modello non indica un'emozione, si ricava una stima leggera dal testo (punti esclamativi, interrogative, parole chiave) in `shared/emotions.ts`. Il valore esplicito ha sempre la precedenza.

### Ombra e contrasto

Gli occhi devono restare leggibili anche su uno sfondo dello stesso colore. Si usano due strati, disegnati sotto ogni occhio:

1. **Ombra morbida**: sfocatura di 6 px, offset (0, 1) px, nera.
2. **Bordo sottile**: 1 px, nero, appena fuori dalla capsula.

Sopra resta il leggero bagliore caldo, che si vede sugli sfondi scuri.

L'opacità è **adattiva**. Grazie a `setContentProtection(true)`, le catture dello schermo vedono ciò che c'è *dietro* la finestra di Lumi. Una volta al secondo si misura la luminanza media sotto il volto (`perception/backdrop.ts`), riusando i fotogrammi del rilevamento dei cambiamenti, che comprendono sempre il monitor di Lumi: nessuna cattura in più.

| Luminanza dietro il volto | Ombra | Bordo |
| --- | --- | --- |
| < 0,35 (scuro) | 20% | 10% |
| 0,35 – 0,75 | 30% | 18% |
| > 0,75 (chiaro, simile agli occhi) | 45% | 30% |

Per uscire da una fascia bisogna superarne il bordo di 0,03, così uno sfondo a cavallo tra due fasce non fa tremolare il contorno. Le variazioni si interpolano in 400 ms. Con la percezione disattivata o in pausa (dopo 3 s senza misure), o con l'opzione «Ombra adattiva» spenta nelle impostazioni, si usano i valori intermedi fissi.

### Abbagliamento

> Previsto (fase 9.4).

Quando lo schermo che Lumi sta guardando passa all'improvviso da prevalentemente scuro a prevalentemente chiaro (per esempio quando apri una pagina bianca da un editor scuro), Lumi viene "abbagliato".

**Rilevamento** (`perception/glare.ts`, puro e testato):

- Si cattura una miniatura 64×36 del monitor osservato, cioè quello del bersaglio dello sguardo, a 4 fps.
- Si calcola la luminanza relativa media (Rec. 709 sui valori linearizzati) e la percentuale di pixel con luminanza > 0,6.
- L'abbagliamento scatta quando, entro 500 ms, la luminanza media passa da < 0,25 a > 0,55 **e** i pixel chiari superano il 60%.
- Le transizioni graduali (dissolvenze più lente di 1 s) non contano: l'occhio "si adatta".
- Dopo un abbagliamento ci sono 20 s di attesa. Non scatta mentre Lumi dorme, durante il trascinamento della finestra o quando cambia il monitor osservato.

**Quale occhio**: si calcola il baricentro dei pixel chiari. L'occhio **più vicino** a quel punto (in coordinate dello schermo) si chiude del tutto, l'altro si chiude a metà. Se il baricentro è quasi allineato con il centro del volto, decide la direzione dello sguardo.

**Animazione** (circa 1,6 s in totale):

| Fase | Durata | Occhio vicino | Occhio lontano | Sguardo |
| --- | --- | --- | --- | --- |
| strizzata | 70 ms | altezza 8% | altezza 50% | si sposta di 3 px dalla luce |
| tenuta | 350–600 ms | tremolio ±1% | tremolio ±2% | fermo |
| riapertura | 500 ms | easing out, fino a 100% | fino a 100% | torna al bersaglio |
| assestamento | — | 1–2 battiti rapidi entro 600 ms | idem | — |

L'abbagliamento ha la priorità su tutte le espressioni tranne il parlato. Se Lumi sta parlando, si applica una versione ridotta (60%) e l'audio non si interrompe.

---

## Percezione dello schermo e sguardo

### È possibile leggere lo schermo in tempo reale?

**Sì**, a patto di non affidare tutto a un modello di visione, che è troppo lento per seguire lo sguardo. Si usano **più livelli economici in locale**, sempre attivi, e il modello di visione solo quando serve capire il contenuto.

| Livello | Cosa produce | Frequenza | Costo |
| --- | --- | --- | --- |
| Puntatore e finestra in primo piano (koffi: `GetCursorPos`, `GetForegroundWindow`) | posizione del mouse, finestra attiva | 30–60 Hz | nullo |
| **Caret** (koffi: `GetGUIThreadInfo`; UIA `TextPattern2` per Chrome, VS Code ed Electron, che non usano il caret di sistema) | dove stai scrivendo | 20 Hz / a eventi | nullo |
| **UI Automation** (eventi di focus, testo e rettangoli dell'elemento attivo) | campo con il focus, testo selezionato | a eventi | basso |
| **Rilevamento cambiamenti** (cattura a bassa risoluzione fatta dal sidecar, differenza tra blocchi 32×32) | rettangoli delle zone che sono cambiate | 4–5 fps | basso |
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

- **DPI**: le catture dello schermo lavorano in pixel fisici, mentre Electron usa pixel indipendenti dal dispositivo (DIP). Conviene convertire sempre con `screen.dipToScreenRect` / `screenToDipRect` e lavorare per singolo monitor.
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
- **Fine del turno**: il solo silenzio non basta, perché le persone fanno pause a metà frase. Si combinano il VAD (silenzio oltre la «pausa prima di rispondere», 1 s di default e regolabile nelle impostazioni) e un controllo semantico: un modello di turn detection come *Smart Turn* di Pipecat, oppure un'euristica sull'ultima parola ("e", "ma", "quindi" → aspetta). Se il turno sembra lasciato a metà, l'attesa cresce fino a 2,4 volte la pausa (al massimo 4 s).
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
| **Chiamandola per nome** | dici "Lumi…" o "Ehi Lumi…" (vedi sotto) |
| Conversazione continua | dopo una risposta resta in ascolto per 8 s senza bisogno di richiamarla |
| **Barra dei comandi** (prevista) | `Ctrl+Alt+L` → campo di testo in sovrimpressione (vedi sotto) |
| Chat | clic sugli occhi → riquadro di chat con la cronologia, come in Pixel Pet |

### Attivazione per nome

**Oggi** il nome viene cercato nelle trascrizioni (`voice/wakeWord.ts`, ricerca approssimata), così "Ehi Lumi" funziona senza addestrare un modello.

**Previsto (fase 9.6)**: un riconoscitore dedicato che gira **sempre in locale** e consuma poco, così STT e LLM restano spenti finché il nome non viene riconosciuto.

- **Motore**: openWakeWord nel sidecar (ONNX su CPU), con lo stream audio del microfono a 16 kHz inviato in blocchi da 80 ms tramite il WebSocket `/wake`. È lo stesso flusso del VAD, quindi il microfono si apre una volta sola. Prima si prova il flusso con un modello openWakeWord generico, poi si addestra "Lumi".
- **Modello del nome**: openWakeWord si allena con **campioni sintetici**, e qui il TTS di Lumi diventa utile. Lo script `sidecar/wake/train.py`:
  1. genera 2.000–5.000 pronunce di "Lumi" / "Ehi Lumi" con tutte le voci disponibili (Qwen3-TTS, Chatterbox, Kokoro), variando velocità, intonazione ed emozione;
  2. aggiunge rumore, riverbero e audio di sottofondo;
  3. usa come negativi parole simili ("lume", "Luigi", "lumaca", "lui mi"…) e parlato italiano generico;
  4. produce `lumi.onnx` nella cache dei modelli (`%APPDATA%\Lumi\models\wake`), non nel repository.

  Facoltativo: 20–30 registrazioni della tua voce migliorano molto la precisione.
- **Falsi positivi**: "Lumi" è corto (due sillabe) e rischia di scattare a vuoto. Per questo è prevista anche "Ehi Lumi" e la soglia di attivazione si regola nelle impostazioni. Per scattare non basta un picco: servono almeno 2 fotogrammi consecutivi sopra soglia. Mentre Lumi parla la soglia sale del 30%, per evitare che si attivi da sola sentendo la propria voce.
- **Frase unica**: se dici "Lumi, che ore sono?" tutto di seguito, l'audio dei 1,5 s precedenti (buffer circolare) viene passato all'STT. Così la domanda non si perde e non serve aspettare un segnale.
- **Reazione**: appena riconosce il nome, gli occhi si aprono un po' di più e guardano verso di te, e si sente un breve "mh?" opzionale dalla cache. Se entro 5 s non dici nulla, Lumi torna a riposo.
- **Quando è disattivata**: in "Non disturbare", con lo schermo bloccato e mentre usi il microfono in un'altra app per una chiamata (rilevata quando il dispositivo di input è in uso esclusivo o quando è aperta un'app di riunioni presente in `pauseInApps`).

### Barra dei comandi

> Prevista (fase 9.3).

Una finestra separata (`commandbar.ts`), creata all'avvio e nascosta, così si apre all'istante.

- **Scorciatoia globale**: `Ctrl+Alt+L` (configurabile, con `globalShortcut`). Premuta di nuovo, oppure con `Esc`, la barra si chiude.
- **Aspetto**: senza bordi, angoli arrotondati da 16 px, centrata in orizzontale a circa il 30% dell'altezza del monitor dove si trova il mouse, larga 640 px. Lo sfondo è sfocato (`backgroundMaterial: 'acrylic'` su Windows 11, con un fallback semitrasparente scuro su Windows 10), testo da 18 px e un segnaposto del tipo "Chiedi qualcosa a Lumi…".
- **Animazione**: entra con fade + scala da 0,96 a 1 in 140 ms. Mentre scrivi, gli occhi di Lumi guardano la barra.
- **Comportamento**:
  - `Invio` invia, `Maiusc+Invio` va a capo e il campo cresce fino a 6 righe.
  - Dopo l'invio la barra si chiude subito e Lumi risponde **a voce** e/o con un fumetto, secondo le impostazioni ("risposta alla barra: voce / testo / entrambi").
  - `↑` richiama i prompt precedenti (ultimi 50, salvati in locale).
  - Puoi **trascinare** un file o un'immagine nella barra per allegarlo. Con le immagini vale la policy della [visione locale](#visione-locale).
  - Se c'è del testo selezionato in un'altra app quando apri la barra (letto via UIA), compare come "contesto" sopra il campo e si può rimuovere con un clic. Esempio: selezioni un errore, `Ctrl+Alt+L`, "cosa vuol dire?".
- **Focus**: la barra prende il focus quando si apre e lo restituisce alla finestra precedente quando si chiude.

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
- `look_at_screen({ focus? })` (oggi screenshot al modello `brain.vision`; previsto: passa dal modello di [visione locale](#visione-locale))
- `remember({ fact, kind })`
- `recall({ query })` (ricerca nell'archivio della conversazione)
- `forget({ id })` (previsto: `forget({ query })`, che avvia il flusso di oblio con conferma)
- `search_memory({ query?, from?, to?, kind? })` (previsto, vedi [Memoria a lungo termine](#memoria-a-lungo-termine))
- `set_reminder({ when, text })`
- `name_voice({ voice, name })`
- `stay_quiet()`

---

## Visione locale

> Prevista (fase 9.5). Oggi `look_at_screen` manda lo screenshot al modello scelto in `brain.vision`, che può essere remoto.

Le immagini (screenshot, immagini allegate dalla barra o trascinate sugli occhi) vengono analizzate da un **modello di visione che gira sul PC**, separato dal cervello. **Il cervello riceve solo il testo che il modello di visione produce, mai l'immagine.** In questo modo puoi usare Groq o Gemini per conversare, perché sono veloci, senza che lo schermo esca dal computer.

```
look_at_screen({ question })
   │
   ├─► screenshot (finestra attiva o monitor, senza Lumi; lo cattura il sidecar)
   ├─► OCR locale già disponibile ──────────────┐
   └─► modello di visione locale (Ollama) ──────┤
                                                ▼
        { description, texts[], regions[{ label, rect }] }  ──►  cervello (solo testo)
```

- **Servizio**: Ollama (`/api/chat` con `images`), con un'impostazione `vision` propria e indipendente da `brain`. Facoltativo: qualsiasi server locale compatibile OpenAI, come LM Studio o llama.cpp.
- **Modelli consigliati**:

  | VRAM libera | Modello | Note |
  | --- | --- | --- |
  | ~3 GB | `qwen3-vl:2b` o `gemma3:4b` | descrizioni essenziali, va bene anche su GPU piccole |
  | ~6–8 GB | **`qwen3-vl:8b`** (predefinito) | ottimo su testo, interfacce e documenti |
  | 16 GB o più | `gemma4:12b`, `qwen3-vl:30b` | massima qualità |

  "Rileva modelli" mostra solo i modelli Ollama con la capacità `vision`.
- **Prompt**: viene inviata la domanda del cervello, più il testo OCR della stessa immagine come aiuto (riduce gli errori di lettura dei modelli piccoli). Si chiede una risposta JSON con `description` (in italiano, al massimo 120 parole), `texts` (testi rilevanti) e `regions` (al massimo 5, con coordinate normalizzate 0–1000). Qwen3-VL restituisce le coordinate in modo affidabile.
- **Sguardo**: le `regions` diventano candidati per il modulo di attenzione. Così Lumi guarda la cosa che sta descrivendo anche quando non contiene testo, come un grafico o un'immagine.
- **Ridimensionamento**: lato lungo al massimo 1.344 px prima dell'invio, ritagliando la finestra attiva quando basta. È più veloce e, per i modelli piccoli, spesso anche più preciso.
- **Memoria video**: il modello di visione viene caricato su richiesta, con `keep_alive: "2m"`, e libera la VRAM per TTS e STT quando non serve. Al primo uso dopo un po' di inattività c'è un ritardo di caricamento, durante il quale gli occhi fanno l'espressione di pensiero.
- **Senza modello locale**: se `vision.provider` è `none` oppure il modello non è disponibile, `look_at_screen` restituisce solo OCR + UIA. L'immagine viene inviata al cervello remoto solo se `sendScreenshots` lo consente esplicitamente, e mai per impostazione predefinita.

---

## Memoria a lungo termine

> Prevista (fase 10). **Oggi** la memoria è `archive.jsonl` con episodi riassunti, fatti estratti e ricerca BM25 (`brain/memory.ts`, `brain/recall.ts`): il nuovo sistema la sostituisce e ne importa il contenuto.

**Obiettivo**: dopo anni di uso continuo, Lumi deve ricordare tutto ciò che è stato detto. Dà la priorità a ciò che è importante, ma deve saper ritrovare anche i dettagli secondari, e dimentica **solo su richiesta esplicita**.

### Principi

- **I ricordi non vanno nei pesi del modello.** Il fine-tuning per memorizzare conversazioni è costoso e impreciso, e il modello tende a dimenticare o mescolare le cose. Il modello resta fisso e la memoria è uno strato esterno. Esistono ricerche su modelli che aggiornano una memoria interna mentre leggono, come Titans di Google, ma sono prototipi che non si possono usare con Ollama.
- **Il testo è la fonte di verità, i vettori sono un indice.** Gli embedding dipendono dal modello che li ha generati: se cambi modello vanno ricalcolati, e si può fare solo se il testo originale è conservato.
- **La ricerca è ibrida.** La similarità semantica sbaglia su nomi propri, numeri, date e codici ("come si chiamava il veterinario?"), dove la ricerca testuale classica funziona meglio. Si usano entrambe e si combinano i risultati.
- **Il tempo è un filtro, non un vettore.** "Cosa ti ho detto a marzo?" si risolve filtrando per data.

### I quattro livelli

Tutti i livelli stanno in un solo file SQLite, `%APPDATA%\Lumi\memory.db`.

| Livello | Contenuto | Si cancella? |
| --- | --- | --- |
| 1. **Log grezzo** | ogni frase detta da te e da Lumi (voce, barra, chat), con data e ora, sessione e canale | mai, salvo oblio esplicito |
| 2. **Indice ibrido** | per ogni scambio un embedding (`sqlite-vec`) e un indice full-text (FTS5, incluso in SQLite) | si ricalcola dal log |
| 3. **Fatti estratti** | fatti stabili ("ha un gatto di nome X") con importanza da 1 a 10, tipo (`persona`, `preferenza`, `progetto`, `abitudine`…) e gli ID dei messaggi da cui derivano | si aggiornano, non si duplicano |
| 4. **Riassunti gerarchici** | giornalieri, poi settimanali e mensili costruiti sui giornalieri, ognuno con gli ID delle fonti | si rigenerano |

Schema di massima:

```sql
messages(id, ts, session_id, speaker, channel, text)              -- livello 1
messages_fts USING fts5(text, content='messages')                 -- livello 2 (testo)
embeddings(owner_kind, owner_id, model, dim, vector)              -- livello 2 (vec0 di sqlite-vec)
facts(id, kind, text, importance, confidence, created, updated,
      superseded_by, source_ids)                                  -- livello 3
summaries(id, period, start, end, text, source_ids)               -- livello 4
```

- Ogni vettore salva il **nome del modello** che l'ha prodotto. Se cambi modello, un job in background ricalcola i vettori un po' alla volta, e nel frattempo la ricerca usa solo quelli coerenti con il modello attuale, più FTS.
- Si indicizzano come vettori i messaggi (raggruppati per scambio), i fatti e i riassunti.

### Scrittura

1. **Subito**: ogni frase va nel log e in FTS. L'embedding si calcola in una coda asincrona, così non rallenta mai la conversazione.
2. **A fine conversazione** (dopo 5 minuti di silenzio, o alla chiusura): l'LLM estrae i fatti stabili con la loro importanza. Se un fatto nuovo **contraddice** uno esistente ("mi sono trasferito a…"), quello vecchio viene marcato `superseded_by` invece di aggiungerne un secondo in contrasto. La storia resta, ma vale l'ultimo.
3. **Riflessione notturna** (vedi [Abitudini](#abitudini-e-proattività)): riassunto del giorno, poi della settimana la domenica e del mese il primo del mese.

### Ricerca

1. **Filtri**: intervallo di date, tipo di ricordo, canale.
2. **Due ricerche in parallelo**: FTS5 (BM25) e vettoriale (top 50 ciascuna).
3. **Fusione** con Reciprocal Rank Fusion.
4. **Riordino** con la formula di *Generative Agents* (Park et al., 2023):

   `punteggio = α·rilevanza + β·recenza + γ·importanza`

   con la recenza che decade in modo esponenziale (per esempio `0,995^ore` dall'ultimo accesso) e pesi iniziali α = 1, β = 0,5, γ = 0,5, da tarare. L'importanza **cambia l'ordine dei risultati ma non decide cosa viene buttato**: niente viene scartato.
5. Al prompt arrivano al massimo circa 1.500 token di ricordi. I fatti più importanti (≥ 8) entrano sempre in una sezione fissa "cosa so di te", mentre gli altri ricordi entrano solo se pertinenti.

Lumi può anche **cercare da solo** con il tool `search_memory({ query, from, to, kind })`, per esempio quando gli chiedi "cosa ti ho detto a marzo sul trasloco?" o quando il recupero automatico non basta.

**Embedding**: via Ollama con `bge-m3` (multilingue, buono in italiano, 1024 dimensioni) oppure `nomic-embed-text`, più leggero. Senza Ollama, ad esempio nel profilo leggero, gli embedding girano nel sidecar su CPU. Se nessuno dei due è disponibile, la memoria funziona con il solo FTS e i vettori vengono calcolati in seguito.

**Dimensioni**: con circa 200 scambi al giorno per 5 anni si arriva a circa 365.000 righe. Con vettori da 1024 dimensioni in float32 sono circa 1,5 GB, molto meno se quantizzati (int8 o binari, con un riordino finale sui float). Per SQLite è un volume gestibile, con ricerche nell'ordine dei decimi di secondo.

### Oblio (solo su richiesta)

Quando dici "dimentica X", non basta cancellare la riga originale: X è anche nel suo embedding, nei fatti estratti e nei riassunti che lo citano. Per questo fatti e riassunti salvano `source_ids`.

1. Lumi cerca X in **tutti i livelli** (ricerca ibrida, con soglia larga).
2. Ti **mostra cosa ha trovato** (in un fumetto o nella barra) e chiede conferma. Puoi escludere singole voci.
3. Cancella le righe confermate, i loro vettori e le voci FTS, e i fatti che derivano **solo** da quelle righe.
4. **Rigenera** i riassunti e i fatti che le citavano insieme ad altre fonti.
5. Esegue `VACUUM` del database, così i dati cancellati non restano nel file.

Un backup automatico giornaliero (`memory.db` + rotazione su 7 giorni) protegge dalle perdite accidentali. Anche i backup devono rispettare l'oblio: dopo un oblio si rigenerano.

---

## Abitudini e proattività

> Previste (fase 11).

Le abitudini si vedono da **quello che fai**, non solo da quello che dici. Per questo, accanto alla memoria delle conversazioni, c'è un **log degli eventi**.

### Eventi raccolti (`events.ts`)

- app e finestra in primo piano (cambio e durata);
- comandi dati a Lumi (voce, barra, chat) e azioni proposte, accettate o rifiutate;
- ora, giorno della settimana, inizio e fine sessione, pause;
- facoltativo: categorie di ciò che vede (dal contesto percettivo, solo etichette e non testo integrale).

Gli eventi stanno nello stesso `memory.db`, nella tabella `events(ts, kind, app, detail)`, con la stessa policy di oblio.

### Riconoscimento dei pattern (`patterns.ts`, deterministico, senza LLM)

Il codice deterministico è più affidabile ed economico di un LLM per questo compito. Si parte con due tipi di pattern:

- **Ricorrenze temporali**: "nei giorni feriali verso le 9 apri X". Si contano le occorrenze per fascia oraria (30 minuti) e giorno della settimana.
- **Sequenze**: "dopo A fai B nell'80% dei casi". Si contano le coppie di eventi consecutivi, come in una semplice catena di Markov.

Un pattern diventa un'**ipotesi** solo sopra una soglia, per esempio almeno 5 occorrenze con almeno il 70% di frequenza.

### Riflessione notturna (`reflection.ts`)

Gira quando il PC è inattivo (di notte, o dopo 30 minuti di inattività con l'alimentazione collegata), perché un LLM locale in background consuma risorse. Lumi:

1. scrive il riassunto della giornata (e quelli settimanali o mensili quando tocca);
2. rilegge le statistiche dei pattern e dà un nome alle abitudini ("sessione di lavoro mattutina su RPG");
3. le salva come fatti di tipo `abitudine`, con un livello di confidenza;
4. aggiorna o archivia le abitudini che non trovano più riscontro.

È questa combinazione di statistiche e riflessione periodica a dare l'effetto di un assistente che "ragiona per conto suo" e ti anticipa.

### Trigger

Quando il contesto attuale corrisponde a un'abitudine, Lumi **propone** l'azione ma non la esegue.

- Se accetti, la confidenza sale. Se rifiuti, scende, e sotto una soglia (per esempio 0,3) l'abitudine viene archiviata.
- **C'è un limite**: al massimo una proposta ogni 20 minuti (configurabile) e nessuna proposta in "Non disturbare", durante le chiamate o mentre scrivi intensamente.
- **Niente azioni irreversibili senza conferma.** Proporre va sempre bene, mentre agire da solo è permesso solo per cose innocue e attivate esplicitamente nelle impostazioni (per esempio "apri sempre X alle 9").

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

| Profilo | Cervello | STT | TTS | Visione locale (prevista) | VRAM |
| --- | --- | --- | --- | --- | --- |
| **Leggero** (nessuna GPU) | Groq / Gemini | Groq Whisper | Kokoro (CPU) | solo OCR | 0 |
| **Bilanciato** (8–12 GB) | Groq / Gemini | faster-whisper turbo | Qwen3-TTS 1.7B | `qwen3-vl:8b` su richiesta | circa 6 GB, picchi di 12 GB durante la visione |
| **Tutto locale** (16–24 GB) | Ollama `qwen3` 8B | faster-whisper turbo | Qwen3-TTS 1.7B | `qwen3-vl:8b` su richiesta | circa 14–20 GB |

La parola di attivazione gira su CPU in ogni profilo. Il modello di visione viene caricato solo quando serve e scaricato dopo 2 minuti.

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
│  │  ├─ commandbar.ts         barra dei comandi in sovrimpressione (prevista)
│  │  ├─ settings.ts           JSON in %APPDATA%\Lumi + chiavi DPAPI
│  │  ├─ sidecar.ts            spawn, health check, riavvio
│  │  ├─ perception/
│  │  │  ├─ desktop.ts         koffi: finestre, foreground, cursore, caret
│  │  │  ├─ capture.ts         frame dal sidecar + diff a blocchi
│  │  │  ├─ attention.ts       candidati → bersaglio dello sguardo (puro, testato)
│  │  │  ├─ reading.ts         simulazione della lettura (puro, testato)
│  │  │  ├─ glare.ts           rilevamento abbagliamento (puro, testato; previsto)
│  │  │  ├─ backdrop.ts        luminanza dietro il volto → ombra adattiva (puro, testato)
│  │  │  ├─ vision.ts          look_at_screen → visione locale (Ollama; previsto)
│  │  │  └─ context.ts         riassunto percettivo per il prompt
│  │  ├─ brain/
│  │  │  ├─ brain.ts  prompt.ts  tools.ts  memory.ts  recall.ts
│  │  │  ├─ memory/            (previsto, fase 10)
│  │  │  │  ├─ db.ts           better-sqlite3 + sqlite-vec + FTS5, migrazioni, backup
│  │  │  │  ├─ store.ts        log, coda embedding, ricalcolo al cambio modello
│  │  │  │  ├─ search.ts       ricerca ibrida, RRF, punteggio (puro, testato)
│  │  │  │  ├─ facts.ts        estrazione e aggiornamento dei fatti
│  │  │  │  ├─ summaries.ts    riassunti giornalieri/settimanali/mensili
│  │  │  │  └─ forget.ts       oblio a cascata con conferma
│  │  │  ├─ habits/            (previsto, fase 11)
│  │  │  │  ├─ events.ts       log degli eventi
│  │  │  │  ├─ patterns.ts     ricorrenze e sequenze (puro, testato)
│  │  │  │  ├─ reflection.ts   job notturno con l'LLM
│  │  │  │  └─ triggers.ts     proposte, limite, confidenza
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
│  ├─ wake/                    detector.py  train.py  (openWakeWord, dati sintetici dal TTS; previsto)
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
| `POST /screen/luma` | HTTP | rettangoli dei monitor → fotogrammi in scala di grigi (~640 px) per il rilevamento dei cambiamenti |
| `POST /screen/jpeg` | HTTP | rettangolo di un monitor → JPEG per `look_at_screen` |
| `/apps` | WS | `{ apps: ["Discord"] }` → `{ type: "status", apps }` e, per ogni frase sentita in quelle app, `{ type: "heard", app, text, voiceprint }` |
| `/uia` | WS | → eventi `{ focus, caret, selection }` con rettangoli |
| `/wake` (previsto) | WS | PCM 16 kHz a blocchi da 80 ms → `{ wake, score, preroll_ms }` |
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
  "vision":  { "provider": "ollama", "model": "qwen3-vl:8b", "keepAlive": "2m", "maxSide": 1344 },
  "listen":  { "mode": "push-to-talk", "hotkey": "Ctrl+Alt+Space", "wakeWord": "ehi lumi", "wakeThreshold": 0.5, "followUpSeconds": 8 },
  "commandBar": { "hotkey": "Ctrl+Alt+L", "reply": "voice+text", "useSelection": true },
  "face":    { "scale": 1.0, "color": "#F5F3EE", "adaptiveShadow": true, "glare": true },
  "perception": {
    "enabled": true, "ocr": "windows", "captureFps": 4, "ocrFps": 1.5,
    "pauseInApps": ["KeePass", "1Password", "Bitwarden"],
    "sendScreenshots": "never"
  },
  "memory": {
    "embeddings": { "provider": "ollama", "model": "bge-m3" },
    "promptBudgetTokens": 1500,
    "weights": { "relevance": 1.0, "recency": 0.5, "importance": 0.5 },
    "factExtraction": { "provider": "ollama", "model": "qwen3" },
    "backupDays": 7
  },
  "habits": {
    "enabled": true, "minOccurrences": 5, "minFrequency": 0.7,
    "proposalCooldownMinutes": 20, "archiveBelowConfidence": 0.3,
    "reflection": { "provider": "ollama", "model": "qwen3", "when": "idle-night" },
    "autoActions": []
  },
  "sociability": "normale"
}
```

Sono previste e arrivano con le rispettive fasi della roadmap: le sezioni `vision` (sostituirà `brain.vision`), `commandBar`, `memory` e `habits`, le chiavi `wakeThreshold` e `glare`, e il nuovo default `sendScreenshots: "never"`.

---

## Privacy

- **OCR, UIA e catture restano sul PC.** Oggi al servizio di IA arriva solo il riassunto testuale breve del contesto percettivo e, con `look_at_screen`, lo screenshot. Con Ollama non esce nulla.
- **Con la [visione locale](#visione-locale)** (prevista) anche le immagini restano sul PC: le analizza il modello locale e al servizio remoto arriva solo testo (il riassunto percettivo e le descrizioni prodotte localmente).
- `sendScreenshots`: `never` | `ask` (Lumi chiede prima, con un fumetto) | `always`. Con la visione locale varrà solo per l'invio diretto di immagini al cervello remoto quando manca un modello locale, con `never` come default.
- **Memoria ed eventi** (previsti, `memory.db`) restano sul PC. Al cervello arrivano solo i ricordi pertinenti alla domanda (al massimo `promptBudgetTokens`). Estrazione dei fatti e riflessione notturna usano per impostazione predefinita un modello locale, così l'intero storico non viene mai inviato a un servizio remoto. L'oblio cancella anche vettori, fatti, riassunti e backup derivati.
- **Il nome viene riconosciuto in locale** (con openWakeWord, previsto): finché non chiami Lumi, l'audio del microfono non viene trascritto, né salvato, né inviato.
- La percezione si **ferma da sola** nelle app indicate in `pauseInApps`, nelle finestre in incognito e con lo schermo bloccato.
- Sui piani gratuiti alcuni servizi (per esempio Gemini) possono usare i dati inviati per migliorare i propri modelli: verificane le condizioni prima di usarli con dati di lavoro.
- **Clonazione della voce**: usa solo la tua voce o voci per cui hai il consenso.
- **Audio delle app** (spento di default): l'audio viene trascritto sul PC e serve il riconoscimento vocale locale (non Groq); le frasi trascritte entrano nel contesto e quindi vanno al servizio di IA scelto per il cervello. Avvisa le persone in chiamata che Lumi le ascolta.
- **Bot Discord**: il token è cifrato con DPAPI in `discord.bin` (oppure `DISCORD_BOT_TOKEN`). Il bot riceve solo la voce di Lumi da mandare nel canale.
- **Impronte vocali**: sono dati biometrici, restano in `voices.json` sul PC e si cancellano una per una (o con "Dimentica tutto") dalla scheda Memoria.
- **Archivio della conversazione** (`archive.jsonl`): resta sul PC; "Dimentica tutto" lo svuota.
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
8. **Umanità**: backchannel, riempitivi, Smart Turn, parola di attivazione, momenti autonomi, memoria di base (`archive.jsonl`), promemoria.
9. **Prossimo blocco**, in quest'ordine, perché ogni punto è indipendente e si prova da solo:
   1. ~~[Ombra e contrasto](#ombra-e-contrasto) adattivi~~ (fatto).
   2. ~~[Espressione sincronizzata con la voce](#espressione-sincronizzata-con-la-voce)~~ (fatto).
   3. [Barra dei comandi](#barra-dei-comandi) con `Ctrl+Alt+L`.
   4. [Abbagliamento](#abbagliamento): prima `glare.ts` con i test, poi l'animazione.
   5. [Visione locale](#visione-locale) con Ollama e `qwen3-vl`, poi le `regions` come candidati di sguardo.
   6. [Attivazione per nome](#attivazione-per-nome) con openWakeWord: prima con un modello generico per provare il flusso, poi l'addestramento di "Lumi" con `train.py`.
10. **Memoria a lungo termine** ([dettagli](#memoria-a-lungo-termine)): prima `db.ts` + log + FTS + `search_memory` per date, poi coda di embedding e ricerca ibrida, poi fatti, riassunti e infine oblio a cascata. Importare nel log `archive.jsonl`, episodi e fatti esistenti.
11. **Abitudini** ([dettagli](#abitudini-e-proattività)): log degli eventi, `patterns.ts` con i test, riflessione notturna, trigger con limite e confidenza.
12. **Audiolibri**: `POST /tts/batch`, import di `.txt`/`.epub`, capitoli, voci diverse per i dialoghi, esportazione `.m4b`.
13. **Distribuzione**: installer Electron + sidecar impacchettato (embedded Python / `uv`) e download dei modelli al primo avvio.

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