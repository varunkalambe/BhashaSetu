import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

"""
Benchmarks the actual pipeline stages against a real audio/video clip and
prints a stage-by-stage timing table — replaces the theoretical 5-13 min
estimate from the original architecture doc with measured numbers on your
actual hardware.

Usage: python backend/scripts/benchmark_pipeline.py --video path/to/clip.mp4
"""
import argparse, subprocess, sys, time, json, os, tempfile, threading

STAGES = []

def timed(name):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            t0 = time.time()
            ok, detail = True, None
            try:
                result = fn(*args, **kwargs)
            except Exception as e:
                ok, detail = False, str(e)
                result = None
            elapsed = time.time() - t0
            STAGES.append({"stage": name, "seconds": round(elapsed, 2), "success": ok, "error": detail})
            print(f"[{'✅' if ok else '❌'}] {name}: {elapsed:.2f}s" + (f" ({detail})" if detail else ""))
            return result
        return wrapper
    return decorator

def _clean_tail(text, n_lines=40):
    lines = text.replace('\r', '\n').split('\n')
    lines = [l for l in lines if l.strip()]
    return '\n'.join(lines[-n_lines:])

def run(cmd, timeout=None, stage_name=None, env=None):
    """
    Streams the child process's stdout/stderr to the console live (prefixed
    with stage_name) instead of capturing silently until it exits.
    timeout=None means NO TIME LIMIT — this pipeline's stages (whisper,
    demucs, mfa) can legitimately run long on CPU-only hardware, and killing
    them early was never the right fix. env defaults to SUBPROCESS_ENV
    (set in check_environment()), which has the pipeline conda env's own
    bin folders added to PATH — this is what makes external tools like
    'mfa' findable even when the outer shell never activated that env.
    """
    is_shell = isinstance(cmd, str)
    proc = subprocess.Popen(
        cmd, shell=is_shell,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding='utf-8', errors='replace', bufsize=1,
        env=env if env is not None else SUBPROCESS_ENV,
    )

    out_lines, err_lines = [], []
    tag = f"[{stage_name}] " if stage_name else ""

    def _pump(stream, sink):
        for line in iter(stream.readline, ''):
            sink.append(line)
            print(f"{tag}{line.rstrip()}", flush=True)
        stream.close()

    t_out = threading.Thread(target=_pump, args=(proc.stdout, out_lines), daemon=True)
    t_err = threading.Thread(target=_pump, args=(proc.stderr, err_lines), daemon=True)
    t_out.start(); t_err.start()

    try:
        returncode = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        t_out.join(timeout=2); t_err.join(timeout=2)
        tail = _clean_tail(''.join(out_lines) + '\n' + ''.join(err_lines))
        raise RuntimeError(
            f"'{stage_name or cmd}' exceeded {timeout}s and was killed. "
            f"Last output before the kill:\n{tail}"
        )

    t_out.join(); t_err.join()
    stdout, stderr = ''.join(out_lines), ''.join(err_lines)

    if returncode != 0:
        log_path = os.path.join(tempfile.gettempdir(), "bhashasetu_last_error.log")
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("===== STDOUT =====\n" + stdout + "\n\n===== STDERR =====\n" + stderr)
        combined = _clean_tail(stdout + "\n" + stderr)
        raise RuntimeError(combined + f"\n[full log: {log_path}]")

    class _Result: pass
    result = _Result()
    result.stdout, result.stderr, result.returncode = stdout, stderr, returncode
    return result

@timed("audio_extraction_ffmpeg")
def extract_audio(video_path, out_wav):
    run(f'ffmpeg -y -i "{video_path}" -ar 16000 -ac 1 -acodec pcm_s16le "{out_wav}"', stage_name="ffmpeg")

@timed("demucs_separation")
def run_demucs(wav_path, out_dir):
    run([PY, "scripts/run_demucs.py", wav_path, out_dir, os.path.join(out_dir, "result.json"), "--quality", "fast"], stage_name="demucs")

