// services/lipSyncService.js - FIXED VERSION FOR WINDOWS

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

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

        // ✅ FIX #4: GPU detection and batch size adjustment
        let faceBatchSize = 4;
        let wav2lipBatchSize = 128;
        
        try {
            const { stdout: gpuCheck } = await execAsync(`${pythonPath} -c "import torch; print(torch.cuda.is_available())"`);
            const hasGPU = gpuCheck.trim() === 'True';
            
            if (!hasGPU) {
                console.warn(`[${jobId}] ⚠️ No GPU detected - using CPU (slower processing)`);
                faceBatchSize = 1;
                wav2lipBatchSize = 32;
            } else {
                console.log(`[${jobId}] ✅ GPU detected - using GPU acceleration`);
            }
        } catch (error) {
            console.warn(`[${jobId}] Could not detect GPU, defaulting to CPU settings`);
            faceBatchSize = 1;
            wav2lipBatchSize = 32;
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
            '--resize_factor 1',
            '--nosmooth'
        ];
        
        const command = commandArgs.join(' ');

        console.log(`[${jobId}] Executing Wav2Lip...`);
        console.log(`[${jobId}] Command: ${command.substring(0, 150)}...`);

        // ✅ FIX #6: Add progress tracking
        const startTime = Date.now();
        
        const { stdout, stderr } = await execAsync(command, {
            timeout: 600000,           // 10 minutes
            maxBuffer: 1024 * 1024 * 100,
            shell: true                // ✅ Important for Windows
        });

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
