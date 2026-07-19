## 💻 Technical Stack

- **Backend**: Node.js 18+ with Express 5
- **Speech Recognition**: OpenAI Whisper (base model, word-level timestamps via whisper-timestamped)
- **Vocal/BGM Separation**: Demucs (htdemucs / mdx_extra_q) — preserves background music/ambience
- **Speaker Diarization**: SpeechBrain ECAPA-TDNN + agglomerative clustering
- **Prosody Analysis**: PyWORLD (F0/pitch extraction) — informs per-speaker voice selection
- **Translation**: AI4Bharat IndicTrans2 (200M-distilled, LoRA-fine-tunable), with COMET-Kiwi /
  LaBSE quality gating, falling back to OpenAI → MyMemory → Google Translate
- **TTS**: Microsoft Edge TTS (10 languages) + Meta MMS-TTS (Sindhi, Manipuri — CC-BY-NC-4.0,
  academic use)
- **Forced Alignment**: Montreal Forced Aligner (Kaldi-based), falling back to Whisper word
  timestamps when unavailable — see `ENABLE_MFA_ALIGNMENT`
- **Lip Sync**: Wav2Lip (CC-BY-NC — academic/research use) — see `ENABLE_LIP_SYNC`
- **GPU Offload**: optional Colab/Kaggle free-tier bridge for Demucs + Wav2Lip
- **Video Processing**: FFmpeg
- **Database**: MongoDB Atlas
- **Deployment**: Docker on Hugging Face Spaces

See `LICENSE-NOTES.md` for third-party licensing (Wav2Lip and MMS-TTS are
non-commercial/academic use only) and `.env.example` for all configuration flags.

## ⏱️ Performance Metrics

Fast path (default — `ENABLE_MFA_ALIGNMENT=false`, `ENABLE_LIP_SYNC=false`):
Demucs + diarization + IndicTrans2 + edge-tts, ~2-4 min for a 30s clip on CPU.

Full path (`ENABLE_MFA_ALIGNMENT=true`, `ENABLE_LIP_SYNC=true`): add real MFA
alignment and Wav2Lip lip-sync, ~5-13 min for a 30s clip on CPU (Wav2Lip and
Demucs dominate). With `GPU_OFFLOAD_URL` configured against a free Colab/Kaggle
T4, this drops back toward ~2-3 min. Run `python backend/scripts/benchmark_pipeline.py
--video <your_clip>.mp4` to measure actual numbers on your hardware.