@timed("whisper_transcription")
def run_whisper(wav_path, out_json, lang):
    # No time limit — CPU word-level alignment legitimately takes as long as it takes.
    # First run with "medium" will trigger an automatic one-time model download
    # (~1.5GB) inside run_whisper.py before transcription proceeds.
    run([PY, "scripts/run_whisper.py", wav_path, out_json, "--language", lang, "--model_size", "medium"],
        stage_name="whisper")

@timed("diarization_prosody")
def run_diarize(wav_path, out_json):
    run([PY, "scripts/run_diarize_prosody.py", wav_path, out_json], stage_name="diarize")

@timed("indictrans2_translation")
def run_translate(text, src, tgt, out_json):
    run([PY, "scripts/run_indictrans2.py", text, src, tgt, out_json, "--skip_qe"], stage_name="indictrans2")

@timed("tts_synthesis")
def run_tts(text, out_wav, voice, retries=3):
    # edge-tts is an unofficial wrapper around Microsoft Edge's internal TTS
    # endpoint. NoAudioReceived is a widely-reported issue tied to Microsoft's
    # server-side token/header requirements drifting, not this script — and
    # it's often transient. Retry a few times before giving up; if it never
    # succeeds, `pip install --upgrade edge-tts` (or pin edge-tts==7.2.1).
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            run(f'edge-tts --voice "{voice}" --text "{text}" --write-media "{out_wav}"', stage_name="tts")
            return
        except RuntimeError as e:
            last_err = e
            if "NoAudioReceived" in str(e) and attempt < retries:
                print(f"[tts] attempt {attempt}/{retries} failed (NoAudioReceived) — retrying in 3s...")
                time.sleep(3)
                continue
            raise
    raise last_err

@timed("mfa_forced_alignment")
def run_mfa(wav_path, text, lang, job_id, out_json):
    run([PY, "scripts/run_mfa_align.py", wav_path, text, lang, job_id, out_json], stage_name="mfa")

PIPELINE_CONDA_ENV = "bhashasetu-mfa"
PY = sys.executable        # resolved to the correct interpreter by check_environment() below
SUBPROCESS_ENV = os.environ.copy()  # augmented with the pipeline env's bin dirs by check_environment() below

def _augmented_env(python_path):
    """
    External console-script binaries (mfa, and potentially others down the
    line) that ship inside the 'bhashasetu-mfa' conda env only get found via
    PATH — but PATH is inherited from whatever shell launched this script,
    and if that shell never ran `conda activate bhashasetu-mfa`, those
    binaries' folders simply aren't on it. This is exactly what caused the
    WinError 2 on the mfa stage even though whisper/demucs/indictrans2 all
    ran fine (those only need the right PYTHON, resolved as an absolute
    path — no PATH lookup involved). Fix it generally: derive the env's bin
    folders from the resolved interpreter's own location and prepend them.
    """
    env_dir = os.path.dirname(python_path)
    extra = [
        env_dir,
        os.path.join(env_dir, "Scripts"),        # Windows conda env console scripts
        os.path.join(env_dir, "Library", "bin"), # Windows conda env native tools (sox, kaldi, etc.)
        os.path.join(env_dir, "bin"),             # Linux/Mac conda env
    ]
    merged = os.environ.copy()
    merged["PATH"] = os.pathsep.join(p for p in extra if os.path.isdir(p)) + os.pathsep + merged.get("PATH", "")
    return merged

