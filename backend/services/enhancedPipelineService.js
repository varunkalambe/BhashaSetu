// services/enhancedPipelineService.js - Demucs / Diarization / IndicTrans2 / MMS-TTS / MFA orchestration
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { offloadDemucs } from './gpuOffloadClient.js';

const execAsync = promisify(exec);

function pythonSubprocessEnv(pythonBinPath) {
  const envDir = path.dirname(pythonBinPath.replace(/^"|"$/g, ''));
  const extraDirs = [
    envDir,
    path.join(envDir, 'Scripts'),
    path.join(envDir, 'Library', 'bin'),
  ].filter(p => fs.existsSync(p));
  return {
    ...process.env,
    PATH: extraDirs.join(path.delimiter) + path.delimiter + (process.env.PATH || ''),
  };
}
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

// bhashasetu-mfa has indictranstoolkit + edge-tts + MFA deps + matched
// torch/torchaudio — it's the single interpreter for everything in this file
// EXCEPT voice cloning, which lives only in bhashasetu_env (openvoice-cli).
function resolvePythonBin() {
  const candidates = [
    process.env.PYTHON_PATH,
    process.env.MFA_PYTHON_PATH, // some scripts already special-cased this — unify it
    'C:\\Users\\varun\\miniconda3\\envs\\bhashasetu-mfa\\python.exe', // known-good env, same one LocalWhisper already uses successfully
  ].filter(Boolean);

  console.log('[DEBUG][resolvePythonBin] candidates in priority order:', candidates);

  for (const c of candidates) {
    try {
      const version = execSync(`"${c}" --version`, { encoding: 'utf-8' }).trim();
      console.log(`[DEBUG][resolvePythonBin] ✅ SELECTED: ${c} (${version})`);
      return c;
    } catch (e) {
      console.log(`[DEBUG][resolvePythonBin] ❌ rejected: ${c} — ${e.message}`);
    }
  }

  throw new Error(
    'No usable Python interpreter found. Set PYTHON_PATH in backend/.env to the ' +
    'full path of python.exe inside your bhashasetu-mfa conda env, e.g.\n' +
    '  PYTHON_PATH=C:\\Users\\varun\\miniconda3\\envs\\bhashasetu-mfa\\python.exe'
  );
}

const PYTHON = resolvePythonBin(); // resolved ONCE at module load, fails loud and early
console.log(`[DEBUG] Module-level PYTHON interpreter locked to: ${PYTHON}`);
console.log(`[DEBUG] Module-level PYTHON interpreter locked to: ${PYTHON}`);
export const MMS_ONLY_LANGUAGES = new Set(['sd', 'mni']);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };

export const separateVocals = async (audioPath, jobId) => {
  const outDir = path.join(process.cwd(), 'uploads', 'separated', jobId);
  const resultJson = path.join(outDir, 'result.json');
  ensureDir(outDir);

  // ✅ NEW: try the free-GPU offload bridge first (Colab/Kaggle T4), since Demucs on
  // CPU is documented as 5-10x slower than GPU. Falls straight through to the existing
  // local CPU path below if GPU_OFFLOAD_URL isn't set, the worker is unreachable, or
  // the remote job errors for any reason - this is a pure speed optimization, never a
  // new failure mode.
  const offloaded = await offloadDemucs(audioPath, outDir, jobId, 'fast');
  if (offloaded) {
    return offloaded;
  }

  const cmd = `"${PYTHON}" "${path.join(SCRIPTS_DIR, 'run_demucs.py')}" "${audioPath}" "${outDir}" "${resultJson}" --quality fast`;
  console.log(`[${jobId}] [Demucs] ${cmd}`);

  const demucsStart = Date.now();
  const demucsHeartbeat = setInterval(() => {
    console.log(`[${jobId}] ⏳ [Demucs] still running on CPU... (${Math.round((Date.now() - demucsStart) / 1000)}s elapsed, timeout at 600s)`);
  }, 15000);

  try {
    const { stderr } = await execAsync(cmd, {
      timeout: 600000,
      maxBuffer: 1024 * 1024 * 50,
      env: pythonSubprocessEnv(PYTHON)
    });
    if (stderr) console.warn(`[${jobId}] [Demucs] stderr: ${stderr}`);
    const result = readJson(resultJson);
    if (!result.success) throw new Error(result.error);
    console.log(`[${jobId}] ✅ Vocal/BGM separation complete (local CPU, ${Math.round((Date.now() - demucsStart) / 1000)}s)`);
    return { vocalsPath: result.vocals_path, bgmPath: result.bgm_path };
  } catch (error) {
    console.warn(`[${jobId}] ⚠️ Demucs separation failed after ${Math.round((Date.now() - demucsStart) / 1000)}s, continuing without BGM preservation: ${error.message}`);
    return { vocalsPath: null, bgmPath: null };
  } finally {
    clearInterval(demucsHeartbeat);
  }
};

