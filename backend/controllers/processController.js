// controllers/processController.js - ENHANCED WITH FIXED AUDIO PATH AND LANGUAGE PARAMETER PASSING

// ===== IMPORT REQUIRED MODULES =====
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { extractAudio, extractAudioForcedAlignment, alignTranslatedAudio } from '../services/audioService.js';
import { assembleVideoWithCaptions, assembleVideoWithAudioOnly } from '../services/videoService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { translateText, translateSegments } from '../services/translationService.js';
import { generateTTS } from '../services/ttsService.js';
import { generateCaptions, generateAccurateCaptions } from '../services/captionService.js';
import { validateTranslationQuality } from '../services/validationService.js';
import { analyzeDiarizationProsody, forcedAlignMFA, inferDominantSpeakerProfile } from '../services/enhancedPipelineService.js';
import { generateLipSyncVideo } from '../services/lipSyncService.js';


// Set FFmpeg binary path
ffmpeg.setFfmpegPath(ffmpegStatic);

// ===== LANGUAGE NAME MAPPING =====
const getLanguageName = (languageCode) => {
  const languageNames = {
    'hi': 'हिंदी (Hindi)',
    'bn': 'বাংলা (Bengali)',
    'ta': 'தமிழ் (Tamil)',
    'te': 'తెలుగు (Telugu)',
    'mr': 'मराठी (Marathi)',
    'gu': 'ગુજરાતી (Gujarati)',
    'kn': 'ಕನ್ನಡ (Kannada)',
    'ml': 'മലയാളം (Malayalam)',
    'pa': 'ਪੰਜਾਬੀ (Punjabi)',
    'ur': 'اردو (Urdu)',
    'en': 'English'
  };

  return languageNames[languageCode] || languageCode;
};