def resolve_pipeline_python():
    """
    Every subprocess this script launches needs the 'bhashasetu-mfa' conda
    env's python (that's where demucs/whisper_timestamped/torch live) — not
    necessarily whatever python is running this orchestrator script itself.
    Resolve it directly instead of assuming sys.executable is correct, so
    this works even if you forgot to `conda activate` before running it.
    """
    # 1) Already running inside the right env? Use ourselves, no extra work.
    try:
        import demucs  # noqa: F401
        return sys.executable, None
    except ImportError:
        pass

    # 2) Ask conda directly where that env lives.
    try:
        out = subprocess.run(["conda", "info", "--envs", "--json"],
                              capture_output=True, text=True, timeout=15)
        envs = json.loads(out.stdout).get("envs", [])
        for env_path in envs:
            if os.path.basename(env_path.rstrip("\\/")) == PIPELINE_CONDA_ENV:
                candidate = os.path.join(env_path, "python.exe" if os.name == "nt" else "bin/python")
                if os.path.exists(candidate):
                    return candidate, None
    except Exception:
        pass

    # 3) Common install locations as a last-resort guess.
    home = os.path.expanduser("~")
    for base in ("miniconda3", "anaconda3", "Anaconda3", "Miniconda3"):
        candidate = os.path.join(home, base, "envs", PIPELINE_CONDA_ENV,
                                  "python.exe" if os.name == "nt" else "bin/python")
        if os.path.exists(candidate):
            return candidate, None

    return None, (
        f"Could not find the '{PIPELINE_CONDA_ENV}' conda env automatically.\n"
        f"Fix: run 'conda activate {PIPELINE_CONDA_ENV}' before this script, "
        f"or make sure 'conda' is on PATH so this script can locate it."
    )