export const analyzeDiarizationProsody = async (audioPath, jobId) => {
  const outDir = path.join(process.cwd(), 'uploads', 'diarization', jobId);
  const resultJson = path.join(outDir, 'result.json');
  ensureDir(outDir);

  const cmd = `"${PYTHON}" "${path.join(SCRIPTS_DIR, 'run_diarize_prosody.py')}" "${audioPath}" "${resultJson}"`;
  console.log(`[${jobId}] [Diarization/F0] ${cmd}`);
  console.log(`[${jobId}] [DEBUG][Diarization/F0] subprocess PATH will include conda Library\\bin: ${path.dirname(PYTHON)}\\Library\\bin`);

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 20,
      env: pythonSubprocessEnv(PYTHON)   // <-- THE FIX: without this, libsndfile.dll (in conda's Library\bin) is never found
    });
    if (stdout) console.log(`[${jobId}] [DEBUG][Diarization/F0] stdout: ${stdout}`);
    if (stderr) console.warn(`[${jobId}] [Diarization/F0] stderr: ${stderr}`);
    return readJson(resultJson);
  } catch (error) {
    console.warn(`[${jobId}] ⚠️ Diarization/F0 analysis failed: ${error.message}`);
    return { success: false, error: error.message };
  }
};

// ===== NEW: TURN RAW DIARIZATION/F0 DATA INTO A TTS-USABLE HINT =====
// This closes the "diarizationData computed but not consumed downstream" gap.
// It does NOT do full per-speaker segment-level voice assignment (that needs a
// separate mapping between diarization speaker segments and translation segments,
// which is a bigger feature); what it DOES do is give the TTS stage a genuine,
// data-driven signal — the dominant speaker's estimated vocal register — so the
// job-level voice choice (primary vs alternative edge-tts voice) reflects the
// actual speaker instead of always defaulting to the primary voice.
export const inferDominantSpeakerProfile = (diarizationData) => {
  const fallback = { numSpeakers: 1, dominantRegister: 'unknown', meanF0Hz: null, confidence: 'low' };

  if (!diarizationData || diarizationData.success === false) return fallback;

  const numSpeakers = diarizationData.diarization?.num_speakers ?? 1;
  const meanF0Hz = diarizationData.f0?.mean_f0_hz ?? null;

  // Rough, well-documented F0 bands (not a clinical claim, just a heuristic bucket
  // used to pick between the two edge-tts voice options already configured per
  // language): typical adult male speaking F0 ~85-180Hz, typical adult female
  // speaking F0 ~165-255Hz, with overlap in the 165-180Hz band.
  let dominantRegister = 'unknown';
  let confidence = 'low';
  if (meanF0Hz && meanF0Hz > 0) {
    if (meanF0Hz < 165) {
      dominantRegister = 'lower';
      confidence = meanF0Hz < 150 ? 'medium' : 'low';
    } else {
      dominantRegister = 'higher';
      confidence = meanF0Hz > 180 ? 'medium' : 'low';
    }
  }

  return { numSpeakers, dominantRegister, meanF0Hz, confidence };
};

const NUM_TOKEN = (i) => `NUMTOKENPLACEHOLDER${i}END`;

const protectNumbers = (text) => {
  const numbers = [];
  const protectedText = text.replace(/\d+(?:\.\d+)?/g, (match) => {
    numbers.push(match);
    return NUM_TOKEN(numbers.length - 1);
  });
  return { protectedText, numbers };
};

const restoreNumbers = (text, numbers) => {
  let restored = text;
  numbers.forEach((num, i) => {
    restored = restored.replace(new RegExp(NUM_TOKEN(i), 'gi'), num);
  });
  return restored;
};


