import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import json, os, shutil, subprocess, tempfile, urllib.request

REPO = "https://github.com/AI4Bharat/IndicMFA/releases/download"

LANGS = {
    "hi":  ("Hindi",     "Hindi_Dict_g2g.txt",        "Hindi_All_Acoustic.zip"),
    "bn":  ("Bengali",   "Bengali_Dict.txt",           "Bengali_Acoustic_Model.zip"),
    "mr":  ("Marathi",   "Marathi_Dict.txt",           "Marathi_Acoustic_Model.zip"),
    "gu":  ("Gujarati",  "Gujarati_Dict.txt",          "Gujarati_Acoustic_Model.zip"),
    "kn":  ("Kannada",   "Kannada_Dict.txt",           "Kannada_Acoustic_Model.zip"),
    "pa":  ("Punjabi",   "Punjabi_Dict.txt",           "Punjabi_Acoustic_Model.zip"),
    "ta":  ("Tamil",     "Tamil_Dictionary_g2g.txt",   "Tamil_Acoustic_Model.zip"),
    "te":  ("Telugu",    "Telugu_Dictionary_g2g.txt",  "Telugu_Acoustic_Model.zip"),
    "ml":  ("Malayalam", "Malayalam_Dict.txt",         "Malayalam_Acoustic_Model.zip"),
    "ur":  ("Urdu",      "Urdu_Dict.txt",              "Urdu_Acoustic_Model.zip"),
    "or":  ("Odia",      "Odia_Dict.txt",              "Odia_Acoustic_Model.zip"),
    "as":  ("Assamese",  "Assamese_Dict.txt",          "Assamese_Acoustic_Model.zip"),
    "sa":  ("Sanskrit",  "Sanskrit_Dict.txt",          "Sanskrit_Acoustic_Model.zip"),
    "ne":  ("Nepali",    "Nepali_Dict.txt",            "Nepali_Acoustic_Model.zip"),
    "sd":  ("Sindhi",    "Sindhi_Dict.txt",            "Sindhi_Acoustic_Model.zip"),
    "sat": ("Santali",   "Santali_Dict.txt",           "Santali_Acoustic_Model.zip"),
    "mni": ("Manipuri",  "Manipuri.Dict.txt",          "Manipuri_Acoustic_Model.zip"),
    "mai": ("Maithili",  "Maithili_Dict.txt",          "Maithili_Acoustic_Model.zip"),
    "gom": ("Konkani",   "Konkani_Dict.txt",           "Konkani_Acoustic_Model.zip"),
    "ks":  ("Kashmiri",  "Kashmiri_Dict.txt",          "Kashmiri_Acoustic_Model.zip"),
    "doi": ("Dogri",     "Dogri_Dict.txt",             "Dogri_Acoustic_Model.zip"),
    "brx": ("Bodo",      "Bodo_Dict.txt",              "Bodo_Acoustic_Model.zip"),
}

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "mfa_indic_models.json")

def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)

def main():
    if shutil.which("mfa") is None:
        print("[ERROR] 'mfa' not on PATH. Run: conda activate bhashasetu-mfa")
        sys.exit(1)

    config = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)

    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        for code, (tag, dict_file, acoustic_file) in LANGS.items():
            name = f"{code}_indic_mfa"
            print(f"[{code}] downloading {tag}...")
            dict_path = os.path.join(tmp, dict_file)
            acoustic_path = os.path.join(tmp, acoustic_file)
            try:
                download(f"{REPO}/{tag}/{dict_file}", dict_path)
                download(f"{REPO}/{tag}/{acoustic_file}", acoustic_path)
            except Exception as e:
                print(f"     download failed: {e}")
                failed.append(code)
                continue

            d_ok = subprocess.run(["mfa", "model", "save", "dictionary", dict_path, "--name", name, "--overwrite"]).returncode == 0
            a_ok = subprocess.run(["mfa", "model", "save", "acoustic", acoustic_path, "--name", name, "--overwrite"]).returncode == 0

            if d_ok and a_ok:
                config[code] = {"acoustic": name, "dictionary": name}
                print(f"     registered as {name}")
            else:
                print(f"     mfa model save failed")
                failed.append(code)

    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    print("\n===== SUMMARY =====")
    print(f"Registered: {len(LANGS) - len(failed)} / {len(LANGS)}")
    if failed:
        print(f"Failed: {failed}")
    print(f"Config written to: {CONFIG_PATH}")

if __name__ == "__main__":
    main()