def check_environment():
    global PY, SUBPROCESS_ENV
    resolved, err = resolve_pipeline_python()
    if err:
        print(f"[ERROR] Running under: {sys.executable}")
        print(f"[ERROR] {err}")
        sys.exit(1)
    PY = resolved
    SUBPROCESS_ENV = _augmented_env(PY)
    if PY != sys.executable:
        print(f"[+] Using pipeline env python for subprocesses: {PY}")
    print(f"[+] Subprocess PATH includes: {[p for p in SUBPROCESS_ENV['PATH'].split(os.pathsep) if 'bhashasetu-mfa' in p][:4]}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--src_lang", default="hi")
    ap.add_argument("--tgt_lang", default="gu")
    ap.add_argument("--skip_mfa", action="store_true")
    args = ap.parse_args()

    check_environment()

    if not os.path.exists(args.video):
        print(f"[ERROR] Video file not found: {args.video}")
        print(f"[ERROR] Pass a real path, e.g.: dir uploads\\originals  (then use one of those files)")
        sys.exit(1)

    tmp = os.path.join(os.getcwd(), "uploads", "benchmark_outputs", time.strftime("%Y%m%d_%H%M%S"))
    os.makedirs(tmp, exist_ok=True)
    print(f"[+] Outputs will be saved to: {tmp}")
    if True:
        wav_path = os.path.join(tmp, "audio.wav")
        extract_audio(args.video, wav_path)

        demucs_dir = os.path.join(tmp, "demucs")
        os.makedirs(demucs_dir, exist_ok=True)
        demucs_result_json = os.path.join(demucs_dir, "result.json")
        run_demucs(wav_path, demucs_dir)

        # Demucs isolates speech from background music/noise into vocals.wav.
        # Whisper hallucinates repeating tokens (e.g. "आप आप आप...") far more
        # often when fed audio that still has music/ambience mixed in,
        # especially on short clips. Use the isolated vocal stem for
        # transcription whenever separation actually succeeded.
        whisper_input_path = wav_path
        if os.path.exists(demucs_result_json):
            try:
                demucs_result = json.load(open(demucs_result_json, encoding="utf-8"))
                vocals_path = demucs_result.get("vocals_path")
                if demucs_result.get("success") and vocals_path and os.path.exists(vocals_path):
                    whisper_input_path = vocals_path
                    print(f"[+] Using Demucs-isolated vocals for transcription: {vocals_path}")
                else:
                    print("[WARN] Demucs did not report a usable vocals_path — falling back to raw extracted audio for transcription.")
            except Exception as e:
                print(f"[WARN] Could not read Demucs result ({e}) — falling back to raw extracted audio for transcription.")
        else:
            print("[WARN] Demucs result.json not found — falling back to raw extracted audio for transcription.")

        whisper_json = os.path.join(tmp, "whisper.json")
        run_whisper(whisper_input_path, whisper_json, args.src_lang)

        diar_json = os.path.join(tmp, "diar.json")
        run_diarize(wav_path, diar_json)

        text = "बेंचमार्क के लिए यह एक परीक्षण वाक्य है।"
        CONFIDENCE_FLOOR = 0.15  # segments below this are near-certain hallucinations — drop, don't translate
        if os.path.exists(whisper_json):
            try:
                data = json.load(open(whisper_json, encoding="utf-8"))
                segs = data.get("segments", [])
                if segs:
                    kept = [s["text"].strip() for s in segs if s.get("confidence", 1.0) >= CONFIDENCE_FLOOR]
                    dropped = len(segs) - len(kept)
                    if dropped:
                        print(f"[+] Dropped {dropped}/{len(segs)} low-confidence segment(s) before translation")
                    text = " ".join(kept).strip() or text
                else:
                    text = data.get("text", text) or text
            except Exception:
                pass

        trans_json = os.path.join(tmp, "trans.json")
        # Translate each sentence-ish chunk separately — indictrans2-320M silently
        # truncates very long single inputs instead of erroring, which is what
        # caused tts.mp3 to only cover the first ~26s of a 58s clip last run.
        CHUNK_WORD_LIMIT = 40
        words = text.split()
        chunks = [" ".join(words[i:i + CHUNK_WORD_LIMIT]) for i in range(0, len(words), CHUNK_WORD_LIMIT)] or [text]

        translated_chunks = []
        for i, chunk in enumerate(chunks):
            chunk_json = os.path.join(tmp, f"trans_chunk_{i}.json")
            run_translate(chunk, args.src_lang, args.tgt_lang, chunk_json)
            if os.path.exists(chunk_json):
                try:
                    cdata = json.load(open(chunk_json, encoding="utf-8"))
                    translated_chunks.append(cdata.get("text") or cdata.get("translated_text") or "")
                except Exception:
                    pass

        with open(trans_json, "w", encoding="utf-8") as f:
            json.dump({"success": True, "text": " ".join(t for t in translated_chunks if t).strip()}, f, ensure_ascii=False, indent=2)

        print(f"[debug] whisper source text = {text!r}")
        if not args.skip_mfa:
            translated_text = text
            if os.path.exists(trans_json):
                try:
                    tdata = json.load(open(trans_json, encoding="utf-8"))
                    translated_text = tdata.get("translated_text") or tdata.get("text") or text
                except Exception:
                    pass

            print(f"[debug] translated_text = {translated_text!r}")
            tts_wav = os.path.join(tmp, "tts.mp3")
            VOICE_MAP = {"ta": "ta-IN-PallaviNeural", "en": "en-US-JennyNeural"}
            voice = VOICE_MAP.get(args.tgt_lang)
            mfa_json = os.path.join(tmp, "mfa.json")
            if voice and translated_text.strip():
                run_tts(translated_text, tts_wav, voice)
                if os.path.exists(tts_wav) and os.path.getsize(tts_wav) > 1000:
                    run_mfa(tts_wav, translated_text, args.tgt_lang, "benchmark", mfa_json)
                else:
                    print("[skip] tts_synthesis produced no usable audio, skipping mfa_forced_alignment")
            elif not translated_text.strip():
                print("[skip] translated_text is empty, skipping tts_synthesis and mfa_forced_alignment")
            else:
                print(f"[skip] no benchmark voice configured for '{args.tgt_lang}', skipping realistic MFA test")

        total = sum(s["seconds"] for s in STAGES)
        print("\n===== BENCHMARK SUMMARY =====")
        for s in STAGES:
            print(f"  {s['stage']:30s} {s['seconds']:>8.2f}s  {'OK' if s['success'] else 'FAILED: ' + str(s['error'])}")
        print(f"  {'TOTAL':30s} {total:>8.2f}s")

        report_path = "benchmark_report.json"
        with open(report_path, "w") as f:
            json.dump({"video": args.video, "stages": STAGES, "total_seconds": total}, f, indent=2)
        print(f"\n[+] Full report saved to {report_path}")

        print(f"\n[+] All pipeline outputs saved in: {tmp}")
        print(f"    - Extracted audio:    {wav_path}")
        print(f"    - Whisper transcript: {whisper_json}")
        print(f"    - Translation:        {trans_json}")
        if not args.skip_mfa:
            print(f"    - TTS audio:          {tts_wav}")
            print(f"    - MFA alignment:      {mfa_json}")

if __name__ == "__main__":
    main()