export const translateWithIndicTrans2 = async (text, sourceLang, targetLang, jobId) => {
  const outDir = path.join(process.cwd(), 'uploads', 'indictrans2', jobId);
  const resultJson = path.join(outDir, 'result.json');
  ensureDir(outDir);

  // AFTER
// ✅ FIX: numbers translated in isolation (e.g. a short segment that's
// mostly a number) came back corrupted — confirmed on a real job: input
// "3.14 वाला" → output "3. 14 વાહ." (decimal point broken apart). Swap
// numerals for plain-text placeholders before translation, put the exact
// original digits back afterward.
const { protectedText, numbers } = protectNumbers(text);
const escapedText = protectedText.replace(/"/g, '\\"');  const loraArg = process.env.INDICTRANS2_LORA_PATH ? ` --lora_path "${process.env.INDICTRANS2_LORA_PATH}"` : '';
  const cmd = `"${PYTHON}" "${path.join(SCRIPTS_DIR, 'run_indictrans2.py')}" "${escapedText}" "${sourceLang}" "${targetLang}" "${resultJson}"${loraArg}`;

  console.log(`[${jobId}] [DEBUG][IndicTrans2] interpreter: ${PYTHON}`);
  console.log(`[${jobId}] [DEBUG][IndicTrans2] cwd: ${process.cwd()}`);
  console.log(`[${jobId}] [DEBUG][IndicTrans2] source text length: ${text.length} chars`);
  console.log(`[${jobId}] [DEBUG][IndicTrans2] lora arg: ${loraArg || '(none)'}`);
  console.log(`[${jobId}] [DEBUG][IndicTrans2] full command: ${cmd}`);
  console.log(`[${jobId}] [IndicTrans2] Translating ${sourceLang} → ${targetLang}`);

  const startTime = Date.now();
  const { stdout, stderr } = await execAsync(cmd, { timeout: 180000, maxBuffer: 1024 * 1024 * 20 });
  const elapsed = Date.now() - startTime;

  console.log(`[${jobId}] [DEBUG][IndicTrans2] subprocess finished in ${elapsed}ms`);
  if (stdout) console.log(`[${jobId}] [DEBUG][IndicTrans2] stdout:\n${stdout}`);
  if (stderr) console.warn(`[${jobId}] [IndicTrans2] stderr: ${stderr}`);

  let result;
  try {
    result = readJson(resultJson);
  } catch (parseErr) {
    console.error(`[${jobId}] [DEBUG][IndicTrans2] FAILED to read/parse result JSON at ${resultJson}: ${parseErr.message}`);
    throw parseErr;
  }

  console.log(`[${jobId}] [DEBUG][IndicTrans2] raw result JSON: ${JSON.stringify(result)}`);
  if (!result.success) throw new Error(result.error);

  const qeLabel = result.qe_score != null
    ? `QE=${result.qe_score.toFixed(3)} via ${result.qe_method || 'unknown'}`
    : 'QE unavailable';
  console.log(`[${jobId}] ✅ IndicTrans2 translation done (${qeLabel}) in ${elapsed}ms`);

  // AFTER
return {
    text: restoreNumbers(result.text, numbers),
    language: targetLang,
    sourceLang, targetLang,
    engine: 'indictrans2',
    qe_score: result.qe_score ?? null,
    qe_method: result.qe_method ?? null,
    success: true
  };
};

// ✅ NEW: batch sibling of translateWithIndicTrans2 — translates a LIST of
// texts (e.g. the full text + every segment) in ONE subprocess call / ONE
// model load, instead of one call per text. Confirmed on a real job: 5
// separate ~15-19s model loads for a single 4-segment job (75-95s of pure
// overhead). Falls back per-item to null on failure so the caller can retry
// just that item through the normal multi-engine chain.
export const translateMultipleWithIndicTrans2 = async (texts, sourceLang, targetLang, jobId) => {
  const outDir = path.join(process.cwd(), 'uploads', 'indictrans2', jobId);
  const batchFile = path.join(outDir, 'batch_input.json');
  const resultJson = path.join(outDir, 'batch_result.json');
  ensureDir(outDir);

  fs.writeFileSync(batchFile, JSON.stringify(texts), 'utf-8');

  const loraArg = process.env.INDICTRANS2_LORA_PATH ? ` --lora_path "${process.env.INDICTRANS2_LORA_PATH}"` : '';
  const cmd = `"${PYTHON}" "${path.join(SCRIPTS_DIR, 'run_indictrans2.py')}" "" "${sourceLang}" "${targetLang}" "${resultJson}" --batch_file "${batchFile}"${loraArg}`;

  console.log(`[${jobId}] [DEBUG][IndicTrans2Batch] translating ${texts.length} text(s) in one model load`);
  console.log(`[${jobId}] [DEBUG][IndicTrans2Batch] full command: ${cmd}`);

  const startTime = Date.now();
  const { stdout, stderr } = await execAsync(cmd, { timeout: 240000, maxBuffer: 1024 * 1024 * 20 });
  const elapsed = Date.now() - startTime;

  console.log(`[${jobId}] [DEBUG][IndicTrans2Batch] subprocess finished in ${elapsed}ms`);
  if (stdout) console.log(`[${jobId}] [DEBUG][IndicTrans2Batch] stdout:\n${stdout}`);
  if (stderr) console.warn(`[${jobId}] [IndicTrans2Batch] stderr: ${stderr}`);

  const result = readJson(resultJson);
  if (!result.success) throw new Error(result.error || 'Batch translation failed');

  return result.results.map((item, i) => {
    if (!item.success) return null; // caller falls back to translateText for this index
    return {
      text: item.text,
      language: targetLang,
      sourceLang, targetLang,
      engine: 'indictrans2',
      qe_score: item.qe_score ?? null,
      qe_method: item.qe_method ?? null,
      success: true
    };
  });
};

export const synthesizeMmsTts = async (text, targetLanguage, jobId) => {
  const outDir = path.join(process.cwd(), 'uploads', 'translated_audio');
  ensureDir(outDir);
  const audioPath = path.join(outDir, `${jobId}_mms.wav`);
  const resultJson = path.join(process.cwd(), 'uploads', 'mms_tts', jobId, 'result.json');
  ensureDir(path.dirname(resultJson));

  const escapedText = text.replace(/"/g, '\\"');
  const cmd = `"${PYTHON}" "${path.join(SCRIPTS_DIR, 'run_mms_tts.py')}" "${escapedText}" "${audioPath}" "${targetLanguage}" "${resultJson}"`;
  console.log(`[${jobId}] [MMS-TTS] Synthesizing for ${targetLanguage} (CC-BY-NC-4.0, academic use only)`);

  const { stderr } = await execAsync(cmd, { timeout: 120000, maxBuffer: 1024 * 1024 * 20 });
  if (stderr) console.warn(`[${jobId}] [MMS-TTS] stderr: ${stderr}`);
  const result = readJson(resultJson);
  if (!result.success) throw new Error(result.error);

  console.log(`[${jobId}] ✅ MMS-TTS synthesis complete: ${result.audio_path} (resolved code: ${result.resolved_iso_code || 'n/a'})`);
  return result.audio_path;
};

export const forcedAlignMFA = async (audioPath, transcriptText, language, jobId) => {
  const resultJson = path.join(process.cwd(), 'uploads', 'mfa_align', jobId, 'result.json');
  ensureDir(path.dirname(resultJson));

  const escapedText = transcriptText.replace(/"/g, '\\"');
  const cmd = `"${PYTHON}" "${path.join(SCRIPTS_DIR, 'run_mfa_align.py')}" "${audioPath}" "${escapedText}" "${language}" "${jobId}" "${resultJson}"`;
  console.log(`[${jobId}] [MFA] Forced alignment: ${language}`);

  const { stdout, stderr } = await execAsync(cmd, {
    timeout: 300000,
    maxBuffer: 1024 * 1024 * 20,
    env: pythonSubprocessEnv(PYTHON)   // <-- THE FIX: MFA's own Kaldi/sox subprocesses need conda's Scripts+Library\bin on PATH too
  });
  // IMPORTANT: previously only stderr was logged — every [mfa-debug] line (which
  // prints exactly WHY it failed: resolved binary path, whether it exists on disk,
  // which acoustic model/dictionary were resolved) goes to STDOUT and was being
  // silently discarded. This was actively hiding the real diagnosis.
  if (stdout) console.log(`[${jobId}] [DEBUG][MFA] stdout:\n${stdout}`);
  if (stderr) console.warn(`[${jobId}] [MFA] stderr: ${stderr}`);
  const result = readJson(resultJson);
  if (!result.success) throw new Error(result.error);

  console.log(`[${jobId}] ✅ MFA alignment complete: ${result.words.length} words`);
  return { forced_alignment_result: result, alignment_quality: 'excellent', alignment_source: 'mfa_kaldi' };
};

export default {
  separateVocals,
  analyzeDiarizationProsody,
  inferDominantSpeakerProfile,
  translateWithIndicTrans2,
  translateMultipleWithIndicTrans2,
  synthesizeMmsTts,
  forcedAlignMFA,
  MMS_ONLY_LANGUAGES
};