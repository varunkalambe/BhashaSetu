import sys
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)

import argparse, json, os, re, shutil, subprocess, tempfile, threading, traceback

def _default_mfa_bin():
    """
    'mfa' is an external console-script binary that lives inside the SAME
    conda env as this python interpreter (Scripts/ on Windows, bin/ on
    Unix/Mac) — but subprocess.run(["mfa", ...]) only finds it by searching
    PATH, which is inherited from whatever shell launched the pipeline. If
    that shell never ran `conda activate bhashasetu-mfa`, 'mfa' won't be on
    PATH even though THIS script is still executed by the correct python.exe
    (the orchestrator resolves that explicitly) — that mismatch is exactly
    what produced "[WinError 2] The system cannot find the file specified".
    Resolve the binary relative to sys.executable instead of trusting PATH.
    """
    env_dir = os.path.dirname(sys.executable)
    candidates = [
        os.path.join(env_dir, "Scripts", "mfa.exe"),
        os.path.join(env_dir, "Scripts", "mfa"),
        os.path.join(env_dir, "mfa.exe"),
        os.path.join(env_dir, "bin", "mfa"),
        os.path.join(env_dir, "mfa"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return "mfa"  # last resort: hope PATH has it

def _mfa_subprocess_env(mfa_bin_path):
    """
    MFA's own alignment step shells out to bundled Kaldi/sox/OpenFst binaries
    that live in the SAME conda env as mfa_bin_path itself — which may be a
    DIFFERENT env than the one running this orchestrator script (e.g. an
    isolated bhashasetu-mfa-tool env, kept separate specifically to avoid
    numpy/scipy/scikit-learn ABI conflicts with the main torch/transformers
    env). Resolve relative to mfa_bin_path, not sys.executable, so this
    stays correct no matter which env MFA itself lives in.
    """
    bin_dir = os.path.dirname(os.path.abspath(mfa_bin_path))
    # mfa.exe normally lives in <envdir>\Scripts\mfa.exe on Windows —
    # step up one level to get the actual env root so Library\bin is found.
    env_dir = os.path.dirname(bin_dir) if os.path.basename(bin_dir).lower() == "scripts" else bin_dir

    extra = [
        env_dir,
        os.path.join(env_dir, "Scripts"),
        os.path.join(env_dir, "Library", "bin"),
        os.path.join(env_dir, "bin"),
    ]
    merged = os.environ.copy()
    merged["PATH"] = os.pathsep.join(p for p in extra if os.path.isdir(p)) + os.pathsep + merged.get("PATH", "")
    return merged

def build_corpus(audio_path, transcript_text, corpus_dir):
    os.makedirs(corpus_dir, exist_ok=True)
    base = "utt"
    wav_dst = os.path.join(corpus_dir, f"{base}.wav")
    lab_dst = os.path.join(corpus_dir, f"{base}.lab")
    shutil.copy(audio_path, wav_dst)
    with open(lab_dst, "w", encoding="utf-8") as f:
        f.write(transcript_text.strip())
    print(f"[mfa-debug] corpus dir: {corpus_dir}")
    print(f"[mfa-debug] corpus contents: {os.listdir(corpus_dir)}")
    return base

def parse_textgrid(tg_path):
    content = open(tg_path, encoding="utf-8").read()
    words = []
    tiers = re.findall(r'name = "words".*?intervals: size = \d+(.*?)(?:item \[\d+\]:|$)', content, re.S)
    if not tiers:
        return words
    block = tiers[0]
    intervals = re.findall(r'xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"', block)
    for xmin, xmax, text in intervals:
        text = text.strip()
        if text and text not in ("sil", "sp", ""):
            words.append({"word": text, "start": float(xmin), "end": float(xmax), "probability": 1.0})
    return words

MFA_MODEL_NAMES = {
    "en": "english_mfa",
    "ta": "tamil_cv",
}

# ✅ NEW: optional per-language config file, checked BEFORE the single flat
# env var. This is what actually lets all six Indic languages have their own
# independently-registered model, instead of one global override that would
# apply to every language request regardless of which one was asked for.
#
# The file does NOT need to exist. If it's missing, or a language isn't in
# it, behavior falls through exactly as it does today (flat env var, then
# hardcoded en/ta defaults, then the existing error -> Whisper fallback).
# You add languages to it ONE AT A TIME, only once you've actually downloaded
# that language's IndicMFA release assets — no code changes ever needed
# again after this.
#
# Expected shape of backend/config/mfa_indic_models.json:
# {
#   "hi": {"acoustic": "hi_indic_mfa", "dictionary": "hi_indic_mfa"},
#   "bn": {"acoustic": "bn_indic_mfa", "dictionary": "bn_indic_mfa"},
#   "gu": {"acoustic": "gu_indic_mfa", "dictionary": "gu_indic_mfa"},
#   "kn": {"acoustic": "kn_indic_mfa", "dictionary": "kn_indic_mfa"},
#   "mr": {"acoustic": "mr_indic_mfa", "dictionary": "mr_indic_mfa"},
#   "pa": {"acoustic": "pa_indic_mfa", "dictionary": "pa_indic_mfa"}
# }
_MFA_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "mfa_indic_models.json")

def _load_per_language_mfa_config():
    """Best-effort, never raises. Missing file = today's behavior, unchanged."""
    if not os.path.exists(_MFA_CONFIG_PATH):
        return {}
    try:
        with open(_MFA_CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[mfa-debug] could not parse {_MFA_CONFIG_PATH}: {e} — ignoring it, falling back", file=sys.stderr)
        return {}

def _stream_subprocess(cmd, env=None):
    import subprocess
    import sys
    
    # Ensure Windows resolves the command properly by using shell=True
    # or by explicitly calling the python module for mfa
    if isinstance(cmd, list) and cmd[0] == 'mfa':
        cmd = [sys.executable, '-m', 'mfa'] + cmd[1:]

    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False # Keep False since we resolved sys.executable
    )
    
    output = []
    for line in proc.stdout:
        print(line, end='')
        output.append(line)
        
    proc.wait()
    return proc.returncode, "".join(output)
    
def _list_locally_saved_models(mfa_bin, mfa_env, model_type="acoustic"):
    """
    Heavy debug helper: ask MFA itself what models of this type are already
    saved locally (via a prior `mfa model download` or `mfa model save`), so
    a missing-model failure prints something you can actually act on instead
    of a bare 'no model available' with no visibility into what IS there.
    Best-effort — never raises, this is diagnostics only.
    """
    try:
        result = subprocess.run(
            [mfa_bin, "model", "list", model_type],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=mfa_env, timeout=30,
        )
        return (result.stdout or "(empty)").strip()
    except Exception as e:
        return f"(could not list local {model_type} models: {e})"


def run_mfa(audio_path, transcript_text, language, jobId, output_json):
    mfa_bin = os.environ.get("MFA_PYTHON_PATH") or _default_mfa_bin()
    mfa_env = _mfa_subprocess_env(mfa_bin)

    # ✅ FIX: resolution order is now —
    #   1. per-language JSON config (real multi-language support, the actual fix)
    #   2. flat env var override (kept for quick single-language manual testing —
    #      same as before, just no longer takes priority over a real per-language entry)
    #   3. hardcoded verified defaults (en/ta — unchanged, zero risk to those)
    #   4. error -> caller falls back to Whisper timestamps (unchanged today)
    per_lang_config = _load_per_language_mfa_config()
    lang_entry = per_lang_config.get(language, {})

    acoustic_model = (
        lang_entry.get("acoustic")
        or os.environ.get("MFA_ACOUSTIC_MODEL")
        or MFA_MODEL_NAMES.get(language)
    )
    dictionary = (
        lang_entry.get("dictionary")
        or os.environ.get("MFA_DICTIONARY")
        or MFA_MODEL_NAMES.get(language)
    )
    print(f"[mfa-debug] per-language config entry for '{language}': {lang_entry or '(none found — checked ' + _MFA_CONFIG_PATH + ')'}")

    print(f"[mfa-debug] sys.executable: {sys.executable}")
    print(f"[mfa-debug] resolved mfa binary: {mfa_bin}")
    print(f"[mfa-debug] mfa binary exists on disk: {os.path.exists(mfa_bin)}")
    print(f"[mfa-debug] language requested: '{language}'")
    print(f"[mfa-debug] MFA_ACOUSTIC_MODEL env override: {os.environ.get('MFA_ACOUSTIC_MODEL') or '(not set)'}")
    print(f"[mfa-debug] MFA_DICTIONARY env override: {os.environ.get('MFA_DICTIONARY') or '(not set)'}")
    print(f"[mfa-debug] builtin default for '{language}': {MFA_MODEL_NAMES.get(language) or '(none — only en/ta are built in)'}")
    print(f"[mfa-debug] resolved acoustic_model = {acoustic_model!r}, dictionary = {dictionary!r}")
    print(f"[mfa-debug] PATH entries added for this subprocess: {[p for p in mfa_env['PATH'].split(os.pathsep) if os.path.dirname(sys.executable) in p][:4]}")

    if not acoustic_model or not dictionary:
        locally_saved = _list_locally_saved_models(mfa_bin, mfa_env, "acoustic")
        raise RuntimeError(
            f"No MFA acoustic model/dictionary configured for language '{language}'; "
            f"caller should fall back to Whisper timestamps.\n"
            f"[mfa-debug] Acoustic models MFA already knows about locally:\n{locally_saved}\n"
f"[HINT] To add real forced alignment for '{language}': get an MFA-compatible "
        f"acoustic model + pronunciation dictionary for it — e.g. AI4Bharat's IndicMFA "
        f"project (https://github.com/AI4Bharat/IndicMFA/releases) — check that project's "
        f"release page for '{language}' specifically, asset completeness varies by language. "
        f"Then register them locally with:\n"
        f"  mfa model save acoustic <path-to-model.zip> --name {language}_indic_mfa\n"
        f"  mfa model save dictionary <path-to-dict> --name {language}_indic_mfa\n"
        f"and add ONE entry to backend/config/mfa_indic_models.json (create the file if it "
        f"doesn't exist yet):\n"
        f'  \"{language}\": {{\"acoustic\": \"{language}_indic_mfa\", \"dictionary\": \"{language}_indic_mfa\"}}\n'
        f"No further code changes needed — this script checks that file first, per language, "
        f"independently of every other language."        )

    # ✅ NEW: fast precheck. `mfa model inspect` resolves in ~1-2s and tells us
    # whether the resolved acoustic model/dictionary are actually usable
    # BEFORE paying for corpus build + a full multi-pass Kaldi alignment run
    # that would otherwise fail at the very end with a much less clear error.
    # Best-effort/diagnostic only — never blocks the known-good en/ta path.
    for kind, name in (("acoustic", acoustic_model), ("dictionary", dictionary)):
        try:
            inspect_result = subprocess.run(
                [mfa_bin, "model", "inspect", kind, name],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                env=mfa_env, timeout=30,
            )
            print(f"[mfa-debug] `mfa model inspect {kind} {name}` exit code: {inspect_result.returncode}")
            if inspect_result.returncode != 0:
                combined = (inspect_result.stdout or "") + (inspect_result.stderr or "")
                print(f"[mfa-debug] inspect output: {combined[:500]}")
        except Exception as inspect_err:
            print(f"[mfa-debug] could not run `mfa model inspect {kind} {name}`: {inspect_err}")

    with tempfile.TemporaryDirectory() as tmp:
        corpus_dir = os.path.join(tmp, "corpus")
        out_dir = os.path.join(tmp, "aligned")
        base = build_corpus(audio_path, transcript_text, corpus_dir)

        cmd = [mfa_bin, "align", corpus_dir, dictionary, acoustic_model, out_dir, "--clean", "--overwrite"]
        print(f"[+] Running: {' '.join(cmd)}")

        # No time limit — first run can download the acoustic model +
        # dictionary over the network, and alignment itself is a multi-pass
        # Kaldi job whose duration scales with audio length.
        returncode, output = _stream_subprocess(cmd, env=mfa_env)

        if returncode != 0:
            hint = ""
            lower_out = output.lower()
            if "could not find" in lower_out or "not found" in lower_out or "no such" in lower_out:
                hint = (
                    f"\n[HINT] This looks like MFA can't find the '{dictionary}' dictionary or "
                    f"'{acoustic_model}' acoustic model. If you haven't downloaded them yet, run "
                    f"(in the bhashasetu-mfa env):\n"
                    f"  mfa model download acoustic {acoustic_model}\n"
                    f"  mfa model download dictionary {dictionary}\n"
                    f"then re-run this pipeline."
                )
            raise RuntimeError(f"MFA failed (exit code {returncode}): {output[-3000:]}{hint}")

        tg_path = os.path.join(out_dir, f"{base}.TextGrid")
        if not os.path.exists(tg_path):
            print(f"[mfa-debug] out_dir contents: {os.listdir(out_dir) if os.path.exists(out_dir) else '(missing)'}")
            raise RuntimeError(f"MFA did not produce TextGrid at {tg_path}")

        words = parse_textgrid(tg_path)
        print(f"[mfa-debug] parsed {len(words)} word intervals from TextGrid")
        return {
            "words": words,
            "segments": [{"text": transcript_text, "start": 0.0,
                          "end": words[-1]["end"] if words else 0.0, "words": words}],
            "alignment_source": "mfa_kaldi"
        }

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("audio_path")
    p.add_argument("transcript_text")
    p.add_argument("language")
    p.add_argument("jobId")
    p.add_argument("output_json")
    args = p.parse_args()

    result = {"success": True}
    try:
        result.update(run_mfa(args.audio_path, args.transcript_text, args.language, args.jobId, args.output_json))
    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(f"❌ MFA alignment failed, caller should fall back to Whisper word timings: {e}", file=sys.stderr)
        print("[mfa-debug] full traceback:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    os.makedirs(os.path.dirname(args.output_json), exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    sys.exit(0 if result["success"] else 1)