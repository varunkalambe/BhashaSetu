import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static'; 

export const cloneVoiceTimbre = async (ttsAudioPath, referenceVocalsPath, jobId) => {
  console.log(`[${jobId}] 🐛 [VoiceClone] ── START ──`);
  console.log(`[${jobId}] 🐛 [VoiceClone] cwd: ${process.cwd()}`);
  console.log(`[${jobId}] 🐛 [VoiceClone] ttsAudioPath: ${ttsAudioPath} (exists: ${fs.existsSync(ttsAudioPath)})`);
  console.log(`[${jobId}] 🐛 [VoiceClone] referenceVocalsPath: ${referenceVocalsPath} (exists: ${fs.existsSync(referenceVocalsPath)})`);

  if (!fs.existsSync(referenceVocalsPath)) {
    console.warn(`[${jobId}] ⚠️ [VoiceClone] No reference vocals available, skipping voice cloning`);
    return ttsAudioPath;
  }

  // ✅ FIX: script lives under scripts/, and process.cwd() is ALREADY the backend/ dir
  // (same convention as every other python call in enhancedPipelineService.js).
  const scriptPath = path.join(process.cwd(), 'scripts', 'voice_clone_convert.py');
  console.log(`[${jobId}] 🐛 [VoiceClone] resolved scriptPath: ${scriptPath} (exists: ${fs.existsSync(scriptPath)})`);

  if (!fs.existsSync(scriptPath)) {
    console.error(`[${jobId}] ❌ [VoiceClone] voice_clone_convert.py not found at ${scriptPath} — skipping cloning`);
    return ttsAudioPath;
  }

  const ckptDir = path.join(process.cwd(), 'checkpoints_v2', 'converter');
  console.log(`[${jobId}] 🐛 [VoiceClone] expected checkpoint dir: ${ckptDir} (exists: ${fs.existsSync(ckptDir)})`);

  const outputPath = ttsAudioPath.replace(/\.wav$/, '_cloned.wav');
  const resultJson = ttsAudioPath.replace(/\.wav$/, '_clone_result.json');
  // ✅ FIX: bare "python" resolves via whatever conda env happens to be
  // stacked first on PATH in the shell that launched node — this is why
  // openvoice_cli was "installed" but still hit ModuleNotFoundError. Same
  // override pattern already used for MFA (MFA_PYTHON_PATH).
  const pythonBin = process.env.VOICECLONE_PYTHON_PATH || process.env.PYTHON_PATH || 'python';
  const cmd = `"${pythonBin}" "${scriptPath}" "${ttsAudioPath}" "${referenceVocalsPath}" "${outputPath}" "${resultJson}"`;
  console.log(`[${jobId}] 🐛 [VoiceClone] command: ${cmd}`);

  const startTime = Date.now();
  // ✅ FIX: 120s was too short for CPU model load + 2x speaker-embedding extraction
  // + tone conversion. Bumped to 5 min, with a heartbeat so you can see it's alive.
  const heartbeat = setInterval(() => {
    console.log(`[${jobId}] ⏳ [VoiceClone] still running... ${Math.round((Date.now() - startTime) / 1000)}s elapsed`);
  }, 15000);

  return new Promise((resolve) => {
    exec(cmd, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 }, async (error, stdout, stderr) => {
      clearInterval(heartbeat);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // ✅ heavy debug: ALWAYS print full stdout/stderr, never swallow it
      if (stdout) console.log(`[${jobId}] 🐛 [VoiceClone] stdout:\n${stdout}`);
      if (stderr) console.log(`[${jobId}] 🐛 [VoiceClone] stderr:\n${stderr}`);

      let resultJsonContent = null;
      try {
        if (fs.existsSync(resultJson)) {
          resultJsonContent = JSON.parse(fs.readFileSync(resultJson, 'utf-8'));
          console.log(`[${jobId}] 🐛 [VoiceClone] result.json: ${JSON.stringify(resultJsonContent)}`);
        }
      } catch (parseErr) {
        console.warn(`[${jobId}] ⚠️ [VoiceClone] could not parse result.json: ${parseErr.message}`);
      }

      if (!error && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        console.log(`[${jobId}] ✅ [VoiceClone] Voice timbre cloned to match original speaker (${elapsed}s)`);

        // ✅ REFINED: a fixed -16 LUFS target undershoots for speakers whose
        // original recording runs hotter than broadcast-dialogue standard
        // (measured -9.94 LUFS on real pipeline audio — 6 LU hotter than the
        // -16 target, which is why the clone still sounded ~5x quieter than
        // the original even after normalization). Measure the REFERENCE
        // vocals' actual integrated loudness and match the clone to that,
        // instead of a one-size-fits-all constant. Clamped to a sane range
        // so a broken/silent reference clip can't push the target to
        // something absurd.
        // ✅ HARDENED: retry the measurement once before falling back, and
        // ALWAYS log explicitly which path ran — previously a silent ffmpeg
        // process error fell back to a hardcoded -16 LUFS constant with zero
        // indication anywhere in the logs that measurement had failed, making
        // that failure mode invisible in production.
        const measureReferenceLoudness = async (attempt = 1) => {
          const stderr = await new Promise((res) => {
            let buf = '';
            const proc = spawn(ffmpegStatic, [
              '-i', referenceVocalsPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'
            ]);
            proc.stderr.on('data', (d) => { buf += d.toString(); });
            proc.on('close', () => res(buf));
            proc.on('error', () => res(null));
          });

          if (stderr === null) {
            if (attempt < 2) {
              console.warn(`[${jobId}] ⚠️ [VoiceClone] Reference loudness measurement errored, retrying (attempt ${attempt + 1}/2)...`);
              return measureReferenceLoudness(attempt + 1);
            }
            console.warn(`[${jobId}] ⚠️ [VoiceClone] Reference loudness measurement failed after ${attempt} attempts — falling back to constant -16 LUFS target.`);
            return -16;
          }

          const match = stderr.match(/"input_i"\s*:\s*"(-?[\d.]+)"/);
          if (!match) {
            console.warn(`[${jobId}] ⚠️ [VoiceClone] Reference loudness measurement produced no parseable result — falling back to constant -16 LUFS target.`);
            return -16;
          }
          const measured = parseFloat(match[1]);
          const clamped = Math.max(-23, Math.min(-6, measured)); // sane dialogue bounds
          console.log(`[${jobId}] 🐛 [VoiceClone] reference vocals measured loudness: ${measured} LUFS → target ${clamped} LUFS`);
          return clamped;
        };

        // ✅ FIX: single-pass loudnorm defaults to "dynamic" mode — a
        // frame-by-frame adaptive gain that visibly pumps up/down through
        // pauses in short clips, which reads as processed/robotic (exactly
        // the regression reported). Two-pass LINEAR mode instead measures
        // the cloned audio's own stats first, then applies one constant
        // gain — transparent, no pumping, preserves natural dynamics.
        const targetLufs = await measureReferenceLoudness();

        const measureOwnLoudness = async (attempt = 1) => {
          const stderr = await new Promise((res) => {
            let buf = '';
            const proc = spawn(ffmpegStatic, ['-i', outputPath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
            proc.stderr.on('data', (d) => { buf += d.toString(); });
            proc.on('close', () => res(buf));
            proc.on('error', () => res(null));
          });

          if (stderr === null) {
            if (attempt < 2) {
              console.warn(`[${jobId}] ⚠️ [VoiceClone] Own-loudness measurement errored, retrying (attempt ${attempt + 1}/2)...`);
              return measureOwnLoudness(attempt + 1);
            }
            console.warn(`[${jobId}] ⚠️ [VoiceClone] Own-loudness measurement failed after ${attempt} attempts — using single-pass DYNAMIC loudnorm mode (may pump on short clips).`);
            return null;
          }

          const grab = (key) => { const m = stderr.match(new RegExp(`"${key}"\\s*:\\s*"(-?[\\d.]+)"`)); return m ? m[1] : null; };
          const rawInputI = grab('input_i');
          const stats = {
            input_i: rawInputI || '-16',
            input_tp: grab('input_tp') || '-1.5',
            input_lra: grab('input_lra') || '11',
            input_thresh: grab('input_thresh') || '-26',
          };
          if (!rawInputI) {
            console.warn(`[${jobId}] ⚠️ [VoiceClone] Own-loudness measurement produced no parseable stats — using single-pass DYNAMIC loudnorm mode (may pump on short clips).`);
            return null;
          }
          console.log(`[${jobId}] 🐛 [VoiceClone] own loudness measured: I=${stats.input_i} TP=${stats.input_tp} LRA=${stats.input_lra} — using two-pass LINEAR loudnorm mode.`);
          return stats;
        };

        const ownStats = await measureOwnLoudness();
        const normalizedPath = outputPath.replace(/\.wav$/, '_norm.wav');
        const loudnormFilter = ownStats
          ? `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11:measured_I=${ownStats.input_i}:measured_TP=${ownStats.input_tp}:measured_LRA=${ownStats.input_lra}:measured_thresh=${ownStats.input_thresh}:linear=true`
          : `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`; // fall back to old dynamic mode if measurement failed

        const normalized = await new Promise((res) => {
          const proc = spawn(ffmpegStatic, [
            '-y', '-i', outputPath,
            '-af', loudnormFilter,
            '-ar', '44100',
            normalizedPath
          ]);
          let stderr = '';
          proc.stderr.on('data', (d) => { stderr += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).size > 1000) {
              res(true);
            } else {
              console.warn(`[${jobId}] ⚠️ [VoiceClone] Loudness normalization failed (code ${code}): ${stderr.substring(0, 200)}`);
              res(false);
            }
          });
          proc.on('error', () => res(false));
        });

        if (normalized) {
          fs.copyFileSync(normalizedPath, outputPath);
          try { fs.unlinkSync(normalizedPath); } catch (_) {}
          // AFTER
console.log(`[${jobId}] ✅ [VoiceClone] Loudness-normalized cloned audio to ${targetLufs.toFixed(1)} LUFS (matched to reference speaker)`);
        }

        resolve(outputPath);
      } else {
        console.warn(`[${jobId}] ⚠️ [VoiceClone] FAILED after ${elapsed}s — keeping stock TTS voice.`);
        console.warn(`[${jobId}] ⚠️ [VoiceClone] error: ${error?.message || 'none'}`);
        console.warn(`[${jobId}] ⚠️ [VoiceClone] result.json says: ${resultJsonContent?.error || 'no result.json / no error field'}`);

        // ✅ FIX: cloning failure used to skip loudness matching entirely,
        // leaving stock edge-tts at its native (~16 LUFS quieter than typical
        // recorded speech) level. Next to the original that reads as flat/
        // robotic even though pitch contour is fine. Match loudness to the
        // reference speaker here too, same as the success path.
        try {
          const measureLoudness = (filePath) => new Promise((res) => {
            let stderrBuf = '';
            const proc = spawn(ffmpegStatic, ['-i', filePath, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
            proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
            proc.on('close', () => {
              const grab = (key) => { const m = stderrBuf.match(new RegExp(`"${key}"\\s*:\\s*"(-?[\\d.]+)"`)); return m ? m[1] : null; };
              const rawInputI = grab('input_i');
              if (!rawInputI) {
                console.warn(`[${jobId}] ⚠️ [VoiceClone] Fallback loudness measurement for ${filePath} produced no parseable result — using constant -16 LUFS default for this file.`);
              }
              res({
                input_i: rawInputI || '-16',
                input_tp: grab('input_tp') || '-1.5',
                input_lra: grab('input_lra') || '11',
                input_thresh: grab('input_thresh') || '-26',
              });
            });
            proc.on('error', () => {
              console.warn(`[${jobId}] ⚠️ [VoiceClone] Fallback loudness measurement process errored for ${filePath} — using constant -16 LUFS default for this file.`);
              res(null);
            });
          });

          const refStats = await measureLoudness(referenceVocalsPath);
          const targetLufsFallback = Math.max(-23, Math.min(-6, parseFloat(refStats?.input_i ?? '-16')));
          const ownStats = await measureLoudness(ttsAudioPath);
          const loudnormFilter = ownStats
            ? `loudnorm=I=${targetLufsFallback}:TP=-1.5:LRA=11:measured_I=${ownStats.input_i}:measured_TP=${ownStats.input_tp}:measured_LRA=${ownStats.input_lra}:measured_thresh=${ownStats.input_thresh}:linear=true`
            : `loudnorm=I=${targetLufsFallback}:TP=-1.5:LRA=11`;

          const normalizedFallbackPath = ttsAudioPath.replace(/\.wav$/, '_norm.wav');
          const normalizedOk = await new Promise((res) => {
            const proc = spawn(ffmpegStatic, ['-y', '-i', ttsAudioPath, '-af', loudnormFilter, '-ar', '44100', normalizedFallbackPath]);
            proc.on('close', (code) => res(code === 0 && fs.existsSync(normalizedFallbackPath) && fs.statSync(normalizedFallbackPath).size > 1000));
            proc.on('error', () => res(false));
          });

          if (normalizedOk) {
            fs.copyFileSync(normalizedFallbackPath, ttsAudioPath);
            try { fs.unlinkSync(normalizedFallbackPath); } catch (_) {}
            console.log(`[${jobId}] ✅ [VoiceClone] Loudness-matched stock TTS to reference speaker (${targetLufsFallback.toFixed(1)} LUFS) despite clone failure`);
          }
        } catch (loudnessErr) {
          console.warn(`[${jobId}] ⚠️ [VoiceClone] Fallback loudness match failed, leaving stock TTS as-is: ${loudnessErr.message}`);
        }

        resolve(ttsAudioPath); // still never breaks the pipeline
      }
    });
  });
};

export default { cloneVoiceTimbre };