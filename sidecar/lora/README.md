# Voce addestrata in italiano (LoRA)

Fase 17.5 della roadmap. È un adattamento leggero (LoRA) di Qwen3-TTS
Base sulla voce di **un solo** lettore italiano. Alla fine il LoRA viene
fuso nel modello, che nelle impostazioni compare come «1.7B addestrato
in italiano». Serve una scheda NVIDIA con almeno 6 GB liberi: chiudi Lumi
durante l'addestramento.

```powershell
cd sidecar
uv sync --extra gpu --extra lora     # peft

# 1. dataset: scarica, trascrive (Whisper), taglia in clip da 3-15 s, codifica
uv run python -m lora.prepare --librivox i_malavoglia_1303_librivox --hours 10

# 2. addestramento + fusione (circa 20 minuti per 7 ore di audio, 2 epoche, RTX 4070)
uv run python -m lora.train

# 3. confronto prima/dopo (con un sidecar avviato a mano)
uv run python scripts/pronuncia.py --voices qwen3:1.7B-Base:,qwen3:1.7B-Italiano: --asr --accent
uv run python scripts/accenti.py --voices qwen3:1.7B-Base:,qwen3:1.7B-Italiano:
```

Tutto finisce in `%APPDATA%\Lumi\models\lora\italiano\`:

- `data/`: gli MP3, le clip, `ref.wav` (la voce che il modello terrà) e
  `train.jsonl`;
- `adapter/`: il LoRA;
- `model/`: il modello fuso (circa 4,5 GB), quello che carica il sidecar.

Le opzioni utili:

- `--name`: tiene più esperimenti separati. Il sidecar carica solo
  `italiano`.
- `--epochs`, `--lr`, `--rank`: i parametri dell'addestramento.
- `--max-steps 20`: una prova veloce.
- `--size 0.6B`: addestra il modello piccolo.
- `--audio "D:\letture\*.mp3"`: usa registrazioni tue (sempre un solo
  lettore, voce pulita).

Il testo delle clip è la trascrizione di Whisper, non il libro. Qualche
parola sbagliata o un nome proprio scritto in minuscolo passano anche nei
dati di addestramento. Le clip si tagliano nelle pause trovate nell'audio
(almeno 0,25 s di silenzio), perché i tempi delle parole di Whisper non
lasciano spazi tra una parola e l'altra. Ogni parola va con il tratto di
parlato in cui finisce: Whisper allunga all'indietro l'inizio di una
parola fino dentro la pausa che la precede.

## Com'è andata

Prova fatta: 6,8 ore de *I Malavoglia* letti da Lisa Caputo (2864 clip,
la stessa voce della clip predefinita), 2 epoche, 358 passi in 21 minuti
su una RTX 4070, 4,8 GB di VRAM. Confronto con la Base clonata, che
resta la voce predefinita:

| | Parole giuste | Italiano (Whisper) | Voce stabile |
| --- | --- | --- | --- |
| Base 1.7B + voce «italiana» | **0,994** | **0,998** | **0,54** |
| LoRA | 0,990 | 0,982 | 0,52 |

Anche sugli omografi letti dal contesto non c'è alcun miglioramento
(`scripts/accenti.py`).

Due versioni precedenti erano peggiori:

- **Prefisso senza la lingua.** È quello della ricetta ufficiale, mentre il
  sidecar genera con «italian».
- **Clip tagliate ai confini dei segmenti di Whisper.** Nel 25% delle clip
  restava l'inizio della parola dopo, e il modello aggiungeva parole in
  fondo alla frase: «…e chi è?».

Oggi `prepare.py` cerca le pause nell'audio e `train.py` usa il prefisso
della lingua.

Per fare meglio servirebbe il testo vero del libro allineato all'audio,
al posto della trascrizione di Whisper.

## Cosa non fa

- **Le emozioni.** Il modello addestrato, come Base, non riceve istruzioni
  di stile: non ha mai visto dati con emozioni. L'emozione resta nel volto
  e nel testo.
- **Gli accenti grafici.** Il testo di addestramento non li contiene, quindi
  il modello non li segue in modo affidabile (vedi `scripts/accenti.py`).
  Il modello impara invece da molte frasi come si leggono le parole nel
  loro contesto.

## Differenze dalla ricetta ufficiale

La disposizione della sequenza viene da `finetuning/` del repository
Qwen3-TTS (Apache 2.0). Ci sono però tre correzioni, verificate misurando
la loss del modello **non addestrato** sulle nostre clip: il formato giusto
è quello che il modello conosce già.

1. Il testo passa per `text_projection`, come nella generazione.
2. Le etichette sono spostate una volta sola: la loss causale di
   Transformers le sposta di nuovo, e la ricetta finiva per predire due
   passi avanti.
3. Il predittore dei codebook riceve lo stato del passo che ha prodotto il
   codebook 0 del frame, cioè la posizione precedente.
4. Le sequenze hanno il prefisso della lingua («italian»), come quelle che
   il sidecar genera; la ricetta addestra senza (`--language ""` per farlo).

Risultato: la loss del talker passa da 11,8 a 1,36 e quella del predittore
da 9,2 a 4,9.
