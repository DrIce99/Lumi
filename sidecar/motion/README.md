# Gesti generati dal testo (text-to-motion)

Fase 19.3 della roadmap. Un modello text-to-motion trasforma una frase
inglese ("a person laughs heartily, the shoulders shaking...") in un
movimento del corpo intero; `vrma.py` lo converte in un file **`.vrma`**
che Lumi in 3D usa come gesto (`%APPDATA%\Lumi\animations\<gesto>.vrma`).
Si genera **una volta, offline**: durante la conversazione non gira nessun
modello in più.

I modelli vogliono 17-26 GB di VRAM, quindi la generazione gira su una GPU
in affitto su [RunPod](https://www.runpod.io). La conversione in `.vrma` è
numpy puro: gira sul pod subito dopo la generazione, e anche sul PC.

```
sidecar/motion/
├─ vrma.py              conversione .npz -> .vrma (pura, testata: tests/test_motion_vrma.py)
└─ runpod/
   ├─ setup.sh          installa i motori sul pod (una volta per volume)
   ├─ run.sh            lancia generate.py con l'ambiente del motore scelto
   ├─ generate.py       genera i gesti di gestures.json, li converte, fa lo zip
   ├─ gestures.json     i gesti da generare (nome, prompt, durata, prese)
   └─ env.sh            percorsi e cache sul volume
```

## Licenze: prima di tutto

| Motore | Licenza | In Italia |
| --- | --- | --- |
| **Kimodo** (NVIDIA), modelli SOMA | codice Apache-2.0, pesi NVIDIA Open Model License | sì (anche uso commerciale) |
| Kimodo, modello SMPL-X | NVIDIA R&D License | solo ricerca, non commerciale |
| **HY-Motion 1.0** (Tencent) | Tencent HY-Motion 1.0 Community License | **no**: la licenza esclude Unione Europea, Regno Unito e Corea del Sud, anche per l'uso dei risultati |

Per questo il motore predefinito è **Kimodo SOMA**. HY-Motion resta
supportato (`--engine hymotion`) per chi è fuori da quei territori. Il text
encoder di Kimodo è Llama 3 8B Instruct (Meta Llama 3 Community License,
modello "gated": bisogna chiedere l'accesso su Hugging Face).

## Cosa serve

- Un account RunPod con un po' di credito.
- Un account Hugging Face con l'accesso a
  [meta-llama/Meta-Llama-3-8B-Instruct](https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct)
  (di solito arriva in poco tempo) e un token di lettura.
- [`runpodctl`](https://github.com/runpod/runpodctl) sul PC, per spostare i
  file (oppure il caricamento di JupyterLab dal browser).

| Motore | VRAM | GPU adatte |
| --- | --- | --- |
| Kimodo | circa 17 GB | 24 GB bastano: RTX 4090, RTX A5000, L4 |
| HY-Motion 1.0 | almeno 26 GB | 48 GB: A40, L40S, RTX A6000 |
| HY-Motion 1.0 Lite | almeno 24 GB | 24 GB con `--batch 1`, meglio 48 GB |

Le tariffe cambiano: guardale nella pagina Deploy. Il pod si paga a
minuti mentre è acceso, il volume ogni mese finché esiste.

## Sul PC, senza RunPod (Kimodo)

Con una scheda da 12 GB Kimodo gira anche in locale: `local.ps1` mette il
text encoder (Llama 3 8B, 16 GB) sulla CPU quando la VRAM è sotto i 20 GB,
e il modello dei movimenti resta sulla GPU (meno di 3 GB). Servono circa
16 GB di RAM libera, gli strumenti di compilazione C++ di Visual Studio
(per la correzione del movimento di Kimodo) e `uv`. Chiudi Lumi e Ollama
prima di generare: tengono occupata la VRAM.

```powershell
cd sidecar\motion
.\local.ps1 setup                          # una volta
.\local.ps1 run --only explain --seeds 1   # prova
.\local.ps1 run                            # tutti i gesti
```

Ambiente in `%LOCALAPPDATA%\Lumi\motion`, pesi in `%APPDATA%\Lumi\models\hf`,
clip in `%LOCALAPPDATA%\Lumi\motion\out` (e `lumi-clips.zip` accanto). Il
token è quello salvato da `hf auth login`, oppure `$env:HF_TOKEN`.

## Passi

1. **Volume**: Storage → New Network Volume, circa 50 GB per Kimodo (Llama
   3 8B da solo sono 16 GB), 80 GB se installi anche HY-Motion. Nello
   stesso datacenter della GPU che userai.
2. **Pod**: Pods → Deploy, scegli la GPU, template **RunPod PyTorch**
   (qualsiasi immagine CUDA 12: `setup.sh` crea ambienti Python suoi),
   collega il volume (finisce in `/workspace`), container disk 30 GB. In
   *Environment Variables* aggiungi `HF_TOKEN` con il tuo token (meglio
   come Secret di RunPod: `{{ RUNPOD_SECRET_hf_token }}`).
3. **Copia la cartella** sul pod. Dal PC:

   ```powershell
   cd C:\Download\Programmini\Electron\Lumi\sidecar
   runpodctl send motion
   ```

   e nel terminale del pod (Connect → Web Terminal o JupyterLab):

   ```bash
   cd /workspace && runpodctl receive <codice>
   ```

4. **Installa** (la prima volta scarica qualche GB, poi resta sul volume):

   ```bash
   bash /workspace/motion/runpod/setup.sh             # Kimodo
   bash /workspace/motion/runpod/setup.sh hymotion    # solo se la licenza te lo permette
   ```

5. **Prova** con un gesto e una presa:

   ```bash
   bash /workspace/motion/runpod/run.sh --only explain --seeds 1
   ```

6. **Genera tutto** (20 gesti × 4 prese):

   ```bash
   bash /workspace/motion/runpod/run.sh
   ```

   Se si ferma (pod spento, errore), rilancialo: i gesti già fatti con lo
   stesso prompt vengono saltati. `--force` li rifà, `--only a,b` ne fa
   solo alcuni. Un prompt che fallisce non ferma gli altri.
7. **Scarica** lo zip:

   ```bash
   runpodctl send /workspace/lumi-motion/lumi-clips.zip    # sul pod
   ```

   ```powershell
   runpodctl receive <codice>                              # sul PC
   ```

8. **Ferma il pod** (Stop) appena hai finito. *Terminate* cancella anche il
   container disk; il volume resta (con gli ambienti e i pesi) finché non
   lo cancelli.

## Scegliere le prese

Nello zip, `out/<gesto>/` ha una `seed<N>.vrma` per presa (e il suo
`.npz`), `info.json` (prompt, impostazioni, un riassunto di ogni presa) e,
con HY-Motion, `preview.html`: tutte le prese sul manichino di legno, nel
browser.

Per provarne una su Lumi copiala con il nome del gesto nella cartella
delle animazioni (è sorvegliata: niente riavvio):

```powershell
Copy-Item .\out\laugh\seed4821.vrma "$env:APPDATA\Lumi\animations\laugh.vrma"
```

e falla partire senza cervello:

```powershell
cd app
$env:LUMI_DEBUG_ACT = "laugh"; npm start
```

Il nome del file è il nome del gesto: il cervello trova i gesti nuovi in
`<situation>` solo per nome, quindi conviene un nome chiaro in inglese.
Un file `laugh.vrma` lasciato lì è subito un gesto vero.

## Riconvertire sul PC

Il `.npz` contiene il movimento com'è uscito dal modello: si può
riconvertire con altre opzioni senza tornare su RunPod.

```powershell
cd sidecar
uv run python -m motion.vrma ..\out\laugh\seed4821.npz -o "$env:APPDATA\Lumi\animations\laugh.vrma" --trim 0.3:2.6
uv run python -m motion.vrma ..\out                     # tutte, accanto ai .npz
```

| Opzione | Effetto |
| --- | --- |
| `--trim a:b` | tiene solo i secondi da `a` a `b` (uno dei due può mancare) |
| `--root inplace` / `keep` | predefinito: niente spostamenti sul pavimento (Lumi è inquadrata dalla vita in su); `keep` li tiene |
| `--facing start` / `locked` / `keep` | predefinito: girata verso di te all'inizio; `locked` toglie ogni rotazione del corpo; `keep` lascia la direzione del modello |
| `--hands` / `--no-hands` | le dita: predefinito sì con Kimodo SOMA (catturate dal vero), no con HY-Motion (sono una posa media fissa, la mano resterebbe rigida) |
| `--up auto` / `y` / `z` | l'asse verticale: `auto` lo trova da solo (AMASS è Z in alto) |

Legge anche i `.npz` del CLI di Kimodo con il modello SMPL-X e i file
AMASS; per SOMA serve il file scritto da `generate.py`, che contiene anche
la posa di riposo dello scheletro.

## Scrivere i prompt

In `gestures.json`: `name` (minuscole, cifre e `_`: diventa il nome del
gesto), `prompt`, `duration` (1-10 s), `seeds` (quante prese) oppure
`seed_list` (prese precise, per rifarne una).

- In inglese, sotto le 60 parole, descrivendo **che cosa fanno le parti
  del corpo** ("raises the right hand to the forehead"), non le emozioni,
  l'aspetto, la telecamera o la scena.
- "stands in place": i passi verrebbero comunque tolti, ma il busto
  ondeggerebbe come camminando.
- Lumi si vede dalla vita in su: i gesti con le mani all'altezza del petto
  rendono meglio; gambe e piedi non si vedono.
- Niente gesti delle dita con HY-Motion (pollice in su, conto con le
  dita): non le muove.
- I modelli non fanno cicli perfetti: l'app sfuma comunque l'entrata e
  l'uscita di ogni gesto.

## Come funziona la conversione

Gli scheletri dei modelli (SMPL per HY-Motion, SOMA o SMPL-X per Kimodo
nella sua "standard T-pose") stanno a riposo in T-pose con gli assi di
ogni giunto allineati al mondo: Y in alto, faccia verso +Z, sinistra del
personaggio su +X. Le ossa normalizzate di un VRM 1.0 pure. Quindi la
rotazione locale di un giunto è già la rotazione locale dell'osso VRM e
si copia com'è; i giunti che il VRM non ha (il secondo collo di SOMA, i
metacarpi delle dita) si sommano all'osso successivo. Il `.vrma` ha
rotazioni di riposo nulle su tutti i nodi, così three-vrm-animation
applica le tracce senza cambiarle e riscala la traslazione dei fianchi
con il rapporto delle altezze.

Poi: l'asse verticale (dalla testa rispetto al bacino), la rotazione
iniziale verso la telecamera (dall'asse destra-sinistra del bacino, che
resta orizzontale anche in un inchino), il pavimento sotto il giunto più
basso di tutta la clip (un accovacciarsi abbassa i fianchi, un salto li
alza), i fianchi fermi sul posto.

## Stato

- `vrma.py`: test in `tests/test_motion_vrma.py`; un file generato è stato
  letto con `@pixiv/three-vrm-animation` (lo stesso loader dell'app): 22
  tracce, altezza dei fianchi giusta, il braccio sinistro si alza dal
  verso giusto. La T-pose SOMA è stata controllata sui file di Kimodo
  (`joints.p`).
- Gli script di RunPod non sono ancora stati provati su un pod vero; il
  flusso di `generate.py` (salto dei gesti fatti, conversione, zip) è
  stato provato con un motore finto.
