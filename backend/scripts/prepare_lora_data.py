import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

"""
Prepares parallel-text training data for IndicTrans2 LoRA fine-tuning.
Pulls sentence pairs from your own completed jobs (transcription + translation
JSON already saved by the pipeline in uploads/translations/) so the adapter is
tuned on your actual domain data instead of requiring an external corpus.
"""
import argparse, json, os, glob, random

def collect_pairs(translations_dir, transcripts_dir, min_len=3):
    pairs = []
    for tpath in glob.glob(os.path.join(translations_dir, "*_translation.json")):
        job_id = os.path.basename(tpath).replace("_translation.json", "")
        try:
            with open(tpath, encoding="utf-8") as f:
                tdata = json.load(f)
        except Exception:
            continue

        translation = tdata.get("translation", tdata)
        segments = translation.get("segments", [])
        src_lang = translation.get("originallanguage") or translation.get("sourceLang") or "hi"
        tgt_lang = translation.get("language") or translation.get("targetLang")
        if not tgt_lang:
            continue

        for seg in segments:
            src_text = (seg.get("originaltext") or "").strip()
            tgt_text = (seg.get("text") or "").strip()
            if len(src_text) >= min_len and len(tgt_text) >= min_len and src_text != tgt_text:
                pairs.append({"src": src_text, "tgt": tgt_text, "src_lang": src_lang, "tgt_lang": tgt_lang, "job_id": job_id})
    return pairs

def write_split(pairs, out_dir, val_ratio=0.1, seed=42):
    random.Random(seed).shuffle(pairs)
    n_val = max(1, int(len(pairs) * val_ratio)) if pairs else 0
    val, train = pairs[:n_val], pairs[n_val:]
    os.makedirs(out_dir, exist_ok=True)
    for name, split in [("train", train), ("val", val)]:
        path = os.path.join(out_dir, f"{name}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for p in split:
                f.write(json.dumps(p, ensure_ascii=False) + "\n")
        print(f"[+] Wrote {len(split)} pairs to {path}")
    return len(train), len(val)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--translations_dir", default="uploads/translations")
    ap.add_argument("--out_dir", default="uploads/lora_training_data")
    ap.add_argument("--min_len", type=int, default=3)
    ap.add_argument("--val_ratio", type=float, default=0.1)
    args = ap.parse_args()

    pairs = collect_pairs(args.translations_dir, args.translations_dir, args.min_len)
    if not pairs:
        print("⚠️ No usable (source, translation) pairs found yet. Run more jobs through the "
              "pipeline first — each completed job contributes its segment pairs automatically. "
              "Falling back is not possible: LoRA fine-tuning needs real supervision data, not "
              "synthetic pairs, or the adapter will just memorize noise.")
        raise SystemExit(1)

    n_train, n_val = write_split(pairs, args.out_dir, args.val_ratio)
    print(f"[+] Total pairs: {len(pairs)} (train={n_train}, val={n_val})")
    if n_train < 200:
        print(f"⚠️ Only {n_train} training pairs. LoRA fine-tuning on IndicTrans2's own repo "
              f"recommends at least a few thousand pairs for a measurable quality change; "
              f"below that you're mostly risking overfitting. Keep running jobs to accumulate "
              f"more data, or supplement with a public corpus like Samanantar/BPCC before training.")