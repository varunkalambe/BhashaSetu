import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse, json, os, sys, warnings
warnings.filterwarnings("ignore")

import numpy as np

def extract_f0(audio_path, contour_max_points=400):
    import pyworld as pw
    import soundfile as sf

    wav, sr = sf.read(audio_path)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float64)

    f0, t = pw.dio(wav, sr)
    f0 = pw.stonemask(wav, f0, t, sr)

    voiced = f0[f0 > 0]

    # ✅ NEW: downsampled F0 CONTOUR (normalized time 0..1 + Hz value, voiced
    # frames only), not just scalar mean/std. This is the missing ingredient
    # for real contour-SHAPE matching (time-warping the source speaker's
    # actual pitch trajectory onto the TTS clip) instead of only rescaling
    # aggregate statistics, which can't reproduce a specific rise/fall or
    # emphasis peak at the right moment. Capped at contour_max_points so the
    # result.json stays small regardless of clip length.
    contour = {"t_norm": [], "f0_hz": []}
    voiced_idx = np.where(f0 > 0)[0]
    if len(voiced_idx) > 1:
        total_frames = len(f0)
        step = max(1, len(voiced_idx) // contour_max_points)
        sampled_idx = voiced_idx[::step]
        contour["t_norm"] = [round(float(i) / max(total_frames - 1, 1), 4) for i in sampled_idx]
        contour["f0_hz"] = [round(float(f0[i]), 2) for i in sampled_idx]

    return {
        "mean_f0_hz": float(np.mean(voiced)) if len(voiced) else 0.0,
        "std_f0_hz": float(np.std(voiced)) if len(voiced) else 0.0,
        "min_f0_hz": float(np.min(voiced)) if len(voiced) else 0.0,
        "max_f0_hz": float(np.max(voiced)) if len(voiced) else 0.0,
        "voiced_frames": int(len(voiced)),
        "total_frames": int(len(f0)),
        "contour": contour
    }

def diarize_embeddings(audio_path, window_s=1.5, hop_s=0.75):
    from speechbrain.inference.speaker import EncoderClassifier
    import soundfile as sf
    import numpy as np
    import librosa
    import torch

    classifier = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        savedir="pretrained_models/spkrec-ecapa-voxceleb",
        run_opts={"device": "cpu"}
    )

    # Load via soundfile instead of torchaudio.load(): recent torchaudio versions
    # require the optional 'torchcodec' package for .load()/.save(), which has no
    # reliable prebuilt Windows wheel. soundfile has no such requirement and is
    # already a dependency of extract_f0() above.
    wav_np, sr = sf.read(audio_path, always_2d=True)   # shape: (frames, channels)
    signal = torch.from_numpy(wav_np.T).float()          # -> (channels, frames)

    if signal.shape[0] > 1:
        signal = signal.mean(dim=0, keepdim=True)
    if sr != 16000:
        signal_np = librosa.resample(signal.numpy(), orig_sr=sr, target_sr=16000)
        signal = torch.from_numpy(signal_np).float()
        sr = 16000

    win = int(window_s * sr)
    hop = int(hop_s * sr)
    total = signal.shape[1]

    embeddings, times = [], []
    for start in range(0, max(total - win, 1), hop):
        chunk = signal[:, start:start + win]
        if chunk.shape[1] < sr * 0.3:
            continue
        with torch.no_grad():
            emb = classifier.encode_batch(chunk).squeeze().numpy()
        embeddings.append(emb)
        times.append(start / sr)

    if len(embeddings) < 2:
        return {"num_speakers": 1, "segments": [{"start": 0, "end": total / sr, "speaker": "SPEAKER_00"}]}

    from sklearn.cluster import AgglomerativeClustering
    X = np.stack(embeddings)
    Xn = X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-8)

    n_clusters = min(4, max(1, len(embeddings) // 4))
    clustering = AgglomerativeClustering(n_clusters=n_clusters, metric="cosine", linkage="average")
    labels = clustering.fit_predict(Xn)

    segments = []
    for i, (t, lab) in enumerate(zip(times, labels)):
        end = times[i + 1] if i + 1 < len(times) else total / sr
        segments.append({"start": round(t, 2), "end": round(end, 2), "speaker": f"SPEAKER_{lab:02d}"})

    return {"num_speakers": int(len(set(labels))), "segments": segments}

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("audio_path")
    p.add_argument("output_json")
    args = p.parse_args()

    result = {"success": True}
    try:
        result["f0"] = extract_f0(args.audio_path)
    except Exception as e:
        result["f0_error"] = str(e)
        print(f"⚠️ F0 extraction failed: {e}", file=sys.stderr)

    try:
        result["diarization"] = diarize_embeddings(args.audio_path)
    except Exception as e:
        result["diarization_error"] = str(e)
        print(f"⚠️ Diarization failed: {e}", file=sys.stderr)

    os.makedirs(os.path.dirname(args.output_json), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print("[+] Diarization/prosody analysis complete")