import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse, json, os, sys, warnings
warnings.filterwarnings("ignore")


def _debug_environment():
    print("=" * 60, file=sys.stderr)
    print(f"[DEBUG] Python executable : {sys.executable}", file=sys.stderr)
    print(f"[DEBUG] Python version    : {sys.version}", file=sys.stderr)
    try:
        import torch
        print(f"[DEBUG] torch version     : {torch.__version__}", file=sys.stderr)
        print(f"[DEBUG] CUDA available    : {torch.cuda.is_available()}", file=sys.stderr)
    except Exception as e:
        print(f"[DEBUG] torch import failed: {e}", file=sys.stderr)
    try:
        import transformers
        print(f"[DEBUG] transformers ver  : {transformers.__version__}", file=sys.stderr)
    except Exception as e:
        print(f"[DEBUG] transformers import failed: {e}", file=sys.stderr)
    try:
        import IndicTransToolkit
        print(f"[DEBUG] IndicTransToolkit : {getattr(IndicTransToolkit, '__version__', 'unknown')}", file=sys.stderr)
    except Exception as e:
        print(f"[DEBUG] IndicTransToolkit import failed: {e}", file=sys.stderr)
    hf_tok = os.environ.get("HF_TOKEN")
    print(f"[DEBUG] HF_TOKEN present  : {bool(hf_tok)} (len={len(hf_tok) if hf_tok else 0})", file=sys.stderr)
    print("=" * 60, file=sys.stderr)

_debug_environment()

# Windows-specific: prevents a native access-violation crash (0xC0000005)
# caused by two OpenMP runtimes (libiomp5md.dll) being loaded at once — the
# same PyTorch-on-Windows issue already worked around in run_demucs.py.
# indictrans2 loads torch + transformers too and hits the identical crash,
# which shows up exactly like this: process exits nonzero with ZERO output,
# because it's a native crash, not a catchable Python exception.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
# HF's Rust tokenizers spin up their own thread pool independent of
# OpenMP/MKL — a second, separate source of the exact same class of
# silent native crash (0xC0000005) that KMP_DUPLICATE_LIB_OK alone
# does not cover. This is why the fix above wasn't sufficient by itself.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# ✅ FIX: this script only ever uses the PyTorch backend (see load_model()
# below — torch.set_num_threads() + AutoModelForSeq2SeqLM straight to a
# .pth/.bin checkpoint). `transformers` nonetheless probes for TensorFlow
# at import time and, if TF is installed on the machine, eagerly imports
# TF-generated protobuf stub modules. Those stubs were compiled against a
# protobuf runtime that ships `runtime_version` (protobuf>=4.24). If the
# environment's installed `protobuf` package predates that, the import
# blows up with exactly the error seen in production:
#   "cannot import name 'runtime_version' from 'google.protobuf'"
# Forcing transformers to skip TF/Flax entirely means it never touches
# that incompatible codepath, regardless of what else is pip-installed.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("USE_FLAX", "0")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")


# AFTER
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except ModuleNotFoundError:
    # python-dotenv isn't installed in this interpreter's env. Harmless —
    # HF_TOKEN and friends are already inherited from the parent Node
    # process's environment (confirmed by the debug print above), so this
    # script does not actually depend on re-parsing the .env file itself.
    print("[WARN] python-dotenv not installed — continuing with inherited environment variables", file=sys.stderr)


# --- Compatibility shim -----------------------------------------------------
# Newer `transformers` releases stopped re-exporting PreTrainedTokenizerBase
# from transformers.tokenization_utils (it now only lives in
# transformers.tokenization_utils_base). IndicTransToolkit's processor module
# still does `from transformers.tokenization_utils import PreTrainedTokenizerBase`,
# which raises this ImportError on newer transformers builds. Patch the name
# back onto the old module path before IndicTransToolkit gets imported.
try:
    import transformers.tokenization_utils as _tu
    if not hasattr(_tu, "PreTrainedTokenizerBase"):
        from transformers.tokenization_utils_base import PreTrainedTokenizerBase as _PTB
        _tu.PreTrainedTokenizerBase = _PTB