// ===== MAIN PROCESSING FUNCTION - CORRECTED PIPELINE LOGIC =====
export const processVideo = async (jobId, options = {}) => {
  const startTime = new Date();

  // ✅ THIS ENTIRE 'try' BLOCK IS REPLACED WITH THE CORRECT PIPELINE LOGIC
  try {
    // Language setup remains the same
    const sourceLanguage = options.sourceLanguage || options.sourceLang || options.fromLang || 'hi';
    const targetLanguage = options.targetLanguage || options.targetLang || options.toLang || null;
    if (!targetLanguage) {
      throw new Error(`Target language not specified.`);
    }
    console.log(`[${jobId}] 🎯 FINAL LANGUAGE CONFIGURATION: Source: ${sourceLanguage}, Target: ${targetLanguage}`);
    markJobActive(jobId);
    await logProcessingStep(jobId, 'processing', 'audio_extraction', { source_language: sourceLanguage, target_language: targetLanguage });

    // ===== STEP 1: EXTRACT AUDIO =====
    console.log(`[${jobId}] PIPELINE STEP 1/7: Extracting Audio...`);
    const audioResult = await extractAudio(jobId);
    const audioPath = validateAndExtractAudioPath(audioResult, jobId); // Assuming this helper is in the file
    if (!audioPath) throw new Error('Audio extraction failed to return a valid path.');

    // ✅ NEW: Capture the Demucs BGM stem so it can be mixed back into the final video.
    // Previously computed by audioService.js and then silently discarded — the final
    // video always shipped with background music/ambience fully replaced by the flat
    // TTS-only track. See assembleVideoWithCaptions() call below.
    const bgmAudioPath = audioResult?.timing_metadata?.bgm_path || null;
    console.log(`[${jobId}] 🎵 BGM stem available for remix: ${bgmAudioPath ? '✅ ' + bgmAudioPath : '❌ none (will use vocals-only)'}`);

    await logProcessingStep(jobId, 'processing', 'transcription');

    // ===== STEP 2: TRANSCRIBE AUDIO =====
    console.log(`[${jobId}] PIPELINE STEP 2/7: Transcribing Audio...`);
    const transcription = await transcribeAudio(audioPath, jobId, sourceLanguage, targetLanguage, { enhancement: true });

    console.log(`[${jobId}] 🐛 DEBUG: Returned from transcribeAudio. Moving to Step 3.`);

    // ===== STEP 2.5: SPEAKER DIARIZATION + PROSODY (BEST-EFFORT, NON-BLOCKING) =====
    let diarizationData = null;
    let speakerProfile = { numSpeakers: 1, dominantRegister: 'unknown', meanF0Hz: null, confidence: 'low' };
    try {
      diarizationData = await analyzeDiarizationProsody(audioPath, jobId);
      speakerProfile = inferDominantSpeakerProfile(diarizationData);
      console.log(`[${jobId}] 🎙️ Speaker profile: ${speakerProfile.numSpeakers} speaker(s), register=${speakerProfile.dominantRegister} (F0≈${speakerProfile.meanF0Hz ?? 'n/a'}Hz, confidence=${speakerProfile.confidence})`);

      // Persist so getProcessingStatus() can expose it — closes the "computed but
      // never surfaced/saved" gap for this step specifically.
      await logProcessingStep(jobId, 'processing', 'diarization_prosody', {
        diarization_summary: {
          num_speakers: speakerProfile.numSpeakers,
          dominant_register: speakerProfile.dominantRegister,
          mean_f0_hz: speakerProfile.meanF0Hz,
          confidence: speakerProfile.confidence
        }
      });
    } catch (diarError) {
      console.warn(`[${jobId}] ⚠️ Diarization/prosody skipped: ${diarError.message}`);
    }

    // ===== STEP 3: EXTRACT WORD ALIGNMENT (THE NEW WAY) =====
    console.log(`[${jobId}] PIPELINE STEP 3/7: Extracting Word-Level Alignment...`);
    const alignmentData = await extractAudioForcedAlignment(transcription, audioPath, jobId);

    await logProcessingStep(jobId, 'processing', 'translation');

    // ===== STEP 4: TRANSLATE TEXT =====
    console.log(`[${jobId}] PIPELINE STEP 4/7: Translating Text...`);
    const translation = await translateSegments(transcription, sourceLanguage, targetLanguage, jobId);


    try {
  const translationsDir = path.join('uploads', 'translations');
  if (!fs.existsSync(translationsDir)) {
    fs.mkdirSync(translationsDir, { recursive: true });
  }
  const translationPath = path.join(translationsDir, `${jobId}_translation.json`);
  fs.writeFileSync(translationPath, JSON.stringify(translation, null, 2), 'utf8');
  console.log(`[${jobId}] ✅ Translation data saved for resume capability: ${translationPath}`);
} catch (saveError) {
  console.warn(`[${jobId}] ⚠️ Could not save translation file for resume capability: ${saveError.message}`);
}


    console.log(`🐛 [${jobId}] DEBUG (processVideo): Translation object received. Language: ${translation?.language}, Text length: ${translation?.text?.length}`);
    console.log(`🐛 [${jobId}] DEBUG (processVideo): Passing this to assembleVideoWithCaptions.`);


    console.log(`[${jobId}] 🐛 Translation result type:`, typeof translation);
    console.log(`[${jobId}] 🐛 Translation.text:`, translation?.text?.substring(0, 100));
    console.log(`[${jobId}] 🐛 Translation.text length:`, translation?.text?.length);
    console.log(`[${jobId}] 🐛 Full translation object keys:`, Object.keys(translation || {}));


    console.log(`[${jobId}] Step 4.5/7: Validating translation quality...`);
    if (translation.segments && Array.isArray(translation.segments)) {
    await validateTranslationQuality(translation.segments, translation.language, jobId);
    } else {
              console.log(`[${jobId}] ⚠️ Translation validation skipped - no segments array`);
    }

    await logProcessingStep(jobId, 'processing', 'tts_generation');



//Varunnnnnnnnnnnnnnn

// ===== STEP 5: GENERATE TTS =====
console.log(`[${jobId}] PIPELINE STEP 5/8: Generating Speech...`);
// ✅ FIX: Capture the return value of generateTTS directly as a string.
const translatedAudioPath = await generateTTS(translation, jobId, {
  targetLanguage: targetLanguage,
  speakerProfile,
  diarizationData,
  vocalsPath: audioResult?.timing_metadata?.vocals_path || null   // ✅ NEW: reference clip for voice cloning
});

// Add a validation check to ensure we got a valid path
if (!translatedAudioPath || typeof translatedAudioPath !== 'string') {
  throw new Error('generateTTS did not return a valid audio file path.');
}

await logProcessingStep(jobId, 'processing', 'aligning_translation');

// ===== STEP 6: ALIGN TRANSLATED AUDIO (NEW STEP) =====
console.log(`[${jobId}] PIPELINE STEP 6/8: Aligning Translated Speech...`);
let translatedAlignmentData;
if (process.env.ENABLE_MFA_ALIGNMENT === 'true') {
  try {
    translatedAlignmentData = await forcedAlignMFA(translatedAudioPath, translation.text, targetLanguage, jobId);
  } catch (mfaError) {
    console.warn(`[${jobId}] ⚠️ MFA alignment failed, falling back to Whisper word timings: ${mfaError.message}`);
    translatedAlignmentData = await alignTranslatedAudio(translatedAudioPath, jobId, targetLanguage);
  }
} else {
  translatedAlignmentData = await alignTranslatedAudio(translatedAudioPath, jobId, targetLanguage);
}

await logProcessingStep(jobId, 'processing', 'video_assembly');

// ===== STEP 7: ASSEMBLE FINAL VIDEO =====
console.log(`[${jobId}] PIPELINE STEP 7/8: Assembling Final Video...`);
// Pass the NEW translatedAlignmentData instead of the old one. We pass null for lipSyncData.
if (!translation || !translation.text) {
  throw new Error('Translation object missing required text field');
}
console.log(`[${jobId}] 🎬 Passing translation to video assembly (${translation.text.length} chars in ${translation.language})`);
const finalVideoResult = await assembleVideoWithCaptions(jobId, translatedAlignmentData, translation, null, bgmAudioPath);
let finalVideoPath = finalVideoResult.outputPath;

// ===== STEP 7.5: WAV2LIP LIP SYNCHRONIZATION (OPTIONAL) =====
if (process.env.ENABLE_LIP_SYNC === 'true') {
  console.log(`[${jobId}] PIPELINE STEP 7.5/8: Applying Wav2Lip lip synchronization...`);
  try {
    finalVideoPath = await generateLipSyncVideo(finalVideoPath, translatedAudioPath, jobId);
    console.log(`[${jobId}] ✅ Lip-synced video generated: ${finalVideoPath}`);
  } catch (lipSyncError) {
    console.warn(`[${jobId}] ⚠️ Lip sync failed, using non-lip-synced final video: ${lipSyncError.message}`);
  }
}

// ===== STEP 8: MARK JOB AS COMPLETED =====
console.log(`[${jobId}] PIPELINE STEP 8/8: Finalizing Job...`);
const endTime = new Date();
const processingDuration = endTime - startTime;

await logProcessingStep(jobId, 'completed', 'completed', {
    completed_at: endTime,
    processing_duration_ms: processingDuration,
    processed_file_path: finalVideoPath
});

console.log(`[${jobId}] 🎉 PROCESSING COMPLETED SUCCESSFULLY!`);

    // You can build and return a final success object if needed, but the core logic is complete.
    return { success: true, final_video_path: finalVideoPath };

  } catch (error) {
    // Your existing catch block for error handling is fine.
    console.error(`[${jobId}] ❌ PROCESSING FAILED!`);
    console.error(`[${jobId}] Error message: ${error.message}`);
    console.error(`[${jobId}] Error stack trace:`, error.stack);
    const endTime = new Date();
    const processingDuration = endTime - startTime;
    try {
      await logProcessingStep(jobId, 'failed', 'failed', {
        failed_at: endTime,
        processing_duration_ms: processingDuration,
        error_message: error.message,
        error_stack: error.stack,
      });
      console.log(`[${jobId}] Error logged to filesystem`);
    } catch (logError) {
      console.error(`[${jobId}] Failed to log error to filesystem:`, logError.message);
    }
    throw error;
  }
};

