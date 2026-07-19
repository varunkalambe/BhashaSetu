import sys, argparse, json, os, traceback
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
import warnings
warnings.filterwarnings("ignore")

def debug(msg):
    print(f"🐛 [voice_clone_convert] {msg}", file=sys.stderr, flush=True)

def clone_voice(tts_audio_path, reference_audio_path, output_path):
    import torch
    # ✅ FIX: the package actually installed by `pip install openvoice-cli`
    # exposes the module name `openvoice_cli`, NOT `openvoice`. The official
    # myshell-ai/OpenVoice repo (which uses `import openvoice`) is not on PyPI
    # at all under that name — this was the source of a guaranteed
    # ModuleNotFoundError on every single run.
    from openvoice_cli import se_extractor
    from openvoice_cli.api import ToneColorConverter
    from openvoice_cli.downloader import download_checkpoint

    device = "cuda" if torch.cuda.is_available() else "cpu"
    debug(f"device = {device}")

    ckpt_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'checkpoints_v2', 'converter')
    ckpt_dir = os.path.abspath(ckpt_dir)
    debug(f"checkpoint dir = {ckpt_dir}")

    config_path = os.path.join(ckpt_dir, 'config.json')
    ckpt_path = os.path.join(ckpt_dir, 'checkpoint.pth')

    if not (os.path.exists(config_path) and os.path.exists(ckpt_path)):
        debug("checkpoint missing locally — auto-downloading via openvoice_cli.downloader ...")
        os.makedirs(ckpt_dir, exist_ok=True)
        download_checkpoint(ckpt_dir)  # openvoice_cli ships this — no manual hunting needed
        debug("checkpoint download complete")

    debug("loading ToneColorConverter...")
    # NOTE: do NOT pass enable_watermark=False — openvoice_cli forwards unknown
    # kwargs to a parent __init__ that doesn't accept them and raises TypeError.
    # `wavmark` must just be pip-installed instead (see install command below).
    tone_color_converter = ToneColorConverter(config_path, device=device)
    tone_color_converter.load_ckpt(ckpt_path)
    debug("checkpoint loaded OK")

    # ✅ FIX: vad=True routes through whisper_timestamped -> silero-vad ->
    # torchaudio's native extension, which crashed with a Windows DLL load
    # error in an earlier run (torchaudio/torch version mismatch). vad=False
    # skips VAD-based clause splitting and uses the whole clip directly —
    # fine for a single short reference/TTS clip, and removes that fragile
    # dependency entirely.
    # ✅ FIX: vad=False was forced off pipeline-wide because of a past Windows
    # DLL crash in the VAD dependency chain. That crash risk is real, but VAD
    # is what OpenVoice uses upstream to isolate clean voiced speech before
    # computing the speaker embedding — running it on raw video vocals (which
    # can include breaths, silence, and residual music bleed from Demucs) with
    # vad=False noticeably weakens the embedding and is part of why the cloned
    # voice sounds thinner/flatter than the reference speaker. Try VAD first,
    # fall back to vad=False only if it actually throws.
    def _get_se_safe(path_):
        try:
            se, _ = se_extractor.get_se(path_, tone_color_converter, vad=True)
            return se
        except Exception as e:
            debug(f"VAD-based SE extraction failed for {path_}: {e} — falling back to vad=False")
            se, _ = se_extractor.get_se(path_, tone_color_converter, vad=False)
            return se

    debug(f"extracting target SE from reference: {reference_audio_path}")
    target_se = _get_se_safe(reference_audio_path)
    debug("target SE extracted")

    debug(f"extracting source SE from TTS output: {tts_audio_path}")
    source_se = _get_se_safe(tts_audio_path)
    debug("source SE extracted")

    def _run_convert(tau_value):
        debug(f"converting -> {output_path} (tau={tau_value})")
        tone_color_converter.convert(
            audio_src_path=tts_audio_path,
            src_se=source_se,
            tgt_se=target_se,
            output_path=output_path,
            tau=tau_value,
            message="@BhashaSetu"
        )
        debug("conversion complete")

    _run_convert(0.25)  # ✅ slightly tighter timbre match to the reference speaker

    # ✅ speaker-similarity gate, the same "did it actually work" signal
    # run_indictrans2.py already computes for translation (QE score) — until
    # now cloning was fire-and-forget with no verification. Reuses the
    # ECAPA-TDNN model already used for diarization in run_diarize_prosody.py.
    # If speechbrain isn't installed in this (OpenVoice/torch) environment,
    # skip the check rather than fail the whole clone.
    #
    # ✅ BUG FIX (2026-07-19): `def _embed(path_):` and the `if similarity < 0.55:`
    # block below had been accidentally dedented to column 0 during a previous
    # edit. That put them OUTSIDE the enclosing `try:` block (and even outside
    # `clone_voice()` itself), and the stray `except ImportError as e:` got
    # glued onto the end of the `os.remove(backup_path)` line instead of
    # starting its own line. Python's parser hit that dedent and immediately
    # raised "SyntaxError: expected 'except' or 'finally' block" at import
    # time — meaning voice_clone_convert.py could never even start running.
    # Every job silently fell through to the "keeping stock TTS voice"
    # fallback in voiceCloningService.js, which is the actual root cause of
    # the flat/robotic/monotonous output being reported: NO cloning was ever
    # happening, on any job, ever. Restoring correct indentation so `_embed`
    # and the retry block live inside the `try:` where they belong fixes this.
    similarity = None
    try:
        from speechbrain.inference.speaker import EncoderClassifier
        import soundfile as sf
        import numpy as np
        import torch as _torch

        _classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="pretrained_models/spkrec-ecapa-voxceleb",
            run_opts={"device": "cpu"}
        )

        def _embed(path_):
            wav_np, sr_ = sf.read(path_, always_2d=True)
            sig = _torch.from_numpy(wav_np.T).float()
            if sig.shape[0] > 1:
                sig = sig.mean(dim=0, keepdim=True)
            # ✅ FIX: spkrec-ecapa-voxceleb is trained on 16kHz audio. Feeding
            # it 44.1kHz (or any non-16kHz) audio unresampled makes every
            # embedding meaningless — the model perceives audio running at
            # sr_/16000 times normal speed. run_diarize_prosody.py's own use
            # of this exact model already resamples for this reason; this
            # function just never got the same fix. Confirmed root cause of
            # near-random similarity scores (0.12-0.13 against a 0.55
            # threshold) on real pipeline output.
            if sr_ != 16000:
                import librosa
                sig_np = librosa.resample(sig.numpy(), orig_sr=sr_, target_sr=16000)
                sig = _torch.from_numpy(sig_np).float()
            with _torch.no_grad():
                return _classifier.encode_batch(sig).squeeze().numpy()

        emb_out = _embed(output_path)
        emb_ref = _embed(reference_audio_path)
        similarity = float(
            np.dot(emb_out, emb_ref) / ((np.linalg.norm(emb_out) * np.linalg.norm(emb_ref)) + 1e-8)
        )
        debug(f"post-clone speaker similarity vs reference: {similarity:.3f}")

        if similarity < 0.55:
            debug(f"similarity below threshold (0.55) — retrying once with tighter tau=0.15")
            # ✅ back up the first-pass output instead of re-converting a 3rd
            # time if the retry turns out worse. Each OpenVoice pass on CPU
            # takes ~60-90s per the logs — the old code always paid for 3
            # conversions whenever the retry didn't help; this pays for 2.
            import shutil
            backup_path = output_path + '.bak'
            shutil.copy(output_path, backup_path)

            _run_convert(0.15)
            emb_out_retry = _embed(output_path)
            similarity_retry = float(
                np.dot(emb_out_retry, emb_ref) / ((np.linalg.norm(emb_out_retry) * np.linalg.norm(emb_ref)) + 1e-8)
            )
            debug(f"post-retry speaker similarity vs reference: {similarity_retry:.3f}")

            if similarity_retry <= similarity:
                debug("retry did not improve similarity — restoring first-pass output from backup (no 3rd conversion needed)")
                shutil.copy(backup_path, output_path)
            else:
                similarity = similarity_retry
            os.remove(backup_path)
    except ImportError as e:
        debug(f"speaker-similarity check skipped (speechbrain unavailable in this env): {e}")
    except Exception as e:
        debug(f"speaker-similarity check failed (non-fatal): {e}")

    return {"cloned": True, "device": device, "speaker_similarity": similarity}

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("tts_audio_path")
    p.add_argument("reference_audio_path")
    p.add_argument("output_path")
    p.add_argument("result_json")
    args = p.parse_args()

    debug(f"args: {vars(args)}")
    debug(f"tts_audio exists: {os.path.exists(args.tts_audio_path)}")
    debug(f"reference_audio exists: {os.path.exists(args.reference_audio_path)}")

    result = {"success": True}
    try:
        result.update(clone_voice(args.tts_audio_path, args.reference_audio_path, args.output_path))
        sim = result.get("speaker_similarity")
        if sim is not None and sim < 0.55:
            print(f"[WARN] Low post-clone speaker similarity: {sim:.3f} (even after retry) — voice may not closely match the reference speaker", file=sys.stderr)
    except Exception as e:
        tb = traceback.format_exc()
        result = {"success": False, "error": str(e), "traceback": tb}
        print(f"❌ {e}", file=sys.stderr)
        print(tb, file=sys.stderr)  # full traceback, not just the message

    with open(args.result_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    sys.exit(0 if result["success"] else 1)