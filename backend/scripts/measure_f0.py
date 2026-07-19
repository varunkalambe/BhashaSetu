import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# scripts/measure_f0.py — fast, lightweight F0-only measurement (mean/std),
# used for the post-clone verification check in ttsService.js. Deliberately
# does NOT import speechbrain/diarization (unlike run_diarize_prosody.py) so
# it stays fast enough to call after every voice-clone pass without adding
# meaningful pipeline latency.
import argparse, json, os
import numpy as np

def measure(audio_path):
    import pyworld as pw
    import soundfile as sf

    wav, sr = sf.read(audio_path)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float64)

    f0, t = pw.dio(wav, sr)
    f0 = pw.stonemask(wav, f0, t, sr)

    voiced = f0[f0 > 0]
    return {
        "mean_f0_hz": float(np.mean(voiced)) if len(voiced) else 0.0,
        "std_f0_hz": float(np.std(voiced)) if len(voiced) else 0.0,
        "voiced_frames": int(len(voiced)),
        "total_frames": int(len(f0))
    }

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("audio_path")
    p.add_argument("output_json")
    args = p.parse_args()

    result = {"success": True}
    try:
        result.update(measure(args.audio_path))
    except Exception as e:
        result = {"success": False, "error": str(e)}

    os.makedirs(os.path.dirname(args.output_json) or ".", exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)