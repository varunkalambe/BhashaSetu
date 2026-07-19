// services/gpuOffloadClient.js
//
// Bridges to an optional remote GPU worker (Google Colab free tier / Kaggle Notebooks,
// per the original architecture proposal's "offload Demucs + Wav2Lip to a free GPU"
// mitigation for CPU processing time). This was previously "no code exists for it, out
// of scope" — this file is the actual client half of that bridge.
//
// The remote half is backend/scripts/colab_gpu_worker.py, meant to run inside a Colab/
// Kaggle GPU notebook and be exposed via a tunnel (ngrok/cloudflared). Set:
//   GPU_OFFLOAD_URL=https://<your-tunnel-subdomain>.ngrok-free.app
// in .env to enable it. If unset, unreachable, or it errors, every function here
// resolves to `null` so callers fall back to local CPU execution — this is an optional
// accelerator, never a hard dependency.

import fs from 'fs';

const OFFLOAD_URL = (process.env.GPU_OFFLOAD_URL || '').replace(/\/+$/, '');
const HEALTH_TIMEOUT_MS = parseInt(process.env.GPU_OFFLOAD_HEALTH_TIMEOUT_MS || '3000', 10);
const JOB_TIMEOUT_MS = parseInt(process.env.GPU_OFFLOAD_JOB_TIMEOUT_MS || '600000', 10); // 10 min

export const isGpuOffloadConfigured = () => Boolean(OFFLOAD_URL);

// Quick reachability check so a misconfigured/offline notebook fails FAST into the local
// CPU path instead of hanging the whole pipeline for the full job timeout.
const isReachable = async (jobId) => {
  if (!OFFLOAD_URL) return false;
  try {
    const res = await fetch(`${OFFLOAD_URL}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`health check returned ${res.status}`);
    console.log(`[${jobId}] [GPU-Offload] Worker at ${OFFLOAD_URL} is reachable`);
    return true;
  } catch (error) {
    console.warn(`[${jobId}] [GPU-Offload] Worker unreachable (${error.message}); using local CPU path`);
    return false;
  }
};

const toBase64 = (filePath) => fs.readFileSync(filePath).toString('base64');
const fromBase64 = (base64Str, outPath) => {
  fs.writeFileSync(outPath, Buffer.from(base64Str, 'base64'));
  return outPath;
};

export const offloadDemucs = async (audioPath, outDir, jobId, quality = 'fast') => {
  if (!(await isReachable(jobId))) return null;

  try {
    console.log(`[${jobId}] [GPU-Offload] Sending audio to remote Demucs (GPU)...`);
    const body = JSON.stringify({
      audio_b64: toBase64(audioPath),
      filename: `${jobId}.wav`,
      quality
    });

    const res = await fetch(`${OFFLOAD_URL}/demucs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS)
    });

    if (!res.ok) throw new Error(`remote Demucs returned HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'remote Demucs reported failure');

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const vocalsPath = fromBase64(data.vocals_b64, `${outDir}/vocals.wav`);
    const bgmPath = fromBase64(data.bgm_b64, `${outDir}/no_vocals.wav`);

    console.log(`[${jobId}] [GPU-Offload] ✅ Remote Demucs separation complete`);
    return { vocalsPath, bgmPath };
  } catch (error) {
    console.warn(`[${jobId}] [GPU-Offload] Remote Demucs failed (${error.message}); falling back to local CPU`);
    return null;
  }
};

export const offloadWav2Lip = async (videoPath, audioPath, outputPath, jobId) => {
  if (!(await isReachable(jobId))) return null;

  try {
    console.log(`[${jobId}] [GPU-Offload] Sending video+audio to remote Wav2Lip (GPU)...`);
    const body = JSON.stringify({
      video_b64: toBase64(videoPath),
      video_filename: `${jobId}.mp4`,
      audio_b64: toBase64(audioPath),
      audio_filename: `${jobId}.wav`
    });

    const res = await fetch(`${OFFLOAD_URL}/wav2lip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS)
    });

    if (!res.ok) throw new Error(`remote Wav2Lip returned HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'remote Wav2Lip reported failure');

    fromBase64(data.output_b64, outputPath);
    console.log(`[${jobId}] [GPU-Offload] ✅ Remote Wav2Lip synthesis complete: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.warn(`[${jobId}] [GPU-Offload] Remote Wav2Lip failed (${error.message}); falling back to local CPU`);
    return null;
  }
};

export default { isGpuOffloadConfigured, offloadDemucs, offloadWav2Lip };