// ===== DISCOVER LANGUAGES FROM FILESYSTEM =====
const discoverLanguagesFromFiles = async (jobId) => {
  console.log(`[${jobId}] Discovering languages from filesystem...`);

  // Try multiple possible file locations and formats
  const possibleConfigPaths = [
    `./uploads/jobs/${jobId}_config.json`,
    `./uploads/logs/${jobId}_processing.json`,
    `./uploads/upload_info/${jobId}.json`,
    `./uploads/metadata/${jobId}_metadata.json`,
    `./uploads/language_config/${jobId}.json`
  ];

  for (const configPath of possibleConfigPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);

        console.log(`[${jobId}] Found config in ${configPath}:`, config);

        // Try multiple field name variations
        const sourceLanguage = config.sourceLanguage ||
                             config.source_language ||
                             config.sourceLang ||
                             config.fromLang ||
                             'hi';

        const targetLanguage = config.targetLanguage ||
                             config.target_language ||
                             config.targetLang ||
                             config.toLang ||
                             config.toLanguage ||
                             null;

        if (targetLanguage) {
          console.log(`[${jobId}] ✅ Languages discovered: ${sourceLanguage} → ${targetLanguage}`);
          return { sourceLanguage, targetLanguage };
        }
      } catch (parseError) {
        console.warn(`[${jobId}] Failed to parse config file ${configPath}:`, parseError.message);
      }
    }
  }

  console.warn(`[${jobId}] No language configuration found in filesystem`);
  return { sourceLanguage: 'hi', targetLanguage: null };
};


