# Third-Party Model & Library Licenses — BhashaSetu

This project is MIT-licensed, but bundles/calls several third-party
components under different terms. Read this before deploying commercially.

## Free, unrestricted (commercial use fine)

| Component | License | Use in this project |
|---|---|---|
| OpenCV, MediaPipe | Apache-2.0 / BSD | Face/mouth ROI detection |
| Demucs (htdemucs, mdx_extra_q) | MIT | Vocal/BGM separation |
| Whisper | MIT | Speech-to-text |
| SpeechBrain (ECAPA-TDNN) | Apache-2.0 | Speaker diarization |
| PyWORLD | MIT-derivative | Pitch/prosody extraction |
| IndicTrans2 (code + checkpoints) | MIT | Machine translation |
| PEFT (LoRA) | Apache-2.0 | Translation fine-tuning |
| COMET / COMET-Kiwi | Apache-2.0 | Translation quality estimation |
| sentence-transformers / LaBSE | Apache-2.0 | QE fallback (reference-free similarity) |
| edge-tts | MIT (wraps Microsoft's free cloud TTS) | Voice synthesis (10 languages) |
| Montreal Forced Aligner | MIT (built on Kaldi, Apache-2.0) | Forced alignment |
| FFmpeg / fluent-ffmpeg | LGPL/GPL depending on build | Audio/video processing |

## ⚠️ Restricted — non-commercial / academic use only

| Component | License | Restriction |
|---|---|---|
| **Wav2Lip** (`Nekochu/Wav2Lip` checkpoint) | Research/non-commercial only | Trained on BBC's LRS2 dataset, which carries a non-commercial restriction. Do not use in a commercial product without swapping this component. |
| **Meta MMS-TTS** (`facebook/mms-tts-*`) | CC-BY-NC-4.0 | Used for Sindhi/Manipuri, where no edge-tts voice exists. Free of cost, but explicitly non-commercial. |

Both are enabled in this codebase (`ENABLE_LIP_SYNC=true`, and MMS-TTS auto-routes
for `sd`/`mni` targets in `ttsService.js`). **This is fine for a college project /
academic demo / SIH submission.** If this project is ever monetized, both
components must be replaced before commercial launch:
- Wav2Lip → a commercially-licensed lip-sync model, or drop lip-sync entirely.
- MMS-TTS → a commercially-licensed TTS voice for Sindhi/Manipuri, or drop those
  two languages until one is available.

## Compute

Google Colab (free tier) / Kaggle Notebooks (free tier) — used only if
`GPU_OFFLOAD_URL` is configured (see `.env.example`); both are free web
services, no license concern, but subject to their own usage-quota terms.