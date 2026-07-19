import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse, json, os, subprocess, sys, shutil

# Windows-specific: prevents a native access-violation crash (0xC0000005)
# caused by two OpenMP runtimes (libiomp5md.dll) being loaded at once —
# a common PyTorch-on-Windows issue, not a bug in this codebase.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

def _clean_tail(stderr_text, n_lines=40):
    # tqdm rewrites progress bars using \r, so a plain last-N-characters
    # slice is almost always still inside a progress bar repaint. Normalize
    # \r to \n and keep only the last N distinct non-empty lines instead.
    lines = stderr_text.replace('\r', '\n').split('\n')
    lines = [l for l in lines if l.strip()]
    return '\n'.join(lines[-n_lines:])

def separate(audio_path, output_dir, model="htdemucs", two_stems="vocals"):
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", model,
        "-d", "cpu",
        "--two-stems", two_stems,
        "-o", output_dir,
        audio_path
    ]
    print(f"[+] Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if result.returncode != 0:
        raise RuntimeError(f"Demucs failed (exit code {result.returncode}): {_clean_tail(result.stderr)}")

    stem = os.path.splitext(os.path.basename(audio_path))[0]
    stem_dir = os.path.join(output_dir, model, stem)
    vocals_path = os.path.join(stem_dir, "vocals.wav")
    bgm_path = os.path.join(stem_dir, "no_vocals.wav")

    if not os.path.exists(vocals_path) or not os.path.exists(bgm_path):
        raise RuntimeError(f"Demucs did not produce expected stems in {stem_dir}")

    return {"vocals_path": vocals_path, "bgm_path": bgm_path}

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("audio_path")
    p.add_argument("output_dir")
    p.add_argument("output_json")
    p.add_argument("--model", default="htdemucs")
    p.add_argument("--quality", choices=["fast", "high"], default="fast")
    args = p.parse_args()

    model = "htdemucs" if args.quality == "fast" else args.model
    try:
        result = separate(args.audio_path, args.output_dir, model=model)
        result["success"] = True
    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(f"❌ {e}", file=sys.stderr)

    os.makedirs(os.path.dirname(args.output_json), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    sys.exit(0 if result["success"] else 1)