except Exception as _shim_err:
    print(f"[WARN] transformers compat shim did not apply: {_shim_err}", file=sys.stderr)
# -----------------------------------------------------------------------------

FLORES_MAP = {
    "hi": "hin_Deva", "bn": "ben_Beng", "ta": "tam_Taml", "te": "tel_Telu",
    "mr": "mar_Deva", "gu": "guj_Gujr", "kn": "kan_Knda", "ml": "mal_Mlym",
    "pa": "pan_Guru", "ur": "urd_Arab", "en": "eng_Latn", "as": "asm_Beng",
    "or": "ory_Orya"
}

def load_model(src_lang, tgt_lang, lora_path=None):
    import torch, time
    torch.set_num_threads(1)
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    if src_lang == "en":
        ckpt = "ai4bharat/indictrans2-en-indic-dist-200M"
    elif tgt_lang == "en":
        ckpt = "ai4bharat/indictrans2-indic-en-dist-200M"
    else:
        ckpt = "ai4bharat/indictrans2-indic-indic-dist-320M"

    print(f"[DEBUG][load_model] checkpoint selected: {ckpt}", file=sys.stderr)
    t0 = time.time()
    hf_token = os.environ.get("HF_TOKEN")
    tokenizer = AutoTokenizer.from_pretrained(ckpt, trust_remote_code=True, token=hf_token)
    model = AutoModelForSeq2SeqLM.from_pretrained(ckpt, trust_remote_code=True, token=hf_token)
    print(f"[DEBUG][load_model] tokenizer+model loaded in {time.time()-t0:.2f}s", file=sys.stderr)

    if lora_path and os.path.exists(lora_path):
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, lora_path)
        print(f"[+] LoRA adapter loaded from {lora_path}", file=sys.stderr)
    elif lora_path:
        print(f"[DEBUG][load_model] LoRA path given but does not exist: {lora_path}", file=sys.stderr)

    model.eval()
    return tokenizer, model, ckpt

def translate(text, src_lang, tgt_lang, lora_path=None):
    import time
    from IndicTransToolkit.processor import IndicProcessor
    import torch, re

    t_start = time.time()
    src_flores = FLORES_MAP.get(src_lang, "eng_Latn")
    tgt_flores = FLORES_MAP.get(tgt_lang, "hin_Deva")
    print(f"[DEBUG][translate] {src_lang}->{tgt_lang}  (flores: {src_flores}->{tgt_flores})", file=sys.stderr)
    print(f"[DEBUG][translate] input text ({len(text)} chars): {text[:200]!r}", file=sys.stderr)

    tokenizer, model, ckpt = load_model(src_lang, tgt_lang, lora_path)
    ip = IndicProcessor(inference=True)

    sentences = [s.strip() for s in re.split(r'(?<!\d)\.(?!\d)', text) if s.strip()] or [text]
    print(f"[DEBUG][translate] split into {len(sentences)} sentence(s)", file=sys.stderr)

    batch = ip.preprocess_batch(sentences, src_lang=src_flores, tgt_lang=tgt_flores)
    inputs = tokenizer(batch, truncation=True, padding="longest", return_tensors="pt")

    t_gen_start = time.time()
    with torch.no_grad():
        generated = model.generate(
            **inputs, use_cache=True, min_length=0, max_length=256,
            num_beams=5, num_return_sequences=1,
            repetition_penalty=1.3, no_repeat_ngram_size=4, early_stopping=True
        )
    print(f"[DEBUG][translate] generation took {time.time()-t_gen_start:.2f}s", file=sys.stderr)

    decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
    print(f"[DEBUG][translate] raw decoded (pre-postprocess): {decoded}", file=sys.stderr)
    translated = ip.postprocess_batch(decoded, lang=tgt_flores)
    result_text = " ".join(translated)
    print(f"[DEBUG][translate] final text: {result_text[:200]!r}", file=sys.stderr)
    print(f"[DEBUG][translate] total time: {time.time()-t_start:.2f}s", file=sys.stderr)

    m = re.search(r"(.{1,4})\1{4,}", result_text)
    if m or (len(set(result_text.replace(" ", ""))) < 6 and len(result_text) > 20):
        raise RuntimeError(
            f"Translation degenerated into repetition (source text may be unclear/too short): {result_text[:80]!r}"
        )

    return result_text, ckpt

