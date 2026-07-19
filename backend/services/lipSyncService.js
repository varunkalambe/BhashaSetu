
// services/lipSyncService.js - FIXED VERSION FOR WINDOWS

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { offloadWav2Lip } from './gpuOffloadClient.js';

const execAsync = promisify(exec);

/**
 * Generates a lip-synced video using Wav2Lip (Hugging Face Nekochu)
 *
 * @param {string} videoPath - Path to the input video
 * @param {string} audioPath - Path to the input audio (translated TTS)
 * @param {string} jobId - Unique job ID for logging and output naming
 * @returns {Promise<string>} - Path to the generated lip-synced video
 */
export const generateLipSyncVideo = async (videoPath, audioPath, jobId) => {
    console.log(`[${jobId}] 🎬 Starting Wav2Lip lip sync generation...`);

    try {
        // ✅ FIX #1: Validate input files exist
        if (!fs.existsSync(videoPath)) {
            throw new Error(`Video file not found: ${videoPath}`);
        }
        if (!fs.existsSync(audioPath)) {
            throw new Error(`Audio file not found: ${audioPath}`);
        }

        const videoSize = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(2);
        const audioSize = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(2);
        console.log(`[${jobId}] Input files validated:`);
        console.log(`[${jobId}]   Video: ${videoPath} (${videoSize} MB)`);
        console.log(`[${jobId}]   Audio: ${audioPath} (${audioSize} MB)`);

        // ✅ FIX #2: Create output directory if it doesn't exist
        const outputDir = './uploads/processed';
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`[${jobId}] Created output directory: ${outputDir}`);
        }

        const outputPath = path.join(outputDir, `${jobId}_lipsynced.mp4`);

        // ✅ NEW: try the free-GPU offload bridge first (Colab/Kaggle T4/P100) - Wav2Lip
        // on CPU is documented as the single biggest bottleneck in the whole proposed
        // pipeline (2-5 min per 30s clip on CPU alone). Falls straight through to the
        // existing local CPU path below if GPU_OFFLOAD_URL isn't set, the worker is
        // unreachable, or the remote job errors for any reason.
        const offloadedPath = await offloadWav2Lip(videoPath, audioPath, outputPath, jobId);
        if (offloadedPath) {
            const offloadedSize = (fs.statSync(offloadedPath).size / 1024 / 1024).toFixed(2);
            console.log(`[${jobId}] ✅ Lip sync video generated via GPU offload (${offloadedSize} MB)`);
            return offloadedPath;
        }

        // ✅ FIX #3: Verify Python version
        const pythonPath = process.env.WAV2LIP_PYTHON_PATH || 'python';
        try {
            const { stdout: pythonVersion } = await execAsync(`${pythonPath} --version`);
            console.log(`[${jobId}] Python version: ${pythonVersion.trim()}`);
        } catch (error) {
            throw new Error(`Python not found. Install Python 3.6-3.8 and add to PATH.`);
        }

        // Wav2Lip repository path
        const wav2lipPath = process.env.WAV2LIP_PATH || './Wav2Lip';

        // Hugging Face Nekochu checkpoint path
        const checkpointPath = path.join(wav2lipPath, 'checkpoints', 'wav2lip_gan.pth');

        // ✅ Verify checkpoint exists
        if (!fs.existsSync(checkpointPath)) {
            throw new Error(
                `Wav2Lip checkpoint not found at ${checkpointPath}.\n` +
                `Download from: https://huggingface.co/Nekochu/Wav2Lip/blob/main/wav2lip_gan.pth`
            );
        }

        console.log(`[${jobId}] Checkpoint verified: ${checkpointPath}`);


        // ✅ NEW: fast face-presence precheck. Wav2Lip's face_detect() requires
        // a face in EVERY frame and only fails after running full-resolution
        // detection across the whole clip (~2-3 min on CPU) — wasted time for
        // any source that's screen-recorded/graphic content with no human face
        // at all. Sample 3 frames cheaply with a Haar cascade first; bail out
        // in ~1-2s if none of them have a face, instead of waiting for the
        // full Wav2Lip run to discover the same thing.
        const faceCheckScript = `
import cv2, sys
cap = cv2.VideoCapture(r"${videoPath}")
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
found = False
for frac in (0.1, 0.5, 0.9):
    idx = min(total - 1, int(total * frac))
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ok, frame = cap.read()
    if not ok:
        continue
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, 1.1, 4)
    if len(faces) > 0:
        found = True
        break
print("FACE_FOUND" if found else "NO_FACE")
`.replace(/"/g, '\\"');

        try {
            const { stdout: faceCheckOut } = await execAsync(
                `${pythonPath} -c "${faceCheckScript}"`,
                { timeout: 20000 }
            );
            if (!faceCheckOut.includes('FACE_FOUND')) {
                throw new Error(
                    'No human face detected in sampled frames — source video appears to be ' +
                    'screen-recorded/graphic content, which Wav2Lip cannot lip-sync. Skipping ' +
                    'lip-sync and keeping the dubbed (non-lip-synced) video.'
                );
            }
            console.log(`[${jobId}] ✅ Face precheck passed — proceeding with Wav2Lip`);
        } catch (faceCheckErr) {
            console.warn(`[${jobId}] ⚠️ Face precheck: ${faceCheckErr.message}`);
            throw faceCheckErr; // caller in processController.js already catches and falls back gracefully
        }


        // ✅ FIX #4: GPU detection and MEMORY-SAFE batch sizing for CPU
        let faceBatchSize = 4;
        let wav2lipBatchSize = 128;
        let resizeFactor = 1;

        try {
            const { stdout: gpuCheck } = await execAsync(`${pythonPath} -c "import torch; print(torch.cuda.is_available())"`);
            const hasGPU = gpuCheck.trim() === 'True';

            if (!hasGPU) {
                console.warn(`[${jobId}] ⚠️ No GPU detected - using CPU (slower, memory-safe settings)`);
                faceBatchSize = 1;
                wav2lipBatchSize = 8;      // ✅ lowered from 32 — this was almost certainly OOM-crashing on full-res CPU inference
                resizeFactor = 2;          // ✅ NEW — halves frame dimensions before the GAN pass, biggest single memory reduction
            } else {
                console.log(`[${jobId}] ✅ GPU detected - using GPU acceleration`);
            }
        } catch (error) {
            console.warn(`[${jobId}] Could not detect GPU, defaulting to CPU-safe settings`);
            faceBatchSize = 1;
            wav2lipBatchSize = 8;
            resizeFactor = 2;
        }

        // ✅ FIX #5: Windows-compatible command (no backslash continuation)
        const commandArgs = [
            `"${pythonPath}"`,
            `"${path.join(wav2lipPath, 'inference.py')}"`,
            `--checkpoint_path "${checkpointPath}"`,
            `--face "${videoPath}"`,
            `--audio "${audioPath}"`,
            `--outfile "${outputPath}"`,
            '--fps 25',
            '--pads 0 10 0 0',
            `--face_det_batch_size ${faceBatchSize}`,
            `--wav2lip_batch_size ${wav2lipBatchSize}`,
            `--resize_factor ${resizeFactor}`,
            '--nosmooth'
        ];

        const command = commandArgs.join(' ');

        console.log(`[${jobId}] Executing Wav2Lip...`);
        console.log(`[${jobId}] 🐛 Full command: ${command}`);
        console.log(`[${jobId}] 🐛 Settings: faceBatchSize=${faceBatchSize} wav2lipBatchSize=${wav2lipBatchSize} resizeFactor=${resizeFactor}`);

        // ✅ FIX #6: heavy debug — everything gets written to a per-job log file
        // that survives even a hard process kill (OOM crashes wipe truncated
        // console output but the file stream flushes incrementally).
        const startTime = Date.now();
        const debugLogPath = path.join(outputDir, `${jobId}_wav2lip_debug.log`);
        const debugStream = fs.createWriteStream(debugLogPath, { flags: 'a' });
        debugStream.write(
            `\n=== Wav2Lip run started ${new Date().toISOString()} ===\n` +
            `cmd: ${command}\n` +
            `faceBatchSize=${faceBatchSize} wav2lipBatchSize=${wav2lipBatchSize} resizeFactor=${resizeFactor}\n`
        );

        let stdout, stderr;
        try {
            ({ stdout, stderr } = await execAsync(command, {
                timeout: 600000,           // 10 minutes
                maxBuffer: 1024 * 1024 * 100,
                shell: true                // ✅ Important for Windows
            }));
            debugStream.write(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}\n=== SUCCESS ===\n`);
            debugStream.end();
        } catch (execError) {
            // ✅ execError.stdout / execError.stderr ARE populated by Node even on
            // failure/timeout/kill — capture them explicitly so a crash never loses
            // the trace (previously only error.message was logged, which can truncate).
            debugStream.write(
                `FAILED after ${Math.round((Date.now() - startTime) / 1000)}s\n` +
                `STDOUT:\n${execError.stdout || '(none)'}\n` +
                `STDERR:\n${execError.stderr || '(none)'}\n` +
                `message: ${execError.message}\n=== END (FAILED) ===\n`
            );
            debugStream.end();
            console.error(`[${jobId}] ❌ Wav2Lip exec failed — full trace written to ${debugLogPath}`);
            throw execError;
        }

        const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

        // Log warnings if any
        if (stderr) {
            console.warn(`[${jobId}] Wav2Lip warnings: ${stderr}`);
        }

        // Log stdout for debugging
        if (stdout) {
            console.log(`[${jobId}] Wav2Lip output: ${stdout.substring(0, 500)}`);
        }

        // ✅ Verify output file was created
        if (!fs.existsSync(outputPath)) {
            throw new Error("Wav2Lip output file not generated. Check logs for errors.");
        }

        const outputSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
        console.log(`[${jobId}] ✅ Lip sync video generated successfully`);
        console.log(`[${jobId}]   Output: ${outputPath}`);
        console.log(`[${jobId}]   Size: ${outputSize} MB`);
        console.log(`[${jobId}]   Processing time: ${processingTime}s`);

        return outputPath;

    } catch (error) {
        console.error(`[${jobId}] ❌ Wav2Lip failed: ${error.message}`);

        // Provide helpful error messages
        if (error.message.includes('CUDA out of memory')) {
            console.error(`[${jobId}] Reduce batch sizes: face_det_batch_size=1, wav2lip_batch_size=32`);
        }
        if (error.message.includes('ModuleNotFoundError')) {
            console.error(`[${jobId}] Missing Python dependencies. Run: pip install -r requirements.txt`);
        }
        if (error.message.includes('FFmpeg')) {
            console.error(`[${jobId}] FFmpeg not found. Download from: https://ffmpeg.org/download.html`);
        }

        throw error;
    }
};

/**
 * Helper function to check if Wav2Lip is properly installed
 * Call this during server startup
 */
export const verifyWav2LipInstallation = async () => {
    try {
        const wav2lipPath = process.env.WAV2LIP_PATH || './Wav2Lip';
        const checkpointPath = path.join(wav2lipPath, 'checkpoints', 'wav2lip_gan.pth');

        if (!fs.existsSync(wav2lipPath)) {
            throw new Error(`Wav2Lip directory not found: ${wav2lipPath}`);
        }

        if (!fs.existsSync(checkpointPath)) {
            throw new Error(`Checkpoint not found: ${checkpointPath}`);
        }

        console.log('✅ Wav2Lip installation verified');
        return true;
    } catch (error) {
        console.error('❌ Wav2Lip verification failed:', error.message);
        return false;
    }
};