// 🔥 ADD ALL THREE HELPER FUNCTIONS HERE 🔥

// ===== CREATE VALIDATED FALLBACK OBJECT =====
const createValidatedFallbackObject = async (jobId) => {
  try {
    console.log(`[${jobId}] Creating validated fallback object...`);

    // Discover original video file
    const originalVideoPath = await discoverOriginalVideo(jobId);

    if (!originalVideoPath || !fs.existsSync(originalVideoPath)) {
      console.warn(`[${jobId}] No valid original video found for fallback`);
      return null;
    }

    // Get file stats
    const videoStats = fs.statSync(originalVideoPath);
    const videoName = path.basename(originalVideoPath);

    // Create properly structured fallback object with required properties
    const fallbackObject = {
      id: jobId,
      job_id: jobId,
      file_path: originalVideoPath,
      filepath: originalVideoPath,
      path: originalVideoPath,
      filename: videoName,
      file_name: videoName,
      original_filename: videoName,
      size: videoStats.size,
      file_size: videoStats.size,
      created_at: videoStats.birthtime,
      upload_date: videoStats.birthtime,
      uploaded_at: new Date().toISOString(),
      status: 'uploaded',
      mime_type: getMimeType(originalVideoPath),
      extension: path.extname(originalVideoPath),
      // Default properties to prevent undefined access
      source_language: 'hi',
      target_language: null,
      processing_status: 'queued'
    };

    console.log(`[${jobId}] ✅ Fallback object created with ${Object.keys(fallbackObject).length} properties`);
    return fallbackObject;

  } catch (error) {
    console.error(`[${jobId}] Failed to create fallback object:`, error.message);
    return null;
  }
};

