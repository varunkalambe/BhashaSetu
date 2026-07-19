import sys
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)

import os

# Windows-specific: prevents a native access-violation crash (0xC0000005)
# caused by two OpenMP runtimes (libiomp5md.dll) being loaded at once —
# the same fix already applied in run_demucs.py / run_indictrans2.py, but
# missing here. This is what silently kills the process right after
# transcribe() finishes (during the word-level DTW alignment step),
# before the JSON output ever gets written, with no Python traceback.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import whisper_timestamped as whisper
import argparse
import json
import time

import torch
torch.set_num_threads(1)  # avoid thread-pool contention with numba's DTW aligner

def load_whisper_model_with_autodownload(model_size, device="cpu"):
    """
    Loads the given Whisper model, downloading it first if it isn't already
    cached locally. whisper.load_model() technically auto-downloads on its
    own, but it does so silently — for "medium" (~1.5GB, vs "small"'s
    ~460MB) that silence looks indistinguishable from a hang on a slow
    connection, so this wraps it with explicit existence checks and logging.
    """
    import whisper_timestamped as whisper
    import urllib.error

    cache_dir = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    os.makedirs(cache_dir, exist_ok=True)

    model_urls = whisper._MODELS
    if model_size not in model_urls:
        raise ValueError(
            f"Unknown Whisper model size '{model_size}'. "
            f"Valid options: {list(model_urls.keys())}"
        )

    local_path = os.path.join(cache_dir, os.path.basename(model_urls[model_size]))

    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        print(f"[+] Whisper '{model_size}' model already cached at {local_path} — skipping download.")
    else:
        print(f"[+] Whisper '{model_size}' model not found locally — downloading to {local_path} ...")
        print(f"[+] (This is a one-time download; medium is ~1.5GB and may take a few minutes.)")

    t_dl = time.time()
    try:
        model = whisper.load_model(model_size, device=device, download_root=cache_dir)
    except (urllib.error.URLError, ConnectionError) as e:
        raise RuntimeError(
            f"Failed to download Whisper '{model_size}' model and no valid local copy "
            f"exists at {local_path}. Check network connectivity and try again. "
            f"Original error: {e}"
        )
    print(f"[+] Whisper '{model_size}' model ready in {time.time() - t_dl:.1f}s.")
    return model


def transcribe_audio(audio_path, output_path, language_code, model_size="medium"):
    print(f"[+] Starting transcription for: {audio_path} (model={model_size})")
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        t_load = time.time()
        audio = whisper.load_audio(audio_path)
        model = load_whisper_model_with_autodownload(model_size, device="cpu")
        print(f"[+] Model + audio loaded in {time.time() - t_load:.1f}s")

        INITIAL_PROMPTS = {
            "hi": "यह एक हिंदी वाक्य है।",
            "mr": "हे एक मराठी वाक्य आहे.",
        }

        # ✅ FIX: vad=True defaults to Silero VAD, which requires a working
        # torchaudio native extension. On this machine torchaudio's .pyd fails
        # to load (WinError 127 — a torch/torchaudio version mismatch), which
        # made EVERY local-Whisper call fail, every time, with no exception
        # this code could recover from. "auditok" is a pure-Python VAD engine
        # that does the same "skip silence" job without touching torchaudio/
        # Silero at all, so it sidesteps the broken DLL entirely.
        common_kwargs = dict(
            language=language_code,
            initial_prompt=INITIAL_PROMPTS.get(language_code),
            condition_on_previous_text=False,
            temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
            compression_ratio_threshold=2.0,
            logprob_threshold=-0.8,
            no_speech_threshold=0.6,
        )

        t_decode = time.time()
        try:
            result = whisper.transcribe(model, audio, vad="auditok", **common_kwargs)
            print(f"[+] transcribe() with auditok VAD finished in {time.time() - t_decode:.1f}s")
        except Exception as vad_error:
            # ✅ heavy debug + safety net: if auditok itself has any issue
            # (missing package, environment quirk, etc.) fall back to no VAD
            # at all rather than crashing — a slightly noisier transcript on
            # silence beats failing the entire job.
            print(f"[WARN] auditok VAD failed ({vad_error}); retrying with vad=False...")
            t_decode = time.time()
            result = whisper.transcribe(model, audio, vad=False, **common_kwargs)
            print(f"[+] transcribe() with vad=False finished in {time.time() - t_decode:.1f}s")

        import re, unicodedata

        transcript = result.get("text", "")

        segments = result.get("segments", []) or []
        no_speech_probs = [s.get("no_speech_prob") for s in segments if s.get("no_speech_prob") is not None]
        avg_no_speech = sum(no_speech_probs) / len(no_speech_probs) if no_speech_probs else None

        if re.search(r"(.{1,4})\1{4,}", transcript):
            diag = f" avg_no_speech_prob={avg_no_speech:.2f}." if avg_no_speech is not None else ""
            hint = (
                " This is a strong signal the source audio has little or no detectable speech "
                "(silence, music-only, or too quiet) rather than a decoding bug — try this pipeline "
                "on a clip you know has clear spoken audio to confirm."
                if (avg_no_speech is not None and avg_no_speech > 0.5) else ""
            )
            raise RuntimeError(
                f"Whisper produced a degenerate repeating transcript (likely silent/unclear audio):{diag} "
                f"{transcript[:80]!r}.{hint}"
            )

        def _script_of(ch):
            try:
                name = unicodedata.name(ch)
            except ValueError:
                return None
            if "ARABIC" in name: return "arabic"
            if "DEVANAGARI" in name: return "devanagari"
            return None

        EXPECTED_SCRIPT = {"hi": "devanagari", "mr": "devanagari", "ur": "arabic"}
        expected = EXPECTED_SCRIPT.get(language_code)
        scripts_found = {s for s in (_script_of(c) for c in transcript) if s}
        if expected and scripts_found and expected not in scripts_found:
            print(f"[WARN] Expected '{expected}' script for language='{language_code}' but got {scripts_found} — transcript may be in the wrong script.")

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        print(f"[+] Transcription successful. Output saved to: {output_path}")

    except Exception as e:
        print(f"[ERROR] An error occurred: {e}")
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump({"error": str(e)}, f, ensure_ascii=False, indent=2)
        return False

    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Transcribe audio with word-level timestamps.")
    parser.add_argument("audio_path", type=str)
    parser.add_argument("output_path", type=str)
    parser.add_argument("--language", type=str, default="en")
    parser.add_argument("--model_size", type=str, default="small",
                         choices=["tiny", "base", "small", "medium", "large"])
    args = parser.parse_args()

    ok = transcribe_audio(args.audio_path, args.output_path, args.language, args.model_size)
    sys.exit(0 if ok else 1)