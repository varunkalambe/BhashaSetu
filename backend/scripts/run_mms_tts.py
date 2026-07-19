import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse, json, os, sys, warnings
warnings.filterwarnings("ignore")

# facebook/mms-tts model codes differ from ISO-639-1; map app codes -> ordered lists of
# candidate MMS ISO-639-3 codes to try at RUNTIME (verified against the HF Hub before
# download, instead of requiring a manual one-time lookup before the demo).
MMS_LANG_CANDIDATES = {
    "sd":  ["snd"],
    "mni": ["mni", "mnw", "hne"],   # mni = Meitei/Manipuri per ISO 639-3; extra fallbacks
                                     # are defensive only and will be skipped if not on the Hub
    "as":  ["asm"],
    "or":  ["ory"],
}


def _repo_exists(repo_id):
    """Check the HF Hub for a repo's existence without downloading it."""
    try:
        from huggingface_hub import HfApi
        HfApi().model_info(repo_id)
        return True
    except Exception:
        return False


def resolve_model_id(lang_code):
    """
    Resolve `lang_code` to a working facebook/mms-tts-<iso> repo id by checking
    each candidate against the HF Hub in order. Raises with a clear, actionable
    message if none of the candidates exist, instead of failing deep inside
    the VITS loader with an opaque 404.
    """
    candidates = MMS_LANG_CANDIDATES.get(lang_code, [lang_code])
    tried = []
    for code in candidates:
        repo_id = f"facebook/mms-tts-{code}"
        tried.append(repo_id)
        if _repo_exists(repo_id):
            return repo_id, code
    raise RuntimeError(
        f"No MMS-TTS checkpoint found for '{lang_code}'. Tried: {', '.join(tried)}. "
        f"Check https://huggingface.co/facebook/mms-tts for the exact ISO 639-3 code "
        f"and add it to MMS_LANG_CANDIDATES in run_mms_tts.py."
    )


def synthesize(text, output_path, lang_code):
    import torch
    from transformers import VitsModel, AutoTokenizer
    import scipy.io.wavfile as wavfile

    model_id, resolved_code = resolve_model_id(lang_code)

    model = VitsModel.from_pretrained(model_id)
    tokenizer = AutoTokenizer.from_pretrained(model_id)

    inputs = tokenizer(text, return_tensors="pt")
    with torch.no_grad():
        output = model(**inputs).waveform

    waveform = output.squeeze().numpy()
    wavfile.write(output_path, model.config.sampling_rate, waveform)
    return model_id, resolved_code


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("text")
    p.add_argument("output_path")
    p.add_argument("lang_code")
    p.add_argument("result_json")
    args = p.parse_args()

    os.makedirs(os.path.dirname(args.output_path), exist_ok=True)
    result = {"success": True}
    try:
        model_id, resolved_code = synthesize(args.text, args.output_path, args.lang_code)
        result["audio_path"] = args.output_path
        result["model"] = model_id
        result["resolved_iso_code"] = resolved_code
        result["license_note"] = "CC-BY-NC-4.0: non-commercial/academic use only"
    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(f"❌ {e}", file=sys.stderr)

    os.makedirs(os.path.dirname(args.result_json), exist_ok=True)
    with open(args.result_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    sys.exit(0 if result["success"] else 1)