// ===== VALIDATE AND EXTRACT AUDIO PATH =====
const validateAndExtractAudioPath = (audioResult, jobId) => {
  console.log(`[${jobId}] Validating audio result type:`, typeof audioResult);

  // Strategy 1: Handle string result
  if (typeof audioResult === 'string') {
    console.log(`[${jobId}] Audio result is string: ${audioResult}`);
    return audioResult;
  }

  // Strategy 2: Handle object result with multiple property checks
  if (audioResult && typeof audioResult === 'object') {
    console.log(`[${jobId}] Audio result object properties:`, Object.keys(audioResult));

    const possiblePaths = [
      audioResult.whisper_audio_path,
      audioResult.audioPath,
      audioResult.outputPath,
      audioResult.path,
      audioResult.audio_path,
      audioResult.filePath,
      audioResult.file_path,
      audioResult.output,
      audioResult.result
    ];

    for (const pathCandidate of possiblePaths) {
      if (pathCandidate && typeof pathCandidate === 'string' && fs.existsSync(pathCandidate)) {
        console.log(`[${jobId}] ✅ Valid audio path found: ${pathCandidate}`);
        return pathCandidate;
      }
    }

    // Strategy 3: Try nested object properties
    if (audioResult.result && typeof audioResult.result === 'object') {
      return validateAndExtractAudioPath(audioResult.result, jobId);
    }
  }

  // Strategy 4: Fallback to expected file location
  const expectedPaths = [
    `./uploads/audio/${jobId}_audio.wav`,
    `./uploads/audio/${jobId}.wav`,
    `./uploads/extracted_audio/${jobId}_audio.wav`,
    `./uploads/processing/${jobId}/audio.wav`
  ];

  for (const expectedPath of expectedPaths) {
    if (fs.existsSync(expectedPath)) {
      console.log(`[${jobId}] ✅ Found audio file at expected location: ${expectedPath}`);
      return expectedPath;
    }
  }

  console.error(`[${jobId}] ❌ No valid audio path found in result or expected locations`);
  return null;
};

// ===== GET MIME TYPE HELPER =====
const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.wmv': 'video/x-ms-wmv'
  };
  return mimeTypes[ext] || 'video/mp4';
};


// ===== FILESYSTEM-BASED STATUS LOGGING WITH LANGUAGE INFO =====
// In-memory registry of jobs actively running in THIS process. If the process
// restarts (nodemon, crash, etc.), this Map is empty again — which is exactly
// what we use below to detect "the log says processing, but nobody is home".
export const activeJobs = new Map(); // jobId -> { pid, startedAt }

export const markJobActive = (jobId) => {
  activeJobs.set(jobId, { pid: process.pid, startedAt: new Date().toISOString() });
};

export const markJobInactive = (jobId) => {
  activeJobs.delete(jobId);
};

const logProcessingStep = async (jobId, status, step, additionalData = {}) => {
  try {
    const logsDir = './uploads/logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, `${jobId}_processing.json`);

    // Read existing log or create new one
    let processingLog = {
      jobId: jobId,
      created_at: new Date().toISOString(),
      status: 'uploaded',
      step: 'queued',
      steps_completed: [],
      languages: {
        source: additionalData.source_language || 'hi',
        target: additionalData.target_language || null,
        source_name: additionalData.source_language_name || 'Hindi',
        target_name: additionalData.target_language_name || null
      }
    };

    if (fs.existsSync(logFile)) {
      const existingLog = fs.readFileSync(logFile, 'utf8');
      processingLog = JSON.parse(existingLog);
    }

    // Update current status
    processingLog.status = status;
    processingLog.step = step;
    processingLog.pid = process.pid;
    processingLog.last_updated = new Date().toISOString();

    // Update language info if provided
    if (additionalData.source_language) {
      processingLog.languages.source = additionalData.source_language;
    }
    if (additionalData.target_language) {
      processingLog.languages.target = additionalData.target_language;
    }
    if (additionalData.source_language_name) {
      processingLog.languages.source_name = additionalData.source_language_name;
    }
    if (additionalData.target_language_name) {
      processingLog.languages.target_name = additionalData.target_language_name;
    }

    // Add step completion record
    processingLog.steps_completed.push({
      step: step,
      status: status,
      timestamp: new Date().toISOString(),
      ...additionalData
    });

    // Write updated log
    fs.writeFileSync(logFile, JSON.stringify(processingLog, null, 2));

    console.log(`[${jobId}] Status logged: ${status} - ${step} (pid ${process.pid})`);

    if (status === 'processing') {
      markJobActive(jobId);
    } else if (status === 'completed' || status === 'failed') {
      markJobInactive(jobId);
    }

  } catch (error) {
    console.warn(`[${jobId}] Failed to log processing step:`, error.message);
  }
};

