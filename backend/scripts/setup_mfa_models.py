import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import subprocess, shutil

MODELS = {
    "en": ("english_mfa", "english_mfa"),
    "ta": ("tamil_cv", "tamil_cv"),
}

def main():
    if shutil.which("mfa") is None:
        print("[ERROR] 'mfa' not found on PATH. Install via:")
        print("   conda install -c conda-forge montreal-forced-aligner")
        sys.exit(1)

    print("Downloading acoustic models + dictionaries...")
    failed = []
    for lang, (acoustic, dictionary) in MODELS.items():
        print(f"  -> [{lang}] {acoustic}")
        a_ok = subprocess.run(["mfa", "model", "download", "acoustic", acoustic]).returncode == 0
        d_ok = subprocess.run(["mfa", "model", "download", "dictionary", dictionary]).returncode == 0
        if a_ok and d_ok:
            print(f"     installed")
        else:
            print(f"     download failed")
            failed.append(lang)

    print("\n===== SUMMARY =====")
    print(f"Available: {len(MODELS) - len(failed)} / {len(MODELS)}")
    print("\nMFA has no public acoustic models for hi, mr, bn, gu, kn, ml, pa, ur, sd, te, mni.")
    print("These always fall back to Whisper word timestamps automatically — expected behavior.")

if __name__ == "__main__":
    main()