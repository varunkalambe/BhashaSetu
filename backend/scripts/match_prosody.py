# scripts/match_prosody.py — optional advanced step, run after TTS, before OpenVoice cloning
import sys, json
import numpy as np
import soundfile as sf
import pyworld as pw

def match_prosody_contour(tts_path, target_mean_f0, target_std_f0, contour, output_path, blend=0.85):
    """✅ NEW: real contour-SHAPE matching, not just mean/std rescaling.
    `contour` is the SOURCE speaker's own {"t_norm": [...], "f0_hz": [...]}
    trajectory (already the real target voice — no rescaling needed, just
    time-warping onto the TTS clip's own timeline via normalized-time linear
    interpolation, a lightweight DTW-lite). This is what actually reproduces
    a specific rise/fall or emphasis peak at roughly the right moment,
    instead of only matching aggregate statistics. `blend` keeps a fraction
    of the TTS's own natural micro-variation mixed in (pure imposed contour
    can sound slightly over-smoothed/robotic) — 1.0 = fully replace, 0.0 =
    keep TTS's own contour untouched.
    """
    wav, sr = sf.read(tts_path)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float64)

    f0, t = pw.dio(wav, sr, frame_period=5.0)
    f0 = pw.stonemask(wav, f0, t, sr)
    sp = pw.cheaptrick(wav, f0, t, sr)   # spectral envelope — untouched
    ap = pw.d4c(wav, f0, t, sr)          # aperiodicity — untouched

    voiced = f0 > 0
    total_frames = len(f0)
    voiced_idx = np.where(voiced)[0]

    src_t = np.asarray(contour.get("t_norm", []), dtype=np.float64)
    src_f0 = np.asarray(contour.get("f0_hz", []), dtype=np.float64)

    new_f0 = f0.copy()
    if len(src_t) >= 2 and len(voiced_idx) > 0:
        tts_norm_t = voiced_idx.astype(np.float64) / max(total_frames - 1, 1)
        # Linear time-warp: map each TTS voiced frame's normalized position
        # onto the source speaker's own contour at that same relative position.
        warped_shape = np.interp(tts_norm_t, src_t, src_f0)
        blended = blend * warped_shape + (1 - blend) * f0[voiced_idx]
        new_f0[voiced_idx] = blended
    elif tts_std_safe(f0, voiced) > 1e-3:
        # Fallback: no usable contour — original scalar rescale (mean+variance).
        tts_mean = np.mean(f0[voiced])
        tts_std = np.std(f0[voiced])
        new_f0[voiced] = target_mean_f0 + (f0[voiced] - tts_mean) * (target_std_f0 / tts_std)

    new_f0 = np.clip(new_f0, 50, 600)  # keep it in a physiologically sane range
    new_f0[~voiced] = 0

    resynth = pw.synthesize(new_f0, sp, ap, sr)
    sf.write(output_path, resynth, sr)


def tts_std_safe(f0, voiced):
    return np.std(f0[voiced]) if voiced.any() else 0.0


def match_prosody(tts_path, target_mean_f0, target_std_f0, output_path):
    """Original scalar mean/std rescale — kept as the fallback path when no
    source contour is available (e.g. diarization/F0 step failed upstream)."""
    wav, sr = sf.read(tts_path)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    wav = wav.astype(np.float64)

    f0, t = pw.dio(wav, sr, frame_period=5.0)
    f0 = pw.stonemask(wav, f0, t, sr)
    sp = pw.cheaptrick(wav, f0, t, sr)   # spectral envelope — untouched
    ap = pw.d4c(wav, f0, t, sr)          # aperiodicity — untouched

    voiced = f0 > 0
    tts_mean = np.mean(f0[voiced])
    tts_std = np.std(f0[voiced])

    # Rescale variance toward the source speaker's, then re-center on the
    # already-matched mean — reshapes the CONTOUR, not just a flat shift.
    new_f0 = f0.copy()
    if tts_std > 1e-3:
        new_f0[voiced] = target_mean_f0 + (f0[voiced] - tts_mean) * (target_std_f0 / tts_std)
    new_f0 = np.clip(new_f0, 50, 600)  # keep it in a physiologically sane range
    new_f0[~voiced] = 0

    resynth = pw.synthesize(new_f0, sp, ap, sr)
    sf.write(output_path, resynth, sr)


if __name__ == "__main__":
    tts_path, mean_f0, std_f0, out_path, result_json = sys.argv[1:6]
    contour_path = sys.argv[6] if len(sys.argv) > 6 else None

    result = {"success": True}
    try:
        contour = None
        if contour_path:
            try:
                with open(contour_path, "r", encoding="utf-8") as f:
                    contour = json.load(f)
            except Exception as ce:
                print(f"[match_prosody] contour file unreadable, falling back to scalar rescale: {ce}", file=sys.stderr)
                contour = None

        if contour and len(contour.get("t_norm", [])) >= 2:
            match_prosody_contour(tts_path, float(mean_f0), float(std_f0), contour, out_path)
            result["method"] = "contour_timewarp"
        else:
            match_prosody(tts_path, float(mean_f0), float(std_f0), out_path)
            result["method"] = "scalar_rescale"
    except Exception as e:
        result = {"success": False, "error": str(e)}

    with open(result_json, "w") as f:
        json.dump(result, f)