// ===== FILE DISCOVERY FUNCTIONS =====
const discoverOriginalVideo = async (jobId) => {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const videoDirs = ['./uploads/originals/', './uploads/'];

  for (const dir of videoDirs) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);

      // First try to find job-specific file
      const jobVideo = files.find(file =>
        file.includes(jobId) && videoExtensions.some(ext => file.endsWith(ext))
      );

      if (jobVideo) {
        return path.join(dir, jobVideo);
      }

      // Otherwise use most recent
      const videoFiles = files.filter(file =>
        videoExtensions.some(ext => file.endsWith(ext))
      );

      if (videoFiles.length > 0) {
        const mostRecent = videoFiles
          .map(file => ({
            name: file,
            path: path.join(dir, file),
            mtime: fs.statSync(path.join(dir, file)).mtime
          }))
          .sort((a, b) => b.mtime - a.mtime)[0];

        return mostRecent.path;
      }
    }
  }

  return null;
};

const findTranscriptionFile = async (jobId) => {
  const transcriptionPaths = [
    `./uploads/transcription/${jobId}/transcription_results.json`,
    `./uploads/transcripts/${jobId}_transcript.json`,
    `./uploads/transcripts/${jobId}_sr_output.json`,
    `./uploads/transcripts/${jobId}_whisper_output.json`
  ];

  for (const filePath of transcriptionPaths) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
};

const findTranslationFile = async (jobId) => {
  const translationPaths = [
    `./uploads/translations/${jobId}_translation.json`,
    `./uploads/translations/${jobId}_translated.json`
  ];

  for (const filePath of translationPaths) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
};

// ===== STATUS CHECKING FUNCTION - ENHANCED WITH LANGUAGE INFO =====
export const getProcessingStatus = async (req, res) => {
  try {
    const jobId = req.params.jobId;
    console.log(`[${jobId}] Status check requested (filesystem with language info)`);

    const logFile = `./uploads/logs/${jobId}_processing.json`;

    if (!fs.existsSync(logFile)) {
      console.log(`[${jobId}] Job log not found in filesystem`);
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        jobId: jobId,
        message: 'The requested job ID does not exist in filesystem logs'
      });
    }

    const logData = fs.readFileSync(logFile, 'utf8');
    const processingLog = JSON.parse(logData);

    // ✅ FIX: every path below used to be handed to the frontend as a raw
    // filesystem-relative string (e.g. "./uploads/processed/<id>_final.mp4"
    // or "uploads/originals/<id>.mp4"). A browser resolves a path like that
    // against the CURRENT PAGE URL, not the site root — so on any route that
    // isn't literally "/" (a SPA route like /job/:id, a hash route, anything
    // with a path segment), the same string points somewhere else entirely
    // and the resource silently 404s client-side, even though the backend
    // pipeline succeeded and the file genuinely exists on disk. Converting
    // to a root-relative URL ("/uploads/...") makes it resolve correctly no
    // matter what page the frontend is currently on.
    const toPublicUrl = (relPath) => {
      if (!relPath) return null;
      const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      return `/${normalized}`;
    };

    // Discover current files
    const files = {
      original_video: toPublicUrl(await discoverOriginalVideo(jobId)),
      extracted_audio: fs.existsSync(`./uploads/audio/${jobId}_audio.wav`) ? toPublicUrl(`./uploads/audio/${jobId}_audio.wav`) : null,
      transcription: toPublicUrl(await findTranscriptionFile(jobId)),
      translation: toPublicUrl(await findTranslationFile(jobId)),
      tts_audio: fs.existsSync(`./uploads/translated_audio/${jobId}_translated.wav`) ? toPublicUrl(`./uploads/translated_audio/${jobId}_translated.wav`) : null,
      captions: fs.existsSync(`./uploads/captions/${jobId}_captions.vtt`) ? toPublicUrl(`./uploads/captions/${jobId}_captions.vtt`) : null,
      srt: fs.existsSync(`./uploads/captions/${jobId}_captions.srt`) ? toPublicUrl(`./uploads/captions/${jobId}_captions.srt`) : null,
      transcript: fs.existsSync(`./uploads/transcripts/${jobId}_transcript.txt`) ? toPublicUrl(`./uploads/transcripts/${jobId}_transcript.txt`) : null,
      final_video: fs.existsSync(`./uploads/processed/${jobId}_final.mp4`) ? toPublicUrl(`./uploads/processed/${jobId}_final.mp4`) : null
    };