# NEW — place after translate(), before qe_score_comet()
def translate_multiple(texts, src_lang, tgt_lang, lora_path=None):
    """Translates a list of independent texts in ONE model load + ONE batched
    generate() call. Used for multi-segment jobs — translate() was previously
    invoked once per segment, each call reloading the ~14-19s tokenizer+model
    from scratch (confirmed on a real job: 5 separate loads for one job,
    60-95s spent on nothing but redundant model loading)."""
    import time, re
    from IndicTransToolkit.processor import IndicProcessor
    import torch

    t_start = time.time()
    src_flores = FLORES_MAP.get(src_lang, "eng_Latn")
    tgt_flores = FLORES_MAP.get(tgt_lang, "hin_Deva")
    print(f"[DEBUG][translate_multiple] {src_lang}->{tgt_lang}, {len(texts)} text(s)", file=sys.stderr)

    tokenizer, model, ckpt = load_model(src_lang, tgt_lang, lora_path)
    ip = IndicProcessor(inference=True)

    # Keep a placeholder for empty strings so positions stay aligned with the
    # input list — IndicProcessor doesn't handle empty entries well.
    clean_texts = [t.strip() if t and t.strip() else " " for t in texts]
    batch = ip.preprocess_batch(clean_texts, src_lang=src_flores, tgt_lang=tgt_flores)
    inputs = tokenizer(batch, truncation=True, padding="longest", return_tensors="pt")

    t_gen_start = time.time()
    with torch.no_grad():
        generated = model.generate(
            **inputs, use_cache=True, min_length=0, max_length=256,
            num_beams=5, num_return_sequences=1,
            repetition_penalty=1.3, no_repeat_ngram_size=4, early_stopping=True
        )
    print(f"[DEBUG][translate_multiple] batched generation took {time.time()-t_gen_start:.2f}s for {len(texts)} text(s)", file=sys.stderr)

    decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
    translated = ip.postprocess_batch(decoded, lang=tgt_flores)
    print(f"[DEBUG][translate_multiple] total time: {time.time()-t_start:.2f}s", file=sys.stderr)

    results = []
    for orig, out in zip(texts, translated):
        if not orig or not orig.strip():
            results.append("")
            continue
        m = re.search(r"(.{1,4})\1{4,}", out)
        degenerate = bool(m) or (len(set(out.replace(" ", ""))) < 6 and len(out) > 20)
        results.append(None if degenerate else out)
    return results, ckpt

def qe_score_comet(source_text, translated_text):
    """Reference-free quality estimation via COMET-Kiwi (Unbabel/wmt22-cometkiwi-da)."""
    from comet import download_model, load_from_checkpoint
    model_path = download_model("Unbabel/wmt22-cometkiwi-da")
    model = load_from_checkpoint(model_path)
    data = [{"src": source_text, "mt": translated_text}]
    output = model.predict(data, batch_size=1, gpus=0)
    return float(output.scores[0])


# ===== FALLBACK QE: cross-lingual semantic similarity (LaBSE) =====
# NOTE ON THE ORIGINAL PROPOSAL: the original doc suggested falling back to chrF++ when
# COMET is unavailable. chrF++ is reference-based (it compares MT output against a human
# reference translation) and this pipeline has no reference translations at inference
# time, so chrF++ can never actually run here — that was a genuine dead end, not
# something more code could fix.
#
# What CAN work with no reference: LaBSE (Language-agnostic BERT Sentence Embedding,
# Apache-2.0, free, sentence-transformers/LaBSE) embeds the ORIGINAL text and the
# TRANSLATED text into the same multilingual vector space and compares them directly
# by cosine similarity. This is reference-free, like COMET-Kiwi, so it is a legitimate
# drop-in fallback rather than a workaround.
_LABSE_MODEL = None

