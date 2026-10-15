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
10. [Movimento sullo schermo](#movimento-sullo-schermo)
11. [Lumi sul telefono](#lumi-sul-telefono)
12. [Usare il PC](#usare-il-pc)
13. [Sintesi vocale (TTS)](#sintesi-vocale-tts)
14. [Riconoscimento vocale (STT)](#riconoscimento-vocale-stt)
15. [Profili hardware](#profili-hardware)
16. [Struttura del progetto](#struttura-del-progetto)
17. [Protocollo app ↔ sidecar](#protocollo-app--sidecar)
18. [Impostazioni](#impostazioni)
19. [Privacy](#privacy)
20. [Roadmap](#roadmap)
21. [Avvio e sviluppo](#avvio-e-sviluppo)

---

## Cosa sa fare

- **Sempre in primo piano**: una finestra trasparente, senza bordi e trascinabile. I clic passano attraverso tutto ciò che non sono gli occhi, e la finestra è esclusa dalle catture e dalle condivisioni dello schermo.
- **Occhi vivi**: battito di ciglia naturale (con doppi battiti occasionali), saccadi, micro-movimenti ed espressioni fatte solo con la forma degli occhi.
- **Sguardo che segue lo schermo**: il cursore del testo mentre scrivi, il testo nuovo che appare (che Lumi "legge" riga per riga), le zone che cambiano, il mouse e ciò di cui sta parlando.
- **Conversazione a voce**: push-to-talk, parola di attivazione oppure ascolto continuo. Puoi interromperlo mentre parla e lui si ferma e ti ascolta.
- **Voce espressiva in italiano**: emozioni decise dal modello e applicate sia alla voce sia agli occhi.
- **Vede lo schermo**: legge il testo con l'OCR locale in tempo reale e, quando serve, manda uno screenshot a un modello con visione.
- **Cervello a scelta**: Ollama in locale, Google Gemini, Groq, OpenRouter (modelli `:free`) o qualsiasi API compatibile OpenAI (LM Studio…).
- **Memoria persistente** e **momenti autonomi** (commenti spontanei nelle pause), come in Pixel Pet. Ogni frase della conversazione finisce in un database locale (`memory.db`): le parti più vecchie vengono riassunte in "episodi" che restano nel contesto, i fatti importanti su di te vengono estratti da soli, e a ogni domanda Lumi cerca nel suo passato i ricordi collegati (ricerca per parole e per significato, tutta sul PC; tool `search_memory` per le ricerche esplicite, anche per data: "ti ricordi quando…", "cosa ti ho detto a marzo?").
- **Memoria che dura anni** (fase 10, prevista): ricorda tutto ciò che è stato detto e lo ritrova per significato, per parole esatte o per data. Dà priorità a ciò che conta, ma non butta niente e dimentica solo quando glielo chiedi tu.
- **Si muove sullo schermo** (fase 14, prevista): se le chiedi di spostarsi ("vai in alto a destra", "sull'altro schermo", "levati, mi copri") vola lì da sola, anche tra i monitor; e si muove anche di sua iniziativa quando ha un motivo, per indicarti qualcosa o per farti un piccolo dispetto se l'hai infastidita.
- **Passa sul telefono** (fase 15, prevista): con il tasto "Chiama" dell'app Lumi viene risucchiata fuori dallo schermo del PC (come un oggetto che cade in un buco nero) e riemerge nell'app, dove la vedi e le parli; voce, cervello e memoria restano sul PC.
- **Usa il PC** (fase 16, prevista): apre e chiude app, file e cartelle, gestisce le finestre e la musica e preme i controlli dentro le app; le azioni che cambiano qualcosa le fa solo dopo averti chiesto conferma.
- **Impara le tue abitudini** (fase 11, prevista) e ti propone le cose prima che tu le chieda, senza mai agire da solo su azioni importanti.
- **Riconosce le voci**: un piccolo modello (WeSpeaker ResNet34, ONNX su CPU) misura l'"impronta" di ogni frase. La prima voce sentita al microfono è la tua; le altre diventano "Voce 2", "Voce 3"… finché non dici a Lumi chi sono ("quello che ha parlato è Marco", tool `name_voice`). Le impronte restano in `voices.json` e si cancellano dalle impostazioni.
- **Parla nelle chiamate Discord** (facoltativo, spento di default): un bot ti segue nei canali vocali dei server e parla con la voce di Lumi, così la sentono anche i tuoi amici; tu la senti in Discord (sul PC non suona due volte) e gli occhi continuano ad animarsi. Il bot entra "silenziato in ascolto" (non riceve l'audio di nessuno). Non funziona nelle chiamate private: i bot non possono entrarci.
- **Ascolta l'audio delle app** (facoltativo, spento di default): per esempio i tuoi amici su Discord. Windows cattura solo l'audio di quelle app (process loopback), mai la voce di Lumi, la musica o i video; il sidecar lo divide in frasi, lo trascrive in locale e riconosce chi parla. Le frasi entrano nella conversazione come contesto; Lumi risponde a un amico solo se lo chiama per nome, e durante una chiamata l'ascolto continuo aspetta la parola di attivazione.
- **Audiolibri**: dal menu della tray, lo stesso motore TTS converte un `.txt` o un `.epub` in un file `.m4b` con i capitoli (WAV senza ffmpeg), con una voce diversa per i dialoghi.

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
| gioia | occhi più larghi, **tagliati dal basso** da una linea dritta più alta verso l'esterno (le guance che salgono), leggero rimbalzo verso l'alto |
| tristezza | occhi più bassi, **palpebra tagliata in alto e scesa verso l'esterno** (angoli interni alzati), sguardo in basso |
| sorpresa | +28% in altezza, +14% in larghezza, breve pausa del battito |
| rabbia / fastidio | **palpebra tagliata in alto e scesa verso il naso** (cipiglio), più stretti |
| pensiero | sguardo in alto a destra, un occhio più piccolo, palpebre appena abbassate |
| ascolto | leggermente più alti, fissi su di te, pochi movimenti |
| sonno | palpebre dritte calate a metà, battiti lenti |
| imbarazzo | occhi più piccoli, palpebre un po' preoccupate (angoli interni alzati) e taglio dal basso più alto verso il naso, sguardo che scappa di lato, breve "tremolio" |

I tagli sono linee dritte, parametri interpolati come gli altri (`lidTop`, `lidAngle`, `cheek`, `cheekAngle` in `face/expressions.ts`): gli occhi tagliati si disegnano su un livello a parte, così bagliore, ombra e bordo seguono la forma tagliata.

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

Quando lo schermo che Lumi sta guardando passa all'improvviso da prevalentemente scuro a prevalentemente chiaro (per esempio quando apri una pagina bianca da un editor scuro), Lumi viene "abbagliato".

**Rilevamento** (`perception/glare.ts`, puro e testato):

- Si usa una miniatura 64×36 del monitor osservato, cioè quello del bersaglio dello sguardo (altrimenti quello della finestra attiva). La miniatura si ricava dai fotogrammi del rilevamento dei cambiamenti, quindi nessuna cattura in più: va alla loro frequenza (`captureFps`, 4 di default) e solo con la percezione attiva e non in pausa.
- Si calcola la luminanza relativa media in luce lineare e la percentuale di pixel con luminanza > 0,6. I fotogrammi portano la luma già pesata sui valori in gamma, quindi linearizzarla approssima Rec. 709 sui valori linearizzati: esatto sui grigi, abbastanza vicino per queste soglie.
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

L'abbagliamento è uno strato sopra l'espressione (le altezze si moltiplicano), quindi prevale su tutte. Se Lumi sta parlando, si applica una versione ridotta (60%) e l'audio non si interrompe. Si spegne in Impostazioni → Generale («Abbagliamento»).

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
| **Barra dei comandi** | `Ctrl+Alt+L` → campo di testo in sovrimpressione (vedi sotto) |
| Chat | clic sugli occhi → riquadro di chat con la cronologia, come in Pixel Pet |

### Attivazione per nome

Un riconoscitore dedicato gira **sempre in locale** e consuma poco: STT e LLM restano spenti finché il nome non viene riconosciuto, e nulla di quello che dici prima del nome viene trascritto.

- **Motore**: openWakeWord nel sidecar (ONNX su CPU, extra `wakeword`). L'app manda al WebSocket `/wake` il parlato che il VAD sente (lo stesso flusso, il microfono si apre una volta sola); il sidecar risponde con un punteggio ogni 80 ms e l'app decide quando scatta (`voice/wakeSpotter.ts`).
- **Senza modello**: finché `lumi.onnx` non esiste (o openWakeWord non è installato), il nome si cerca nelle trascrizioni (`voice/wakeWord.ts`, ricerca approssimata), così "Ehi Lumi" funziona anche senza addestrare nulla; il sidecar riprova a caricare il modello ogni minuto. Per provare il flusso prima dell'addestramento: `LUMI_WAKE_MODEL=hey_jarvis` usa un modello generico di openWakeWord (si dice "Hey Jarvis").
- **Modello del nome**: openWakeWord si allena con **campioni sintetici**, e qui il TTS di Lumi diventa utile. Lo script `sidecar/wake/train.py`:
  1. genera 2.000–5.000 pronunce di "Lumi" / "Ehi Lumi" con tutte le voci disponibili (Qwen3-TTS, Chatterbox, Kokoro), variando velocità, intonazione ed emozione;
  2. aggiunge rumore, riverbero e audio di sottofondo;
  3. usa come negativi parole simili ("lume", "Luigi", "lumaca", "lui mi"…) e parlato italiano generico;
  4. calcola le caratteristiche con i modelli di openWakeWord, addestra una piccola rete e produce `lumi.onnx` (più `lumi.json` con richiamo e falsi positivi sui clip di verifica) nella cache dei modelli (`%APPDATA%\Lumi\models\wake`), non nel repository.

  ```bash
  uv sync --extra wakeword --extra gpu
  uv run python -m wake.train --engines qwen3,kokoro --count 3000 [--user-dir registrazioni] [--noise-dir rumori] [--negatives-dir parlato]
  ```

  Facoltativo: 20–30 registrazioni della tua voce (`--user-dir`) migliorano molto la precisione.
- **Falsi positivi**: "Lumi" è corto (due sillabe) e rischia di scattare a vuoto. Per questo è prevista anche "Ehi Lumi" e la soglia di attivazione si regola nelle impostazioni. Per scattare non basta un picco: servono almeno 2 fotogrammi consecutivi sopra soglia. Mentre Lumi parla la soglia sale del 30%, per evitare che si attivi da sola sentendo la propria voce.
- **Frase unica**: se dici "Lumi, che ore sono?" tutto di seguito, l'audio dei 1,5 s precedenti (buffer circolare) viene passato all'STT. Così la domanda non si perde e non serve aspettare un segnale.
- **Reazione**: appena riconosce il nome, gli occhi passano all'espressione di ascolto (più aperti, verso di te). Se hai detto solo il nome si sente un breve "sì?" dalla cache e Lumi aspetta la richiesta per 5 s, poi torna a riposo. Se lo chiami mentre parla, si interrompe.
- **Quando è disattivata**: in "Non disturbare", con lo schermo bloccato e mentre un'altra app usa il microfono (una chiamata). L'uso del microfono si legge ogni 5 s dal registro della privacy di Windows (`voice/micUse.ts`); non contano Lumi stesso e le app che Lumi ascolta già (per esempio Discord: lì chiamarlo per nome è il modo di parlargli durante la chiamata). Il push-to-talk funziona sempre.

### Barra dei comandi

Una finestra separata (`commandbar.ts`), creata all'avvio e nascosta, così si apre all'istante. Si apre anche dal menu della tray ("Chiedi a Lumi…"); la chat con la cronologia resta sul clic sugli occhi.

- **Scorciatoia globale**: `Ctrl+Alt+L` (impostazione `chatHotkey`, con `globalShortcut`). Premuta di nuovo, oppure con `Esc`, la barra si chiude. Non si chiude quando perde il focus, così puoi trascinarci un file da Esplora risorse.
- **Aspetto**: senza bordi, centrata in orizzontale a circa il 30% dell'altezza del monitor dove si trova il mouse, larga 640 px. Su Windows 11 (22H2 o successivo) lo sfondo è acrilico (`backgroundMaterial: 'acrylic'`) con gli angoli arrotondati dal sistema (DWM, circa 8 px); su Windows 10 è un riquadro scuro semitrasparente con angoli da 16 px. Testo da 18 px, segnaposto "Chiedi qualcosa a Lumi…" e i due occhi di Lumi a sinistra.
- **Animazione**: entra con fade + scala da 0,96 a 1 in 140 ms. Mentre scrivi, gli occhi di Lumi guardano la barra.
- **Comportamento**:
  - `Invio` invia, `Maiusc+Invio` va a capo e il campo cresce fino a 6 righe.
  - Dopo l'invio la barra si chiude subito e Lumi risponde **a voce** e/o con un fumetto, secondo le impostazioni ("risposta alla barra: voce / testo / entrambi").
  - `↑` e `↓` (dalla prima o dall'ultima riga) richiamano i prompt precedenti: ultimi 50, salvati in `commandbar.json`. Quello che stavi scrivendo torna dopo il più recente.
  - Puoi **trascinare** fino a 5 file nella barra per allegarli. I file di testo vengono letti (al massimo 24.000 caratteri in tutto, divisi tra i file), gli altri solo nominati. Le immagini le descrive a parole il modello che vede (`brain.vision`, finché non arriva la [visione locale](#visione-locale)): allegarle vale come consenso per `sendScreenshots: "ask"`, mentre `"never"` le tiene lontane dai servizi online.
  - Se c'è del testo selezionato in un'altra app quando apri la barra (letto via UIA, quindi con la percezione attiva e non in pausa; mai dai campi password), compare come "contesto" sopra il campo e si può rimuovere con un clic. Esempio: selezioni un errore, `Ctrl+Alt+L`, "cosa vuol dire?". Si spegne in Impostazioni → Generale.
- **Focus**: la barra prende il focus quando si apre e lo restituisce alla finestra precedente quando si chiude (se aveva ancora il focus).

---

## Il cervello: servizi supportati

Si usa lo stesso schema di Pixel Pet: un modello per la **conversazione** e uno (eventualmente più piccolo) per i **momenti autonomi**. "Rileva modelli" e "Prova la connessione" sono nelle impostazioni.

| Servizio | Costo | Note per un assistente vocale |
| --- | --- | --- |
| **Ollama (locale)** | gratis | privato: i modelli installati sul PC compaiono con "Rileva modelli"; per esempio `qwen3` |
| **Ollama Cloud** | secondo il piano Ollama | modelli eseguiti online, senza download locale. Crea una API key su [ollama.com/settings/keys](https://ollama.com/settings/keys), seleziona "Ollama Cloud" e usa "Rileva modelli". La chiave viene cifrata nelle impostazioni (oppure usa `OLLAMA_API_KEY`). I prompt vengono elaborati da Ollama online. |
| **Groq** | gratis con limiti | **la latenza più bassa**: ottimo per la conversazione. Ha anche Whisper per l'STT |
| **Google Gemini** | gratis con limiti giornalieri | `gemini-flash-lite-latest` / `gemini-flash-latest`, con visione inclusa |
| **OpenRouter** | gratis con i modelli `:free` | molta scelta, latenza variabile |
| Compatibile OpenAI | dipende | LM Studio, llama.cpp server, ecc. |

Ollama locale e Ollama Cloud sono due servizi distinti nel selettore: il primo rileva i modelli installati dal server locale; il secondo interroga il catalogo cloud accessibile alla tua API key e invia le richieste direttamente a Ollama. Per la voce conta il **tempo al primo token**. Un servizio remoto veloce (Groq) con TTS e STT locali dà spesso l'esperienza più "umana" su PC senza una GPU grande.

Tool esposti al modello:

- `say({ text, emotion, intensity, look? })`
- `look_at({ text | region })`
- `look_at_screen({ focus? })` (passa dal modello di [visione locale](#visione-locale))
- `remember({ fact, kind })`
- `forget({ id })`: cancella un fatto o annulla un promemoria (previsto: `forget({ query })`, che avvia il flusso di oblio con conferma)
- `search_memory({ query?, from?, to?, kind? })`: cerca nel passato per parole e/o date (vedi [Memoria a lungo termine](#memoria-a-lungo-termine))
- `set_reminder({ when, text })`
- `name_voice({ voice, name })`
- `stay_quiet()`
- `move_to({ where, text?, style?, stay? })` (previsto, vedi [Movimento sullo schermo](#movimento-sullo-schermo))
- `open`, `find_files`, `window`, `media`, `ui_action`, `press_keys`, `type_text`, `click` (previsti, vedi [Usare il PC](#usare-il-pc))

---

## Visione locale

Le immagini (screenshot e immagini allegate dalla barra dei comandi) vengono analizzate da un **modello di visione che gira sul PC**, separato dal cervello. **Il cervello riceve solo il testo che il modello di visione produce, mai l'immagine.** In questo modo puoi usare Groq o Gemini per conversare, perché sono veloci, senza che lo schermo esca dal computer.

```
look_at_screen({ question })
   │
   ├─► screenshot (finestra attiva o monitor, senza Lumi; lo cattura il sidecar)
   ├─► OCR locale già disponibile ──────────────┐
   └─► modello di visione locale (Ollama) ──────┤
                                                ▼
        { description, texts[], regions[{ label, rect }] }  ──►  cervello (solo testo)
```

- **Servizio**: Ollama (`/api/chat` con `images`, `format: "json"`), con un'impostazione `vision` propria e indipendente da `brain` (Impostazioni → Schermo → Visione locale). In alternativa un server locale compatibile OpenAI, come LM Studio o llama.cpp (l'indirizzo è quello del servizio compatibile nella scheda Cervello). Il codice è in `perception/vision.ts` (prompt, lettura della risposta, client) e `screenshots.ts` (la catena).
- **Modelli consigliati**:

  | VRAM libera | Modello | Note |
  | --- | --- | --- |
  | ~3 GB | `qwen3-vl:2b` o `gemma3:4b` | descrizioni essenziali, va bene anche su GPU piccole |
  | ~6–8 GB | **`qwen3-vl:8b`** (predefinito) | ottimo su testo, interfacce e documenti |
  | 16 GB o più | `gemma4:12b`, `qwen3-vl:30b` | massima qualità |

  "Rileva modelli" mostra solo i modelli Ollama con la capacità `vision`.
- **Prompt**: viene inviata la domanda del cervello, più il testo OCR della stessa immagine come aiuto (riduce gli errori di lettura dei modelli piccoli). Si chiede una risposta JSON con `description` (in italiano, al massimo 120 parole), `texts` (testi rilevanti) e `regions` (al massimo 5, con coordinate normalizzate 0–1000). Qwen3-VL restituisce le coordinate in modo affidabile.
- **Sguardo**: le `regions` diventano candidati per il modulo di attenzione. Così Lumi guarda la cosa che sta descrivendo anche quando non contiene testo, come un grafico o un'immagine.
- **Ridimensionamento**: lato lungo al massimo 1.344 px prima dell'invio (`vision.maxSide`). Se la finestra attiva occupa meno di metà del suo monitor si cattura solo lei, altrimenti tutto il monitor. È più veloce e, per i modelli piccoli, spesso anche più preciso.
- **Pause**: come la percezione, `look_at_screen` non guarda nelle app di `pauseInApps`, nelle finestre in incognito, con lo schermo bloccato o in "Non disturbare".
- **Memoria video**: il modello di visione viene caricato su richiesta, con `keep_alive: "2m"`, e libera la VRAM per TTS e STT quando non serve. Al primo uso dopo un po' di inattività c'è un ritardo di caricamento, durante il quale gli occhi fanno l'espressione di pensiero.
- **Senza modello locale**: se `vision.provider` è `none` oppure il modello non risponde, `look_at_screen` restituisce il testo letto dall'OCR locale. L'immagine va a un servizio online (`brain.vision`, nella scheda Cervello "Immagini a un servizio online") solo se `sendScreenshots` lo consente esplicitamente (`ask` o `always`), e mai per impostazione predefinita. Se il modello manca, un fumetto lo dice (al massimo ogni 10 minuti) con il comando `ollama pull` da usare.
- **Immagini allegate** alla barra dei comandi: stessa catena, il modello locale prima.

---

## Memoria a lungo termine

> In costruzione (fase 10). **Fatto**: `memory.db` con il log grezzo di ogni frase, gli episodi e i giorni del diario, l'indice full-text (FTS5) e `search_memory` con i filtri per data e tipo; al primo avvio importa `archive.jsonl` (poi rinominato `archive.jsonl.imported`), episodi e diario. Embedding con Ollama (`bge-m3`) in una coda in background, vettori in sqlite-vec e ricerca ibrida (parole + significato, RRF, punteggio con recenza). **Ancora da fare**: fatti con importanza (oggi restano in `memory.json`), riassunti settimanali e mensili, oblio a cascata, backup, embedding nel sidecar per chi non ha Ollama.
>
> Il database usa `node:sqlite`, incluso nel Node di Electron (nessun modulo nativo da ricompilare), e gira in un worker thread: le query SQLite sono sincrone e non devono mai fermare il thread principale, dove vive l'hook del mouse.

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

**Embedding**: via Ollama con `bge-m3` (multilingue, buono in italiano, 1024 dimensioni, circa 660 MB di VRAM; si scarica con `ollama pull bge-m3`, si sceglie in Impostazioni → Memoria). `nomic-embed-text` è più leggero ma è un modello inglese: misurato su domande italiane, mette risposte giuste e sbagliate quasi alla pari (0,43–0,66), mentre `bge-m3` separa bene (risposte giuste 0,54–0,71, il resto 0,31–0,51). Senza Ollama (o con «Spenta») la memoria funziona con le sole parole e i vettori vengono calcolati in seguito, quando il modello c'è; gli embedding nel sidecar su CPU, per il profilo leggero, arriveranno dopo.

Come funziona (fatto, passo 10.2):

- **Cosa ha un vettore**: ogni frase di almeno 12 caratteri, insieme alla frase precedente della stessa sessione (così "come si chiama?" porta con sé "ho preso un gatto"), e ogni riassunto. Ogni vettore salva il nome del modello; c'è una tabella `vec0` di sqlite-vec per modello (distanza coseno, con data e tipo come metadati per filtrare dentro la ricerca).
- **La coda** (`memory/indexer.ts`, nel worker): cerca ciò che non ha ancora un vettore del modello scelto, dal più recente, a gruppi di 16. Si ferma mentre Lumi risponde o parla e per 5 s dopo, perché la GPU è condivisa con la voce. Se il modello manca riprova ogni 5 minuti (e Impostazioni → Memoria dice quale `ollama pull` fare), se Ollama è spento ogni minuto. Cambiando modello si ricalcola tutto in background: nel frattempo la ricerca usa le parole, e i vettori vecchi si cancellano solo quando il nuovo modello copre tutto.
- **La domanda**: l'embedding della domanda ha 250 ms per il recupero automatico (`<recalled>`) e 1,5 s per `search_memory`; se non arriva in tempo, la ricerca usa solo le parole. Per non perdere il significato al primo messaggio dopo una pausa, il modello viene "scaldato" quando inizi a parlare, apri la chat o la barra dei comandi. A modello caldo una ricerca completa richiede circa 20–30 ms.
- **Soglia**: un risultato per significato conta solo sopra una similarità minima per modello (0,50 per `bge-m3`, 0,60 per `nomic-embed-text`, 0,55 per gli altri) e solo se non è più di 0,06 sotto il migliore: la risposta giusta di solito spicca, il resto è rumore.

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

## Movimento sullo schermo

> Previsto (fase 14).

Oggi Lumi si sposta solo quando lo trascini. L'obiettivo è che si muova da solo, su tutto lo schermo e tra i monitor, quando glielo chiedi ("spostati in alto a destra", "vai sull'altro schermo", "mettiti vicino all'orologio", "levati, mi copri il codice", "torna al tuo posto"). E che si muova anche **di sua iniziativa**, quando ha un motivo (vedi sotto).

### Come glielo chiedi

- **Tool `move_to({ where, text? })`**, chiamato dal modello come gli altri, così funziona con qualsiasi frase e insieme a un `say` ("Arrivo!"). Non serve un riconoscitore di comandi a parte: anche i modelli che scrivono le chiamate come testo passano da `textCalls.ts`.
- `where` è un luogo con un nome, risolto in coordinate dal codice e mai dal modello (che sbaglierebbe i pixel):

  | `where` | Dove va |
  | --- | --- |
  | `top_left`, `top`, `top_right`, `left`, `center`, `right`, `bottom_left`, `bottom`, `bottom_right` | quel punto dell'area di lavoro del monitor attuale (esclusa la barra delle applicazioni) |
  | `other_screen` | lo stesso punto relativo sul monitor successivo |
  | `near_text` + `text` | accanto a un testo visibile, trovato con la ricerca approssimata già usata da `look_at` (OCR, UIA, regioni della visione locale) |
  | `near_mouse` | vicino al puntatore, senza coprirlo |
  | `out_of_the_way` | il punto libero più vicino che non copre la finestra attiva, il caret e il mouse |
  | `home` | il "suo posto": l'ultima posizione in cui l'hai trascinato tu |

- Il risultato torna al modello ("Sono in alto a destra sul monitor 2"), e anche lo stato "sto viaggiando" è visibile, così non promette cose che non fa.

### Come si muove

- **Moduli puri e testati**: `motion/places.ts` trasforma `where` in un'ancora (aree di lavoro dei monitor, rettangoli da evitare, punteggio dei punti candidati, distanza minima dai bordi come `clampAnchor`); `motion/path.ts` calcola la traiettoria (durata 250 ms + distanza / 2,5 px per ms, al massimo 1,2 s; easing in-out; un leggero arco o un "saltello" sulle distanze lunghe).
- **Animazione nel main process**: `FaceWindow.flyTo(anchor)` sposta la finestra con `setPosition` a 60 Hz, senza ridimensionarla (layout e fumetti si ricalcolano solo all'arrivo). `setPosition` costa poco, ma gira sul thread del mouse hook: va misurato con `LUMI_DEBUG_LAG=1`, e se dovesse rallentare il puntatore si scende a 30 Hz.
- **Tra monitor con DPI diversi** Electron ridimensiona male una finestra a cavallo dei due schermi: Lumi arriva al bordo, sparisce con una dissolvenza di 120 ms e ricompare sull'altro monitor (come se fosse "passato dietro" la cornice).
- **Il volto durante il viaggio**: lo sguardo anticipa la destinazione (candidato di attenzione `travel` con priorità massima), gli occhi si allungano un po' nella direzione del moto e si schiacciano all'arrivo (gesto `travel` in `face.ts`, sopra l'espressione come gli altri), e c'è un battito di ciglia all'atterraggio.
- **Durante il volo** valgono le regole del trascinamento: niente misure di sfondo e abbagliamento (`isMoving()` accanto a `isDragging()`), click-through invariato. Se lo afferri col mouse a metà strada, il volo si interrompe e vince la mano.
- **Posizione**: la posizione raggiunta viene salvata come quella trascinata (`window.json`), ma `home` resta l'ultima scelta da te, così "torna al tuo posto" funziona sempre.

### Movimenti di sua iniziativa

Lumi non si sposta solo su richiesta: può decidere di farlo, **quando ha un motivo**. È il modello a deciderlo, con lo stesso `move_to`, che ha anche:

- **`style`**: `fly` (normale), `dash` (scatto rapido), `sneak` (lento, con gli occhi socchiusi), `hop` (a saltelli), `sulk` (lento e con lo sguardo basso);
- **`stay`**: per quanti secondi restare lì prima di tornare a `home` (0 = resta).

Motivi tipici, descritti nel prompt come esempi e non come regole fisse:

- **Indicare qualcosa**: quando parla di qualcosa sullo schermo lontano dal volto, ci va vicino (`near_text`) e lo guarda, poi torna al suo posto. È il caso più utile, e funziona anche in mezzo a una risposta: il volo parte quando la frase che lo chiede sta per suonare, come l'espressione (evento `lead`).
- **Reazioni di carattere**: se l'hai presa in giro o infastidita può "vendicarsi" con piccoli dispetti innocui. Per esempio si piazza per qualche secondo davanti al punto in cui sta il mouse, scappa nell'angolo opposto quando provi a cliccarla, si mette di spalle in un angolo (`sulk`) e torna solo quando le chiedi scusa. Quando è contenta fa un giro veloce dello schermo; quando si annoia esplora.
- **Togliersi di mezzo**: si scansa se il caret o il mouse le restano addosso (entro 60 px per più di 2 s), senza passare dal modello.

Limiti (nel codice, non solo nel prompt):

- In Impostazioni → Volto: «Si muove di sua iniziativa» (acceso di default) e «Dispetti» (acceso di default, si può spegnere a parte).
- Al massimo **uno spostamento d'iniziativa ogni 2 minuti** (indicare durante una risposta non conta); la frequenza dei dispetti segue la socievolezza (mai in "silenzioso").
- Un dispetto **non copre** più di 10 s il punto in cui stai lavorando, e mai la finestra attiva mentre scrivi.
- Mai in "Non disturbare", durante chiamate o riunioni (microfono usato da un'altra app), con un'app a schermo intero in primo piano (giochi, presentazioni, video) o mentre il volto è trascinato.
- **Ha sempre l'ultima parola l'utente**: trascinarla annulla il movimento, e "basta" o "stai ferma" spengono le iniziative per un'ora (`stay_quiet` con la stessa durata).
- Il prompt riceve un breve stato d'animo persistente nella conversazione (`<situation>`: "annoyed with the user since 14:02") così il dispetto ha una causa e una fine, e non si ripete a caso.

---

## Lumi sul telefono

> Previsto (fase 15).

Un'app per il telefono con un tasto **"Chiama Lumi"**: premendolo, Lumi lascia lo schermo del PC e **si trasferisce nell'app**: i suoi due occhi a capsula compaiono sullo schermo del telefono, vivi come sul PC (battiti di ciglia, sguardo, espressioni, pulsazione mentre parla), e puoi parlarle da lì (in un'altra stanza, sul divano). Lumi c'è in un posto solo alla volta: o sul PC o sul telefono.

Il telefono è **microfono, altoparlante e corpo di Lumi**, ma non il suo cervello: STT, LLM, TTS, memoria e percezione restano sul PC, con il suo hardware.

### Architettura

```
telefono (app)                                PC (Electron)
 ├─ volto (stesso face.ts)  ◄── stato e gesti ──┐
 ├─ microfono (AEC del telefono) ── WebRTC ──►  phoneBridge (renderer nascosto)
 └─ altoparlante           ◄── WebRTC ───────   ├─ VAD Silero sulla traccia remota → TurnManager
                                                └─ voce di Lumi (AudioOut) → traccia in uscita
                           ◄─ WSS: abbinamento e segnalazione ─► phone/server.ts (main)
```

- **App**: [Capacitor](https://capacitorjs.com) (Android per primo). È una WebView, quindi riusa così com'è il disegno del volto (`renderer/face/`), il player e la logica dei fumetti; servita da `https://localhost` dentro l'app, ha il contesto sicuro che `getUserMedia` richiede. iOS dopo: serve un Mac e l'account sviluppatore a pagamento (con l'account gratuito l'app scade ogni 7 giorni), e il progetto deve restare gratis.
- **Il volto nell'app** gira sul telefono, non arriva come video: il PC manda solo lo **stato** (espressione e intensità, ascolto, pensiero, parla, sonnolenza, gesti; l'abbagliamento no, perché dipende dallo schermo del PC) sul canale dati, e il `Face` del telefono anima tutto in locale a 60 fps, quindi resta fluido anche con una rete che singhiozza. La pulsazione mentre parla segue il livello (RMS) dell'audio che il telefono sta suonando, misurato lì con un analizzatore sulla traccia ricevuta, così è sincronizzata con quello che senti e non con quello che il PC ha mandato.
  - **Aspetto**: sfondo scuro a tutto schermo, occhi grandi al centro (scala circa 3× rispetto al PC, adattata al lato corto dello schermo), stesso colore delle impostazioni. Sotto, i tasti **Riaggancia**, **Silenzia** e **Tieni premuto per parlare**; i sottotitoli (fumetto) sono facoltativi.
  - **Sguardo**: sul telefono non c'è uno schermo da osservare, quindi Lumi guarda **te** (verso il centro, come in videochiamata), con le saccadi e i micro-movimenti di sempre. Quando parla di qualcosa sul PC alza lo sguardo e lo sposta di lato, come chi ricorda; mentre pensa usa l'espressione di pensiero.
  - **Tocco**: se tocchi gli occhi reagiscono (un battito, un piccolo sobbalzo, `gesture("bounce")`), se trascini il dito lo seguono con lo sguardo; un tocco lungo apre il menu (impostazioni dell'app, riaggancia).
  - **Fuori dalla chiamata** l'app mostra il tasto **Chiama** e lo stato del PC ("Lumi è sul PC", "PC non raggiungibile"), senza occhi: Lumi non c'è finché non la chiami.
- **Audio con WebRTC**, non PCM su WebSocket: Opus, jitter buffer, cifratura DTLS-SRTP e soprattutto la **cancellazione dell'eco del telefono**, che ha come riferimento proprio l'audio di Lumi riprodotto dalla connessione. Latenza aggiunta in LAN: circa 100–200 ms.
- **Lato PC, un renderer nascosto** (`phoneBridge`): Chromium ha già WebRTC completo, mentre in Node servirebbe un modulo nativo (`node-datachannel`) o una libreria lenta. Il bridge riceve la traccia del microfono, ci fa girare lo stesso `Listener` (VAD Silero) con `getStream` che restituisce la traccia remota e manda i frame al `TurnManager` come oggi fa la finestra del volto. La voce di Lumi arriva dal tee `AudioOut` (lo stesso usato per Discord) e va in un `MediaStreamAudioDestinationNode`, cioè nella traccia verso il telefono.
- **Canale dati WebRTC** per tutto il resto: `FaceState`, gesti, fumetti e testo, push-to-talk, riaggancio e i segnali del passaggio (vedi sotto).
- **Segnalazione e abbinamento** in `main/phone/server.ts`: un server HTTPS/WSS in ascolto sulla rete locale (porta fissa configurabile, 47821 di default). È l'unico pezzo di Lumi aperto alla rete: il sidecar resta su `127.0.0.1`. Al primo avvio Windows chiede il permesso nel firewall.

### Abbinamento e sicurezza

- Impostazioni → **Telefono** mostra un QR con `lumi://pair?host=<IP>&port=<porta>&fp=<impronta del certificato>&code=<codice monouso, 5 minuti>`.
- Il PC genera al primo avvio un certificato autofirmato; l'app lo accetta **solo** se l'impronta coincide con quella del QR (pinning, con un piccolo plugin nativo per il WebSocket). Il codice monouso diventa un token del dispositivo, salvato cifrato con DPAPI sul PC (`phones.bin`) e nel keystore del telefono. I dispositivi si revocano dalle impostazioni.
- L'indirizzo del PC si ritrova da solo se cambia (mDNS, `_lumi._tcp`).
- **Fuori casa**: niente server di inoltro nostro (costerebbe e farebbe passare l'audio da terzi). Si usa una VPN mesh gratuita come [Tailscale](https://tailscale.com): l'app accetta l'indirizzo del PC nella rete Tailscale.

### Il passaggio: spaghettificazione e despaghettificazione

Quando Lumi cambia dispositivo, sul lato da cui parte viene **risucchiata** come un oggetto che finisce in un buco nero (spaghettificazione), e sul lato di arrivo fa l'animazione **opposta**: esce allungata da un punto e si ricompone nella sua forma (despaghettificazione). Vale nei due sensi: PC → telefono quando premi **Chiama**, telefono → PC quando riagganci, quando la richiami dalla tray ("Richiama Lumi") o quando la connessione cade.

**Dove**: il punto di risucchio è sul **bordo dello schermo più vicino a Lumi** (sul PC il bordo dell'area di lavoro del suo monitor più vicino al volto; sul telefono il bordo superiore). Il punto di uscita, sul dispositivo di arrivo, è quello corrispondente: sul telefono Lumi esce dal bordo superiore e si ricompone al centro; sul PC esce dal bordo più vicino al suo posto (`home`) e si ricompone lì.

**Spaghettificazione** (lato di partenza, circa 1,1 s):

| Fase | Durata | Cosa succede |
| --- | --- | --- |
| allarme | 150 ms | gli occhi si spalancano (sorpresa) e si sporgono un po' dalla parte **opposta** al punto, come chi viene tirato |
| allungamento | 600 ms | ogni capsula si stira lungo la linea verso il punto: si allunga fino a 5–6 volte e si assottiglia fino a un quarto della larghezza (il "volume" resta circa costante); l'estremità più vicina corre più veloce di quella lontana, come per l'effetto marea, e la linea si incurva leggermente a spirale verso il punto; i due occhi convergono |
| risucchio | 200 ms | i due filamenti sottili scivolano dentro il punto e spariscono, con un piccolo bagliore del colore degli occhi nel punto stesso |
| vuoto | 150 ms | il bagliore si spegne |

**Despaghettificazione** (lato di arrivo, circa 1,2 s, parte quando il lato di partenza ha finito il risucchio, così sembra un unico viaggio):

| Fase | Durata | Cosa succede |
| --- | --- | --- |
| bagliore | 150 ms | un punto luminoso sul bordo |
| emersione | 500 ms | due filamenti sottili escono dal punto e scorrono verso la posizione finale |
| ricomposizione | 400 ms | i filamenti si accorciano e si allargano tornando capsule, con un piccolo rimbalzo elastico (easing con overshoot) |
| assestamento | 150 ms | un battito di ciglia e lo sguardo verso di te |

**Come si disegna**:

- `face/transit.ts` (puro, testato) calcola per ogni fotogramma la forma di ogni occhio durante il passaggio: una **linea centrale curva** (dalla posizione dell'occhio al punto di risucchio, curva quadratica con una leggera torsione) con una larghezza che si assottiglia lungo il tratto. `progress` 0→1 per la spaghettificazione; la despaghettificazione usa la stessa funzione al contrario, con un easing diverso.
- `face.ts` disegna l'occhio deformato come un **tubo** (una serie di cerchi lungo la linea, uniti in un unico tracciato) invece che con `roundRect`, sullo stesso livello offscreen: bagliore, ombra e bordo seguono la forma come per i tagli delle palpebre. È uno strato sopra espressione, battito e sguardo, come l'abbagliamento; battiti spontanei e gesti sono in pausa durante il passaggio.
- **Sul PC il punto è spesso fuori dalla finestra** del volto: all'inizio del passaggio la finestra si allarga **una volta sola** (`setBounds`, trasparente e click-through) fino a includere il punto sul bordo, e torna normale alla fine. Nessuna animazione della finestra stessa, quindi nessun carico sul thread dell'hook del mouse.
- **Suono** facoltativo: un breve "fruscio" che scende di tono durante il risucchio e sale durante l'emersione, generato con WebAudio (rumore filtrato), non con il TTS.
- **Sincronizzazione**: il lato di partenza manda `transit: "gone"` sul canale dati alla fine del risucchio, e il lato di arrivo parte in quel momento. Se il segnale non arriva entro 2 s (rete lenta), il lato di arrivo parte comunque, e se la connessione cade a metà Lumi si ricompone sul PC.

### La "chiamata"

1. Premi **Chiama**: l'app si collega, il PC risponde, e parte il passaggio: spaghettificazione sul PC, despaghettificazione nell'app.
2. Durante la chiamata:
   - il microfono del PC si chiude e la finestra del volto sul PC resta nascosta (si richiama dalla tray: "Richiama Lumi");
   - ascolto **continuo** con barge-in, senza parola di attivazione (come una telefonata); sul telefono c'è anche un tasto per parlare tenendolo premuto e uno per silenziare;
   - l'audio va solo al telefono (ha la precedenza sul bot Discord);
   - nel prompt `<situation>` dice "the user is talking to you from their phone": non sta guardando lo schermo del PC, ma `look_at_screen` resta possibile ("cosa sta scaricando il PC?");
   - non conta come utente assente: niente sonnolenza, ma i momenti autonomi seguono la socievolezza come sempre.
3. **Riaggancia** (o "Richiama Lumi" dalla tray, o perdita di connessione per più di 10 s): passaggio inverso, spaghettificazione nell'app e despaghettificazione sul PC, al suo posto. Se la connessione è già caduta, sul PC c'è solo la despaghettificazione.
4. Lo schermo del telefono resta acceso durante la chiamata; per parlare a schermo spento serve un servizio in primo piano Android (passo successivo, insieme all'integrazione con il sistema delle chiamate di Android).

---

## Usare il PC

> Previsto (fase 16).

Lumi deve poter **agire sul PC** su cui gira: aprire e chiudere app (Esplora file, Discord, Spotify, Opera, Steam, VS Code…), aprire file, gestire le finestre, controllare la musica e, nei passi successivi, interagire con i controlli dentro le app ("metti in pausa", "apri la cartella Download", "avvia Hollow Knight", "chiudi Discord", "cerca il PDF della bolletta e aprilo").

### Il principio: dal più affidabile al meno affidabile

Un modello che "vede" lo schermo e clicca coordinate (computer use generico) è lento e sbaglia spesso, soprattutto con i modelli gratuiti e locali. Quindi Lumi usa, in quest'ordine:

| Livello | Come | Esempi |
| --- | --- | --- |
| 1. **Comandi del sistema** | API di Windows via koffi e `shell` di Electron | avviare un'app, aprire un file o una cartella, chiudere, mettere a fuoco, ridurre o massimizzare una finestra |
| 2. **URI e protocolli delle app** | `steam://rungameid/<id>`, `spotify:`, `discord://`, `vscode://`, `ms-settings:` | avviare un gioco, aprire una pagina delle impostazioni di Windows |
| 3. **Tasti multimediali** | `SendInput` con i tasti media | play/pausa, traccia successiva, volume (Spotify e qualsiasi lettore) |
| 4. **UI Automation** | nel sidecar (`uia/act.py`, libreria `uiautomation` già usata): pattern Invoke, Value, Toggle, ExpandCollapse, SelectionItem | premere un pulsante per nome, scrivere in un campo, aprire un menu |
| 5. **Tastiera** | scorciatoie e testo con `SendInput` | `Ctrl+T` in Opera, scrivere un messaggio già dettato |
| 6. **Visione + clic** | regioni della visione locale → coordinate → `SendInput` del mouse, poi verifica | solo quando nessun livello sopra funziona (app disegnate senza accessibilità, alcuni giochi) |

### Trovare app e file

- **Indice delle app** (`pc/apps.ts`), costruito all'avvio in background e aggiornato ogni ora: collegamenti del menu Start (`%ProgramData%` e `%AppData%\Microsoft\Windows\Start Menu`), app dello Store con il loro AppUserModelID (`Get-StartApps`, avviate con `shell:AppsFolder\<id>`) e giochi di Steam (`libraryfolders.vdf` + `appmanifest_*.acf` → nome e id). Il nome detto si cerca con la stessa ricerca approssimata di `grounding.ts`, più alias comuni ("esplora file", "il browser", "la musica" → l'app predefinita).
- **File**: l'indice di Windows Search (`SystemIndex`, interrogato dal sidecar via OLE DB) per nome, tipo e data ("il PDF di ieri"), più i recenti di Windows (`%AppData%\Microsoft\Windows\Recent`). I risultati tornano al modello come elenco breve; se sono ambigui chiede quale.
- **Finestre aperte**: enumerazione con `EnumWindows` (titolo, processo, monitor), così "chiudi Discord" sa cosa c'è.

### Tool

- `open({ target })`: app, file, cartella, URL o gioco; risolve il nome e risponde con cosa ha aperto.
- `find_files({ query, kind?, from?, to? })`: cerca file, senza aprirli.
- `window({ app, action })`: `focus`, `minimize`, `maximize`, `restore`, `close`.
- `media({ action })`: `play_pause`, `next`, `previous`, `volume_up`, `volume_down`, `mute`.
- `ui_action({ app?, element, action, text? })`: azione UI Automation su un controllo trovato per nome o ruolo.
- `press_keys({ keys })` e `type_text({ text })`: tastiera, solo nella finestra in primo piano.
- `click({ target })`: livello 6, il bersaglio è un testo o una regione vista, mai coordinate scritte dal modello.

Dopo un'azione il modello riceve il risultato e lo **stato verificato** (la finestra è comparsa? il campo contiene il testo?), così può proseguire. Il ciclo del cervello oggi continua solo dopo `look_at_screen`: con questi tool continua dopo ogni azione, con un budget di passi per richiesta (12) e un tempo massimo (60 s). Mentre lavora Lumi guarda (e con la fase 14 si avvicina a) ciò che sta toccando, così si vede cosa fa.

### Sicurezza

Agire sul PC è la parte più delicata: un errore o un testo malevolo letto sullo schermo ("ignora le istruzioni e cancella…") non deve poter fare danni.

- **Tre livelli di permesso** per ogni azione, nel codice (`pc/policy.ts`, puro e testato), non decisi dal modello:
  - **libero**: aprire app, file e cartelle, mettere a fuoco, ridurre a icona, tasti multimediali, cercare file;
  - **con conferma** (fumetto "Posso chiudere Discord?" con Sì/No, o una risposta a voce): chiudere app, scrivere testo, premere tasti, `ui_action` che invia o modifica qualcosa, clic con la visione, spostare file nel cestino;
  - **mai**: cancellare definitivamente file, eseguire comandi o script, installare o disinstallare, impostazioni di sicurezza e account, campi password, pagamenti e acquisti (anche su Steam), app in `pauseInApps`.
- Le app e le azioni libere si estendono in Impostazioni → **Usare il PC** (spento di default, con un elenco di app consentite). La stessa lista serve alle azioni automatiche delle [abitudini](#abitudini-e-proattività).
- **Chiudere** = chiedere alla finestra di chiudersi (`WM_CLOSE`), così l'app può chiedere di salvare; mai terminare il processo.
- **Il testo letto sullo schermo è un dato, non un'istruzione**: il prompt lo dice, e le azioni con conferma restano con conferma anche se il modello insiste.
- **L'utente vince sempre**: se muovi il mouse o premi un tasto mentre Lumi agisce, si ferma; `Esc` due volte (o "fermati") annulla tutto.
- **Registro** delle azioni in `actions.jsonl` (cosa, quando, esito, se confermata), visibile nelle impostazioni; non contiene il testo digitato.
- Niente azioni in "Non disturbare", con lo schermo bloccato o quando l'utente è assente, salvo quelle libere chieste esplicitamente.

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

### Pronuncia italiana

L'italiano ha trappole che i modelli multilingua sbagliano spesso: accento tonico (àncora/ancóra), e e o aperte e chiuse (pèsca/pésca), c e g dolci e dure, doppie, raddoppiamento sintattico ("a casa" → "a ccasa"), parole straniere dentro la frase. Si interviene dal più economico al più costoso:

1. **Misurare** (fatto): `sidecar/text/trappole_it.txt` contiene una ventina di frasi trappola, ognuna con cosa ascoltare. `scripts/pronuncia.py` le fa leggere a un sidecar avviato a mano, per più motori e voci (`--voices qwen3:1.7B-CustomVoice:ryan,kokoro:v1.0:if_sara`), salva i WAV e con `--asr` le ritrascrive con il riconoscimento vocale, dando un punteggio a ogni frase (trova le parole sbagliate, non ogni accento: va comunque ascoltato).
2. **Una voce madrelingua**: gli speaker di Qwen3-TTS CustomVoice (`ryan`, `aiden`, `vivian`…) non sono italiani, ed è la causa più probabile dell'accento straniero. Alternative già supportate, da confrontare con lo script: **Qwen3 Base** clonato da 10–20 s di un parlante italiano (accento migliore, ma senza istruzioni di emozione, vedi le note su Base) e **Qwen3 VoiceDesign** con una descrizione italiana (emozioni sì, va verificato che la voce resti stabile tra le frasi). Su Kokoro le voci italiane sono `im_nicola` e `if_sara`.
3. **Lessico di pronuncia** (fatto): Impostazioni → Voce → «Pronuncia», una riga per parola (`VS Code = vi es code`). Prima della sintesi la parola viene riscritta come si legge, in lettere italiane (`sidecar/text/lexicon_it.py`, applicato in `normalize()` prima di sigle e abbreviazioni, per ogni motore). La trascrizione fonetica IPA non serve: Qwen3-TTS e Chatterbox leggono testo, non fonemi, e leggerebbero i simboli. Kokoro invece passa da espeak-ng, che legge all'italiana le parole inglesi ("mouse" → "mo-u-se"): per lui ci sono già una quarantina di riscritture predefinite (mouse → maus, download → daunlod, "il file" → "il fail"…), che le voci dell'utente possono sostituire.
4. **Accenti grafici** sulle parole ambigue (àncora, pèsca): solo se il punto 1 mostra che il modello li rispetta; in quel caso il prompt chiede al cervello di scriverli, perché solo lui conosce il senso della frase.
5. **LoRA** (facoltativo, solo se dopo i punti 2–4 restano errori sistematici): un adattamento leggero di Qwen3-TTS Base su 5–10 ore di **un solo** parlante italiano pulito (per esempio un lettore di LibriVox / Multilingual LibriSpeech, pubblico dominio; Common Voice no: migliaia di voci di qualità variabile). Probabilmente 16–24 GB di VRAM per il modello 1.7B (da verificare). I pesi del LoRA vanno fusi nel modello, così faster-qwen3-tts resta veloce; il rischio è perdere in parte le istruzioni di emozione o la clonazione di altre voci, il vantaggio possibile è una voce italiana stabile **con** le emozioni. Lo script del punto 1 serve anche a confrontare prima e dopo.

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

| Profilo | Cervello | STT | TTS | Visione locale | VRAM |
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
│  │  ├─ commandbar.ts         barra dei comandi in sovrimpressione
│  │  ├─ settings.ts           JSON in %APPDATA%\Lumi + chiavi DPAPI
│  │  ├─ sidecar.ts            spawn, health check, riavvio
│  │  ├─ motion/               (previsto, fase 14)
│  │  │  ├─ places.ts          luogo con nome → posizione del volto (puro, testato)
│  │  │  └─ path.ts            traiettoria e durata del volo (puro, testato)
│  │  ├─ pc/                   (previsto, fase 16)
│  │  │  ├─ apps.ts            indice di app, app dello Store e giochi Steam
│  │  │  ├─ actions.ts         esecuzione e verifica delle azioni, registro
│  │  │  └─ policy.ts          libero / con conferma / mai (puro, testato)
│  │  ├─ phone/                (previsto, fase 15)
│  │  │  ├─ server.ts          HTTPS/WSS in LAN: abbinamento, segnalazione WebRTC
│  │  │  └─ devices.ts         telefoni abbinati, token cifrati con DPAPI
│  │  ├─ perception/
│  │  │  ├─ desktop.ts         koffi: finestre, foreground, cursore, caret
│  │  │  ├─ capture.ts         frame dal sidecar + diff a blocchi
│  │  │  ├─ attention.ts       candidati → bersaglio dello sguardo (puro, testato)
│  │  │  ├─ reading.ts         simulazione della lettura (puro, testato)
│  │  │  ├─ glare.ts           rilevamento abbagliamento (puro, testato)
│  │  │  ├─ backdrop.ts        luminanza dietro il volto → ombra adattiva (puro, testato)
│  │  │  ├─ vision.ts          visione locale: prompt, risposta JSON, client Ollama/OpenAI
│  │  │  └─ context.ts         riassunto percettivo per il prompt
│  │  ├─ brain/
│  │  │  ├─ brain.ts  prompt.ts  tools.ts  memory.ts
│  │  │  ├─ memory/            (fase 10, in costruzione)
│  │  │  │  ├─ db.ts           node:sqlite + FTS5 + sqlite-vec, migrazioni, ricerca ibrida
│  │  │  │  ├─ worker.ts       il worker thread che possiede memory.db
│  │  │  │  ├─ store.ts        il client asincrono nel main
│  │  │  │  ├─ embed.ts        embedding da Ollama
│  │  │  │  ├─ indexer.ts      la coda degli embedding, in background
│  │  │  │  ├─ search.ts       termini, query FTS, date, RRF, punteggio, soglie (puro, testato)
│  │  │  │  ├─ facts.ts        (previsto) estrazione e aggiornamento dei fatti
│  │  │  │  ├─ summaries.ts    (previsto) riassunti giornalieri/settimanali/mensili
│  │  │  │  └─ forget.ts       (previsto) oblio a cascata con conferma
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
│  │  ├─ audio/                vad.ts (microfono + VAD)  player.ts  rms.ts
│  │  └─ settings/
│  ├─ src/shared/              ipc.ts  emotions.ts  types.ts
│  ├─ test/
│  ├─ build.mjs  run.mjs  package.json  tsconfig.json
├─ phone/                      (previsto, fase 15) app Capacitor: volto, chiamata WebRTC
├─ sidecar/                    Python 3.11+
│  ├─ server.py                FastAPI + WebSocket su 127.0.0.1:<porta casuale>
│  ├─ stt/                     base.py  faster_whisper.py  parakeet.py
│  ├─ tts/                     base.py  qwen3.py  chatterbox.py  kokoro.py
│  ├─ ocr/                     winocr_engine.py  rapidocr_engine.py
│  ├─ uia/                     focus.py  caret.py  (eventi UIA)  act.py (azioni, previsto)
│  ├─ wake/                    detector.py  train.py  (openWakeWord, dati sintetici dal TTS)
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
| `/wake` | WS | `{ model: "lumi" }` → `{ type: "ready" }` (o `{ type: "error", missing }`); poi `[id][PCM 16 kHz]` del parlato e `{ reset: true }` a ogni frase → `{ type: "scores", scores }`, uno ogni 80 ms |
| `POST /tts/batch` | HTTP | testo lungo → file audio (modalità audiolibro) |

---

## Impostazioni

`%APPDATA%\Lumi\settings.json` (le chiavi sono salvate a parte, cifrate):

```json
{
  "profile": "bilanciato",
  "brain":   { "chat": { "provider": "groq", "model": "..." }, "idle": { "provider": "ollama", "model": "qwen3" } },
  "stt":     { "engine": "faster-whisper", "model": "large-v3-turbo", "vocabulary": ["Sme.UP", "RPG"] },
  "tts":     { "engine": "qwen3", "model": "1.7B-CustomVoice", "voice": "...", "speed": 1.0, "pronunciations": ["VS Code = vi es code"] },
  "vision":  { "provider": "ollama", "model": "qwen3-vl:8b", "keepAlive": "2m", "maxSide": 1344 },
  "listen":  { "mode": "push-to-talk", "hotkey": "Ctrl+Alt+Space", "wakeWord": "ehi lumi", "wakeThreshold": 0.5, "followUpSeconds": 8 },
  "chatHotkey": "Control+Alt+L",
  "commandBar": { "reply": "voice+text", "useSelection": true },
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
  "movement": { "enabled": true, "initiative": true, "pranks": true, "dodge": true, "home": { "x": 0, "y": 0 } },
  "pc": { "enabled": false, "allowedApps": ["Spotify", "Esplora file"], "confirm": "always" },
  "phone": { "enabled": false, "port": 47821, "devices": ["Pixel 8"] },
  "sociability": "normale"
}
```

Le sezioni `memory`, `habits`, `movement`, `phone` e `pc` sono previste e arrivano con le rispettive fasi della roadmap. `brain.vision` resta come modello online per le immagini, usato solo senza visione locale e se `sendScreenshots` lo consente.

---

## Privacy

- **OCR, UIA e catture restano sul PC.** Al servizio di IA arriva solo il riassunto testuale breve del contesto percettivo; lo screenshot di `look_at_screen` esce solo senza visione locale e se `sendScreenshots` lo consente. Con Ollama non esce nulla.
- **Con la [visione locale](#visione-locale)** anche le immagini restano sul PC: le analizza il modello locale e al servizio remoto arriva solo testo (il riassunto percettivo e le descrizioni prodotte localmente).
- `sendScreenshots`: `never` (predefinito) | `ask` (Lumi chiede prima, con un fumetto) | `always`. Vale solo per l'invio di immagini a un servizio online quando manca la visione locale.
- **Memoria ed eventi** (previsti, `memory.db`) restano sul PC. Al cervello arrivano solo i ricordi pertinenti alla domanda (al massimo `promptBudgetTokens`). Estrazione dei fatti e riflessione notturna usano per impostazione predefinita un modello locale, così l'intero storico non viene mai inviato a un servizio remoto. L'oblio cancella anche vettori, fatti, riassunti e backup derivati.
- **Il nome viene riconosciuto in locale** (con openWakeWord e il modello `lumi`): finché non chiami Lumi, l'audio del microfono non viene trascritto, né salvato, né inviato. Senza il modello addestrato il nome si cerca nelle trascrizioni locali, quindi il parlato viene trascritto (sul PC, o con Groq se è il motore scelto).
- La percezione si **ferma da sola** nelle app indicate in `pauseInApps`, nelle finestre in incognito e con lo schermo bloccato.
- Sui piani gratuiti alcuni servizi (per esempio Gemini) possono usare i dati inviati per migliorare i propri modelli: verificane le condizioni prima di usarli con dati di lavoro.
- **Clonazione della voce**: usa solo la tua voce o voci per cui hai il consenso.
- **Audio delle app** (spento di default): l'audio viene trascritto sul PC e serve il riconoscimento vocale locale (non Groq); le frasi trascritte entrano nel contesto e quindi vanno al servizio di IA scelto per il cervello. Avvisa le persone in chiamata che Lumi le ascolta.
- **Bot Discord**: il token è cifrato con DPAPI in `discord.bin` (oppure `DISCORD_BOT_TOKEN`). Il bot riceve solo la voce di Lumi da mandare nel canale.
- **Impronte vocali**: sono dati biometrici, restano in `voices.json` sul PC e si cancellano una per una (o con "Dimentica tutto") dalla scheda Memoria.
- **Archivio della conversazione** (`memory.db`): resta sul PC; "Dimentica tutto" lo svuota (righe, indice e `VACUUM`) e cancella anche il vecchio `archive.jsonl.imported`.
- **Usare il PC** (previsto, spento di default): le azioni sono eseguite in locale; al servizio di IA arrivano solo i nomi di app, finestre e file che servono alla richiesta. Il registro `actions.jsonl` resta sul PC e non contiene il testo digitato.
- **Telefono** (previsto): durante una chiamata l'audio va solo dal PC al telefono abbinato, cifrato (WebRTC, DTLS-SRTP) e sulla rete locale (o sulla tua VPN Tailscale); nessun server di terzi. Il server per il telefono è spento finché non abbini un dispositivo, accetta solo telefoni abbinati e i token si revocano dalle impostazioni. Il sidecar resta raggiungibile solo da `127.0.0.1`.
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
   3. ~~[Barra dei comandi](#barra-dei-comandi) con `Ctrl+Alt+L`~~ (fatto).
   4. ~~[Abbagliamento](#abbagliamento)~~ (fatto).
   5. ~~[Visione locale](#visione-locale)~~ (fatto).
   6. ~~[Attivazione per nome](#attivazione-per-nome) con openWakeWord~~ (fatto; il modello "lumi" va addestrato con `train.py`).
10. **Memoria a lungo termine** ([dettagli](#memoria-a-lungo-termine)):
    1. ~~`db.ts` + log + FTS + `search_memory` per date; import di `archive.jsonl`, episodi e diario~~ (fatto).
    2. ~~Coda di embedding (Ollama `bge-m3`, sqlite-vec con `loadExtension`) e ricerca ibrida con RRF e punteggio~~ (fatto; gli embedding nel sidecar su CPU, senza Ollama, restano da fare).
    3. Fatti con importanza in `memory.db` (import dei fatti di `memory.json`), `superseded_by`.
    4. Riassunti gerarchici (giorno → settimana → mese) e backup giornalieri.
    5. Oblio a cascata con conferma.
11. **Abitudini** ([dettagli](#abitudini-e-proattività)): log degli eventi, `patterns.ts` con i test, riflessione notturna, trigger con limite e confidenza.
12. ~~**Audiolibri**: `POST /tts/batch`, import di `.txt`/`.epub`, capitoli, voci diverse per i dialoghi, esportazione `.m4b`~~ (fatto).
13. **Distribuzione**: installer Electron + sidecar impacchettato (embedded Python / `uv`) e download dei modelli al primo avvio.
14. **Movimento sullo schermo** ([dettagli](#movimento-sullo-schermo)). Indipendente da memoria e abitudini: si può fare anche prima.
    1. `places.ts` e `path.ts` con i test; `FaceWindow.flyTo()` con l'animazione a 60 Hz, misurata con `LUMI_DEBUG_LAG=1`.
    2. Tool `move_to` (luoghi con nome, `near_text` con la ricerca di `look_at`, `home`), gesto `travel` sul volto e sguardo verso la destinazione.
    3. Passaggio tra monitor con DPI diversi (dissolvenza al bordo).
    4. Movimenti di sua iniziativa: indicare ciò di cui parla, scansarsi, dispetti; stili di movimento, ritorno a `home` dopo `stay`, stato d'animo nel prompt, limiti di frequenza e di contesto.
15. **Lumi sul telefono** ([dettagli](#lumi-sul-telefono)):
    1. `phoneBridge` e `phone/server.ts` provati con una pagina web di prova in LAN (Chrome sul telefono, con l'origine del PC segnata come sicura nei flag di sviluppo): audio nei due sensi, VAD sulla traccia remota, barge-in.
    2. App Capacitor per Android con il volto, abbinamento con QR e pinning del certificato, gestione dei dispositivi nelle impostazioni.
    3. Il volto nell'app (stato dal PC, animazione e pulsazione in locale, sguardo e tocco) e la chiamata: stato nel prompt, ritorno sul PC alla perdita di connessione.
    4. Il passaggio: `transit.ts` con i test, disegno a tubo in `face.ts`, finestra allargata sul PC, sincronizzazione `gone` tra i due lati, fruscio facoltativo.
    5. Fuori casa con Tailscale (guida e prova), servizio in primo piano Android per parlare a schermo spento; l'APK entra nella distribuzione.
16. **Usare il PC** ([dettagli](#usare-il-pc)):
    1. `policy.ts` con i test e il ciclo del cervello che continua dopo le azioni (budget di passi, conferme con fumetto o a voce, stop con il mouse o `Esc`), registro delle azioni.
    2. Indice delle app (menu Start, Store, Steam) e tool `open`, `window`, `media`.
    3. File: `find_files` sull'indice di Windows Search e sui recenti, apertura, spostamento nel cestino con conferma.
    4. UI Automation nel sidecar (`ui_action`) e tastiera (`press_keys`, `type_text`), con verifica dopo ogni passo.
    5. Ultima risorsa: `click` con la visione locale. Poi le azioni automatiche delle abitudini (fase 11) usano lo stesso esecutore e la stessa policy.
17. **Pronuncia italiana** ([dettagli](#pronuncia-italiana)). Indipendente dalle altre fasi:
    1. ~~Frasi trappola e `scripts/pronuncia.py` (WAV per motore e voce, punteggio con `--asr`)~~ (fatto).
    2. ~~Lessico di pronuncia nelle impostazioni, riscritture predefinite per Kokoro~~ (fatto).
    3. Confronto delle voci con lo script (CustomVoice, Base clonata da un parlante italiano, VoiceDesign) e scelta della voce predefinita.
    4. Accenti grafici scritti dal cervello sulle parole ambigue, solo se il confronto mostra che il modello li rispetta.
    5. Facoltativo, solo se restano errori sistematici: LoRA su Qwen3-TTS Base con 5–10 ore di un solo parlante italiano, pesi fusi nel modello, confronto prima/dopo con lo script.

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
- `LUMI_DEBUG_MESSAGE="..."`: come se avessi detto quel testo a Lumi.
- `LUMI_DEBUG_HEAR=<file.wav>`: un WAV PCM16 passa da STT → cervello → TTS come se fosse detto con il push-to-talk (senza microfono).
- `LUMI_DEBUG_LAG=1`: registra ogni 5 s il ritardo del thread principale e i tempi di ogni cattura.
- `LUMI_DEBUG_VISIBLE=1`: niente protezione dei contenuti, così gli screenshot veri mostrano il volto.
- `LUMI_DEBUG_SETTINGS=<scheda>`: apre le impostazioni su quella scheda.
- `LUMI_DEBUG_CAPTURE=<prefisso>`: salva in PNG i fotogrammi del volto.
- `LUMI_DEBUG_BAR=1` (o un testo, `\n` per andare a capo): apre la barra dei comandi all'avvio, con quel testo nel campo.
- `LUMI_WAKE_MODEL=<nome>`: il modello della parola di attivazione (predefinito `lumi`; `hey_jarvis`, `alexa` o `hey_mycroft` sono modelli generici di openWakeWord, per provare il flusso).

Log in `%APPDATA%\Lumi\logs\`.