// ✅ STALLED-JOB DETECTION: if the log says "processing" but (a) this process
    // has no memory of running that job, and (b) the last write is older than
    // STALL_THRESHOLD_MS, the job is dead — almost always due to a server
    // restart mid-pipeline (nodemon, crash, deploy). Surface this instead of
    // silently reporting "processing" forever.
    const STALL_THRESHOLD_MS = 45 * 1000; // no heartbeat for 45s+ => stalled
    const isStillProcessing = processingLog.status === 'processing';
    const ownedByThisProcess = activeJobs.has(jobId);
    const lastUpdatedMs = processingLog.last_updated ? new Date(processingLog.last_updated).getTime() : 0;
    const msSinceUpdate = Date.now() - lastUpdatedMs;
    const isStalled = isStillProcessing && !ownedByThisProcess && msSinceUpdate > STALL_THRESHOLD_MS;

    if (isStalled) {
      console.warn(`[${jobId}] ⚠️ STALLED: status=processing but no active worker owns this job (last update ${Math.round(msSinceUpdate / 1000)}s ago, log pid=${processingLog.pid || 'unknown'}, this pid=${process.pid}). The server likely restarted mid-job (check nodemon).`);
    }

    const statusResponse = {
      success: true,
      jobId: jobId,
      status: isStalled ? 'stalled' : (processingLog.status || 'uploaded'),
      step: processingLog.step || 'queued',
      created_at: processingLog.created_at,
      last_updated: processingLog.last_updated || null,
      seconds_since_last_update: processingLog.last_updated ? Math.round(msSinceUpdate / 1000) : null,
      stalled: isStalled,
      stalled_reason: isStalled ? 'Server process restarted or crashed mid-job; no active worker for this jobId.' : null,

      // ✅ ENHANCED: Include language information
      languages: {
        source: {
          code: processingLog.languages?.source || 'hi',
          name: processingLog.languages?.source_name || getLanguageName(processingLog.languages?.source || 'hi')
        },
        target: {
          code: processingLog.languages?.target || null,
          name: processingLog.languages?.target_name || (processingLog.languages?.target ? getLanguageName(processingLog.languages.target) : null)
        }
      },

      steps_completed: processingLog.steps_completed || [],
      files: files,
      processing_completed: processingLog.status === 'completed',
      processing_failed: processingLog.status === 'failed' || isStalled,
      error_message: processingLog.steps_completed?.find(s => s.error_message)?.error_message || null
    };

    console.log(`[${jobId}] Status: ${statusResponse.status}, Step: ${statusResponse.step}${isStalled ? ' (⚠️ STALLED)' : ''} — last update ${statusResponse.seconds_since_last_update ?? '?'}s ago`);
    console.log(`[${jobId}] Languages: ${statusResponse.languages.source.code} → ${statusResponse.languages.target.code}`);

    res.json(statusResponse);

  } catch (error) {
    console.error('Status check filesystem error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Status check failed',
      message: 'Unable to retrieve job status from filesystem',
      details: error.message
    });
  }
};

