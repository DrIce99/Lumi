# Lumi sidecar

Processo Python che dà a Lumi la voce, l'udito e la lettura dello schermo:
riconoscimento vocale (STT), sintesi vocale (TTS), OCR e UI Automation. Lo
avvia l'app Electron; in sviluppo si può avviare a mano.

```bash
uv sync --extra gpu            # profili "bilanciato" e "locale" (GPU NVIDIA)
uv sync                        # profilo "leggero" (solo CPU)
uv run python server.py --port 8765 --dev
uv run pytest                  # test veloci, motori simulati
uv run pytest -m model         # test con i modelli veri (scarica i modelli)
```

Parola di attivazione (openWakeWord): `uv sync --extra wakeword`, poi il
modello "lumi" si addestra con le voci di Lumi:

```bash
uv sync --extra wakeword --extra gpu
uv run python -m wake.train --engines qwen3,kokoro --count 3000
```

I modelli vengono scaricati al primo uso in `%APPDATA%\Lumi\models`.
Vedi il README del progetto per il protocollo.