def qe_score_labse(source_text, translated_text):
    global _LABSE_MODEL
    from sentence_transformers import SentenceTransformer
    import numpy as np

    if _LABSE_MODEL is None:
        _LABSE_MODEL = SentenceTransformer("sentence-transformers/LaBSE")

    embeddings = _LABSE_MODEL.encode([source_text, translated_text], normalize_embeddings=True)
    cosine_sim = float(np.dot(embeddings[0], embeddings[1]))
    # LaBSE cosine similarity for well-aligned translation pairs typically falls in the
    # 0.5-0.9 range; rescale roughly onto the same 0-1 "quality-ish" band COMET-Kiwi uses
    # so downstream thresholding logic doesn't need two different scales.
    rescaled = max(0.0, min(1.0, (cosine_sim - 0.2) / 0.7))
    return rescaled


# AFTER
def qe_score(source_text, translated_text):
    # ✅ FIX: Unbabel/wmt22-cometkiwi-da is gated and this HF token is not on
    # the authorized list — confirmed 403 GatedRepoError on every single call
    # across an entire job (5/5). Every attempt wasted several seconds on a
    # doomed HF download before falling back to LaBSE anyway. Skip the
    # attempt outright until access is granted; flip DISABLE_COMET_QE=0 in
    # .env the moment that happens, with zero code changes needed.
    if os.environ.get("DISABLE_COMET_QE", "1") != "0":
        try:
            score = qe_score_labse(source_text, translated_text)
            print(f"[DEBUG][qe_score] LaBSE succeeded (COMET disabled via DISABLE_COMET_QE): {score:.4f}", file=sys.stderr)
            return score, "labse-cosine"
        except Exception as e2:
            print(f"⚠️ LaBSE unavailable ({e2}); skipping quality score", file=sys.stderr)
            return None, None

    try:
        score = qe_score_comet(source_text, translated_text)
        print(f"[DEBUG][qe_score] COMET-Kiwi succeeded: {score:.4f}", file=sys.stderr)
        return score, "comet-kiwi"
    except Exception as e:
        print(f"⚠️ COMET QE unavailable ({e}); falling back to LaBSE semantic similarity", file=sys.stderr)
        try:
            score = qe_score_labse(source_text, translated_text)
            print(f"[DEBUG][qe_score] LaBSE fallback succeeded: {score:.4f}", file=sys.stderr)
            return score, "labse-cosine"
        except Exception as e2:
            print(f"⚠️ LaBSE fallback also unavailable ({e2}); skipping quality score", file=sys.stderr)
            return None, None
# AFTER
if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("text", nargs="?", default=None)
    p.add_argument("src_lang")
    p.add_argument("tgt_lang")
    p.add_argument("output_json")
    p.add_argument("--lora_path", default=None)
    p.add_argument("--skip_qe", action="store_true")
    # ✅ NEW: batch mode — translates every text in the JSON list with ONE
    # model load instead of one subprocess call per text.
    p.add_argument("--batch_file", default=None,
                    help="Path to a JSON file containing a list of texts to translate together.")
    args = p.parse_args()

    result = {"success": True}
    try:
        if args.batch_file:
            with open(args.batch_file, "r", encoding="utf-8") as f:
                texts = json.load(f)
            translated_list, ckpt = translate_multiple(texts, args.src_lang, args.tgt_lang, args.lora_path)
            items = []
            for src_text, translated_text in zip(texts, translated_list):
                if translated_text is None:
                    items.append({"success": False, "error": "degenerate output", "text": src_text})
                    continue
                item = {"success": True, "text": translated_text, "model": ckpt, "engine": "indictrans2"}
                if not args.skip_qe and translated_text:
                    score, method = qe_score(src_text, translated_text)
                    item["qe_score"] = score
                    item["qe_method"] = method
                items.append(item)
            result["results"] = items
        else:
            translated_text, ckpt = translate(args.text, args.src_lang, args.tgt_lang, args.lora_path)
            result["text"] = translated_text
            result["model"] = ckpt
            result["engine"] = "indictrans2"
            if not args.skip_qe:
                score, method = qe_score(args.text, translated_text)
                result["qe_score"] = score
                result["qe_method"] = method
    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(f"❌ {e}", file=sys.stderr)

    os.makedirs(os.path.dirname(args.output_json), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    sys.exit(0 if result["success"] else 1)