// ===== PROCESSING STATISTICS WITH LANGUAGE BREAKDOWN =====
export const getProcessingStats = async () => {
  try {
    const logsDir = './uploads/logs';
    if (!fs.existsSync(logsDir)) {
      return { total: 0, completed: 0, failed: 0, processing: 0 };
    }

    const logFiles = fs.readdirSync(logsDir).filter(file => file.endsWith('_processing.json'));

    let stats = {
      total: logFiles.length,
      completed: 0,
      failed: 0,
      processing: 0,
      uploaded: 0,
      avgDuration: 0,
      languagePairs: {},
      popularTargetLanguages: {}
    };

    let totalDuration = 0;
    let completedCount = 0;

    for (const logFile of logFiles) {
      try {
        const logData = fs.readFileSync(path.join(logsDir, logFile), 'utf8');
        const log = JSON.parse(logData);

        // Track language pairs
        if (log.languages?.source && log.languages?.target) {
          const pair = `${log.languages.source}-${log.languages.target}`;
          stats.languagePairs[pair] = (stats.languagePairs[pair] || 0) + 1;
          stats.popularTargetLanguages[log.languages.target] = (stats.popularTargetLanguages[log.languages.target] || 0) + 1;
        }

        switch (log.status) {
          case 'completed':
            stats.completed++;
            const completedStep = log.steps_completed.find(s => s.step === 'completed');
            if (completedStep && completedStep.processing_duration_ms) {
              totalDuration += completedStep.processing_duration_ms;
              completedCount++;
            }
            break;
          case 'failed':
            stats.failed++;
            break;
          case 'processing':
            stats.processing++;
            break;
          default:
            stats.uploaded++;
        }
      } catch (parseError) {
        console.warn(`Failed to parse log file ${logFile}:`, parseError.message);
      }
    }

    if (completedCount > 0) {
      stats.avgDuration = totalDuration / completedCount;
    }

    return stats;

  } catch (error) {
    console.error('Failed to get processing stats:', error.message);
    throw error;
  }
};

// ===== RESUME PROCESSING WITH LANGUAGE PRESERVATION =====
export const resumeProcessing = async (jobId, fromStep = null, options = {}) => {
  try {
    console.log(`[${jobId}] Resuming processing from step: ${fromStep || 'auto-detect'}`);

    const logFile = `./uploads/logs/${jobId}_processing.json`;

    if (!fs.existsSync(logFile)) {
      console.log(`[${jobId}] No existing log found, starting fresh processing`);
      return await processVideo(jobId, options);
    }

    const logData = fs.readFileSync(logFile, 'utf8');
    const processingLog = JSON.parse(logData);

    // ✅ PRESERVE LANGUAGES FROM LOG
    const preservedOptions = {
      ...options,
      sourceLanguage: processingLog.languages?.source || options.sourceLanguage || 'hi',
      targetLanguage: processingLog.languages?.target || options.targetLanguage,
    };

    console.log(`[${jobId}] Current status: ${processingLog.status}, Last step: ${processingLog.step}`);
    console.log(`[${jobId}] Preserved languages: ${preservedOptions.sourceLanguage} → ${preservedOptions.targetLanguage}`);

    if (processingLog.status === 'completed') {
      console.log(`[${jobId}] Processing already completed`);
      return { success: true, message: 'Processing already completed', jobId };
    }

    // Resume processing with preserved language settings
    console.log(`[${jobId}] Resuming full processing pipeline with preserved languages...`);
    return await processVideo(jobId, preservedOptions);

  } catch (error) {
    console.error(`[${jobId}] Failed to resume processing:`, error.message);
    throw error;
  }
};

// ===== CLEANUP FUNCTIONS =====
export const cleanupOldLogs = async (days = 7) => {
  try {
    const logsDir = './uploads/logs';
    if (!fs.existsSync(logsDir)) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
    const logFiles = fs.readdirSync(logsDir);

    let cleanedCount = 0;

    for (const logFile of logFiles) {
      try {
        const filePath = path.join(logsDir, logFile);
        const stats = fs.statSync(filePath);

        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      } catch (fileError) {
        console.warn(`Failed to cleanup log file ${logFile}:`, fileError.message);
      }
    }

    console.log(`Cleaned up ${cleanedCount} log files older than ${days} days`);
    return cleanedCount;

  } catch (error) {
    console.error('Failed to cleanup log files:', error.message);
    throw error;
  }
};

// ===== EXPORT ALL FUNCTIONS =====
export default {
  processVideo,
  getProcessingStatus,
  getProcessingStats,
  cleanupOldLogs,
  resumeProcessing
};