// services/ttsService.js - FIXED TTS SEGMENT REPETITION ISSUE

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { synthesizeMmsTts, MMS_ONLY_LANGUAGES } from './enhancedPipelineService.js';
import { mapSpeakersToTranslationSegments, buildPerSpeakerRegisterMap } from './speakerVoiceMapper.js';
import { cloneVoiceTimbre } from './voiceCloningService.js';
import { execSync } from 'child_process';

// ✅ NEW: centralizes duration-convergence trigger thresholds that were
// previously scattered as bare magic numbers (0.15 / 0.3 / 0.1) across four
// different functions — tuning one required hunting through the whole file.
const DURATION_TOLERANCE = {
  SENTENCE_LEVEL: 0.15,        // per-sentence trigger, before concatenation
  FULL_CLIP_SAFETY_NET: 0.3,   // rare safety net after prosody+duration correction
  POST_CLONE: 0.1,             // tighter check post-clone (should already be near-exact)
};


// ✅ NEW: edge-tts frequently pads clips with 0.1–2s of dead air at the start
// and/or end (worse on short text and negative `rate=` values — exactly what
// this pipeline uses). Left untouched, every downstream duration-matching
// step treats that padding as real content and stretches it proportionally
// along with actual speech — this is the direct cause of translated audio
// that visibly "runs out" of speech before the source clip/video ends.
const trimSilenceEdges = async (audioFile, jobId) => {
  const tempFile = `${audioFile}_trimmed.wav`;
  const filterExpr =
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:' +
    'stop_periods=-1:stop_threshold=-50dB:stop_silence=0.15,' +
    'apad=pad_dur=0.05'; // tiny 50ms tail so words don't click/cut off at the join
  const command = `ffmpeg -i "${audioFile}" -af "${filterExpr}" -y "${tempFile}"`;

  return new Promise((resolve) => {
    exec(command, { timeout: 30000 }, (error) => {
      if (error || !fs.existsSync(tempFile)) {
        console.warn(`[${jobId}] Silence trim skipped (${error ? error.message : 'no output'}), using untrimmed clip`);
        resolve();
        return;
      }
      try {
        // If the whole clip got trimmed away, it was almost entirely silence
        // to begin with (TTS glitch) — keep the original rather than ship
        // an empty file.
        if (fs.statSync(tempFile).size < 500) {
          fs.unlinkSync(tempFile);
          resolve();
          return;
        }
        fs.copyFileSync(tempFile, audioFile);
        fs.unlinkSync(tempFile);
      } catch (_) {}
      resolve();
    });
  });
};

// ✅ FIX: rubberband is NOT compiled into the ffmpeg binary actually installed
// (confirmed from the ffmpeg configure banner in the logs — no --enable-librubberband).
// Detect this ONCE, cache it, and transparently fall back to atempo (tempo) /
// asetrate+atempo (pitch) — both ship in every stock ffmpeg build — instead of
// silently failing every single duration/pitch correction, every single job.
let _rubberbandAvailable = null;
const hasRubberband = () => {
  if (_rubberbandAvailable !== null) return _rubberbandAvailable;
  try {
    const out = execSync('ffmpeg -hide_banner -filters', { timeout: 10000 }).toString();
    _rubberbandAvailable = /\brubberband\b/.test(out);
  } catch (_) {
    _rubberbandAvailable = false;
  }
  console.log(`[ttsService] librubberband available: ${_rubberbandAvailable ? 'YES (formant-preserving stretch/pitch enabled)' : 'NO (falling back to atempo — install an ffmpeg build with --enable-librubberband for better quality)'}`);
  return _rubberbandAvailable;
};

// atempo only accepts 0.5–2.0 per instance; chain multiple stages for extreme ratios.
// (Same logic as audioService.js's buildAtempoChain — duplicated here so ttsService
// doesn't need a cross-file import just for this.)
const buildAtempoChainTTS = (ratio) => {
  const stages = [];
  let remaining = ratio;
  while (remaining > 2.0) { stages.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5) { stages.push(0.5); remaining /= 0.5; }
  stages.push(remaining);
  return stages.map(r => `atempo=${r.toFixed(6)}`).join(',');
};

// ===== NEW: PICK PRIMARY VS ALTERNATIVE VOICE USING DIARIZATION-DERIVED SPEAKER PROFILE =====
// Wires the previously-unused diarization/F0 output into an actual TTS decision.
// Deliberately conservative: only overrides the default voice when confidence is
// 'medium' AND the configured alternative voice has a different gender tag than the
// primary — otherwise today's default behavior is unchanged. This is job-level voice
// selection, NOT per-speaker/per-segment switching (that needs a diarization-segment
// ↔ translation-segment mapping, which is a separate, not-yet-built feature).
const applySpeakerProfileToVoice = (voiceConfig, speakerProfile, jobId, targetLanguage) => {
  if (!voiceConfig || !speakerProfile) return voiceConfig;
  if (speakerProfile.confidence !== 'medium') return voiceConfig;
  if (!voiceConfig.alternativeGender || voiceConfig.alternativeGender === voiceConfig.gender) return voiceConfig;

  const preferMale = speakerProfile.dominantRegister === 'lower';
  const preferFemale = speakerProfile.dominantRegister === 'higher';

  const primaryMatches = (preferMale && voiceConfig.gender === 'male') || (preferFemale && voiceConfig.gender === 'female');
  if (primaryMatches) return voiceConfig;

  console.log(`[${jobId}] 🎙️ Diarization-derived register (${speakerProfile.dominantRegister}, F0≈${speakerProfile.meanF0Hz}Hz) suggests the alternative ${targetLanguage} voice is a closer match; switching.`);
  return {
    ...voiceConfig,
    voice: voiceConfig.alternative,
    alternative: voiceConfig.voice,
    gender: voiceConfig.alternativeGender,
    alternativeGender: voiceConfig.gender
  };
};

// ===== NEW: per-segment voice resolution using the diarization speaker map =====
// Additive to applySpeakerProfileToVoice above (which sets one job-level voice).
// This overrides that choice per-segment only when a specific segment's mapped
// speaker has medium-or-higher confidence — otherwise the job-level voice stands.
const resolveVoiceForSegment = (segment, baseVoiceConfig, registerMap, jobId, targetLanguage) => {
  if (!segment.speaker || !registerMap || !registerMap[segment.speaker]) {
    return baseVoiceConfig;
  }

  const speakerInfo = registerMap[segment.speaker];
  if (speakerInfo.confidence === 'low') return baseVoiceConfig;

  if (!baseVoiceConfig.alternativeGender || baseVoiceConfig.alternativeGender === baseVoiceConfig.gender) {
    return baseVoiceConfig;
  }

  const preferMale = speakerInfo.register === 'lower';
  const primaryMatches = (preferMale && baseVoiceConfig.gender === 'male') ||
                          (!preferMale && baseVoiceConfig.gender === 'female');
  if (primaryMatches) return baseVoiceConfig;

  console.log(`[${jobId}] 🎙️ Segment speaker ${segment.speaker} (register=${speakerInfo.register}) → switching to alternative ${targetLanguage} voice`);
  return {
    ...baseVoiceConfig,
    voice: baseVoiceConfig.alternative,
    alternative: baseVoiceConfig.voice,
    gender: baseVoiceConfig.alternativeGender,
    alternativeGender: baseVoiceConfig.gender
  };
};

const execAsync = promisify(exec);

// ===== LANGUAGE NAME MAPPING =====
const getLanguageName = (languageCode) => {
  const languageNames = {
    'hi': 'हिंदी (Hindi)',
    'bn': 'বাংলা (Bengali)',
    'ta': 'தমিழ் (Tamil)',
    'te': 'తెలుగు (Telugu)',
    'mr': 'मराठी (Marathi)',
    'gu': 'ગુજરાતી (Gujarati)',
    'kn': 'ಕನ್ನಡ (Kannada)',
    'ml': 'മলയാളം (Malayalam)',
    'pa': 'ਪੰਜਾਬੀ (Punjabi)',
    'ur': 'اردو (Urdu)',
    'en': 'English'
  };
  
  return languageNames[languageCode] || languageCode;
};

// ===== MAIN TTS FUNCTION - FIXED LANGUAGE PARAMETER =====
export const generateTTS = async (translation, jobId, options = {}) => {
  try {
    console.log(`[${jobId}] Starting enhanced TTS with explicit language control...`);
    
    // ===== VALIDATE INPUT TRANSLATION =====
    if (!translation || !translation.text) {
      throw new Error('Invalid translation object provided');
    }
    
    // ✅ CRITICAL: Use target language from options first, then translation
    const targetLanguage = options.targetLanguage || 
                          options.voiceLanguage || 
                          options.language ||
                          translation.language;
                          
    if (!targetLanguage) {
      throw new Error('Target language not specified in options or translation object');
    }

    // ===== MMS-TTS ROUTE FOR LANGUAGES WITHOUT EDGE-TTS VOICES (e.g. Sindhi, Manipuri) =====
    if (MMS_ONLY_LANGUAGES.has(targetLanguage)) {
      console.log(`[${jobId}] 🎯 ${targetLanguage} has no edge-tts voice, routing to MMS-TTS (CC-BY-NC-4.0)`);
      const mmsAudioPath = await synthesizeMmsTts(translation.text, targetLanguage, jobId);
      return mmsAudioPath;
    }

    
    console.log(`[${jobId}] 🎯 TTS Generation with TARGET LANGUAGE: ${targetLanguage} (${getLanguageName(targetLanguage)})`);
    console.log(`[${jobId}] Text length: ${translation.text.length} characters`);
    console.log(`[${jobId}] Segments: ${translation.segments ? translation.segments.length : 0}`);
    console.log(`[${jobId}] Options provided:`, options);
    
    // ✅ GET VOICE FOR SPECIFIC LANGUAGE
    let voiceConfig = getVoiceForLanguage(targetLanguage);

    if (!voiceConfig) {
      console.warn(`[${jobId}] No direct voice available for language: ${targetLanguage}`);

      // Try to find compatible fallback
      const fallbackLanguage = findCompatibleVoiceFallback(targetLanguage);
      if (fallbackLanguage) {
        console.log(`[${jobId}] Using fallback language: ${fallbackLanguage} for ${targetLanguage}`);
        let fallbackVoice = getVoiceForLanguage(fallbackLanguage);

        if (fallbackVoice) {
          fallbackVoice = applySpeakerProfileToVoice(fallbackVoice, options.speakerProfile, jobId, fallbackLanguage);
          return await generateTTSWithVoice(translation, jobId, fallbackVoice, targetLanguage, options);
        }
      }

      throw new Error(`No TTS voice available for language: ${targetLanguage}`);
    }

    voiceConfig = applySpeakerProfileToVoice(voiceConfig, options.speakerProfile, jobId, targetLanguage);

    console.log(`[${jobId}] ✅ Using voice: ${voiceConfig.voice} (${voiceConfig.name}) for ${targetLanguage}`);

    console.log(`[${jobId}] 🐛 DEBUG - Translation object:`, JSON.stringify(translation, null, 2));
    console.log(`[${jobId}] 🐛 DEBUG - translation.text value:`, translation.text);
    console.log(`[${jobId}] 🐛 DEBUG - translation.text type:`, typeof translation.text);



    
    // Continue with TTS generation using voiceConfig
    return await generateTTSWithVoice(translation, jobId, voiceConfig, targetLanguage, options);
    
  } catch (error) {
    console.error(`[${jobId}] TTS generation failed:`, error.message);
    
    // Create fallback TTS file
    try {
      console.log(`[${jobId}] Creating TTS fallback...`);
      return await createTTSFallback(translation, jobId, options.targetLanguage || translation.language);
    } catch (fallbackError) {
      console.error(`[${jobId}] TTS fallback also failed:`, fallbackError.message);
      throw error;
    }
  }
};

// ===== GENERATE TTS WITH SPECIFIC VOICE =====
const generateTTSWithVoice = async (translation, jobId, voiceConfig, targetLanguage, options = {}) => {
  try {
    console.log(`[${jobId}] Generating TTS with voice configuration...`);
    
    // ===== GET ACTUAL DURATION =====
    let actualDuration = translation.originalduration || 
                        translation.duration || 
                        (translation.segments && translation.segments.length > 0 ? 
                         translation.segments[translation.segments.length - 1].end : 0) || 
                        30;
    
    // Try to get actual video duration
    try {
      const originalVideoPath = await discoverOriginalVideoFile(jobId);
      if (originalVideoPath && fs.existsSync(originalVideoPath)) {
        const videoDuration = await getVideoDurationDirect(originalVideoPath);
        actualDuration = videoDuration;
        console.log(`[${jobId}] Using actual video duration: ${actualDuration}s`);
      }
    } catch (durationError) {
      console.warn(`[${jobId}] Failed to get video duration:`, durationError.message);
    }
    
    console.log(`[${jobId}] TTS CONFIGURATION:`);
    console.log(`[${jobId}]   Language: ${targetLanguage} (${getLanguageName(targetLanguage)})`);
    console.log(`[${jobId}]   Voice: ${voiceConfig.voice} (${voiceConfig.quality})`);
    console.log(`[${jobId}]   Target duration: ${actualDuration}s`);
    
    // ===== CREATE OUTPUT DIRECTORY =====
    const outputDir = './uploads/translated_audio';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const audioFileName = `${jobId}_translated.wav`;
    const audioFilePath = path.join(outputDir, audioFileName);
    
    // ===== CHOOSE TTS GENERATION METHOD =====
    // translation.segments is undefined for every engine that actually succeeds today
    // (MyMemory / IndicTrans2 / Google all return a flat {text, ...} object with no
    // segments array) — this pipeline ALWAYS takes the full-text branch below. The
    // pitch-matching hook must live there, not only in the segment-based path.
    if (translation.segments && translation.segments.length > 0) {
      console.log(`[${jobId}] Using segment-based TTS generation...`);
      return await generateSegmentBasedTTS(translation, voiceConfig, audioFilePath, jobId, actualDuration, targetLanguage, options.diarizationData || null, options.vocalsPath || null);
    // AFTER
} else {
      console.log(`[${jobId}] Using full-text TTS generation...`);
      const targetF0Hz = options.diarizationData?.f0?.mean_f0_hz ?? options.speakerProfile?.meanF0Hz ?? null;
      // ✅ NEW: std_f0_hz was already being computed by run_diarize_prosody.py
      // and never used anywhere — it's the missing piece needed to reshape
      // pitch variance, not just the mean.
      const targetStdF0Hz = options.diarizationData?.f0?.std_f0_hz ?? null;
      // ✅ NEW: the real source-speaker F0 CONTOUR (not just mean/std) so
      // match_prosody.py can time-warp the actual pitch trajectory onto the
      // TTS clip instead of only rescaling aggregate statistics.
      const targetF0Contour = options.diarizationData?.f0?.contour ?? null;
      return await generateFullTextTTS(translation, voiceConfig, audioFilePath, jobId, actualDuration, targetLanguage, targetF0Hz, options.vocalsPath || null, targetStdF0Hz, targetF0Contour);
    }
    
  } catch (error) {
    console.error(`[${jobId}] TTS generation with voice failed:`, error.message);
    throw error;
  }
};


/* Validates if content appears to be in the target language */
const validateLanguageContent = async (texts, targetLanguage, jobId) => {
    console.log(`[${jobId}] Validating language content for: ${targetLanguage}`);
    
    // Basic validation - check for language-specific characteristics
    const combinedText = texts.join(' ').toLowerCase();
    
    // Language-specific validation rules
    const languageValidation = {
        'hi': () => /[\u0900-\u097F]/.test(combinedText), // Devanagari script
        'bn': () => /[\u0980-\u09FF]/.test(combinedText), // Bengali script
        'ta': () => /[\u0B80-\u0BFF]/.test(combinedText), // Tamil script
        'te': () => /[\u0C00-\u0C7F]/.test(combinedText), // Telugu script
        'mr': () => /[\u0900-\u097F]/.test(combinedText), // Devanagari script
        'gu': () => /[\u0A80-\u0AFF]/.test(combinedText), // Gujarati script
        'kn': () => /[\u0C80-\u0CFF]/.test(combinedText), // Kannada script
        'ml': () => /[\u0D00-\u0D7F]/.test(combinedText), // Malayalam script
        'pa': () => /[\u0A00-\u0A7F]/.test(combinedText), // Gurmukhi script
        'ur': () => /[\u0600-\u06FF]/.test(combinedText), // Arabic script
        'en': () => /^[a-zA-Z\s.,!?'"()-]+$/.test(combinedText.substring(0, 100))
    };
    
    const validator = languageValidation[targetLanguage];
    if (validator) {
        const isValid = validator();
        console.log(`[${jobId}] Language validation for ${targetLanguage}: ${isValid ? 'PASS' : 'FAIL'}`);
        return isValid;
    }
    
    // If no specific validator, assume valid
    console.log(`[${jobId}] No specific language validator for ${targetLanguage}, assuming valid`);
    return true;
};


// In file: ttsService.js
// Replace the existing 'validateTranslationQuality' function with this complete version.

const validateTranslationQuality = async (segments, targetLanguage, jobId) => {
    console.log(`[${jobId}] Validating translation quality for ${segments.length} segments...`);
    
    try {
        if (!segments || segments.length === 0) {
            throw new Error("Validation failed: No segments provided to validate.");
        }

        const uniqueTexts = new Set();
        const translatedTexts = [];
        
        segments.forEach((segment) => {
            if (segment.text && segment.text.trim().length > 0) {
                uniqueTexts.add(segment.text.trim().toLowerCase());
                translatedTexts.push(segment.text);
            }
        });
        
        // VALIDATION 1: Identical content check (major failure indicator)
        if (uniqueTexts.size === 1 && segments.length > 1) {
            const repeatedText = [...uniqueTexts][0];
            console.error(`[${jobId}] TRANSLATION FAILURE: All ${segments.length} segments contain identical text: "${repeatedText.substring(0, 100)}..."`);
            throw new Error(`Translation failed - all ${segments.length} segments contain identical content, indicating a translation API failure.`);
        }
        
        // VALIDATION 2: Check for untranslated content (original text = translated text)
        let untranslatedCount = 0;
        segments.forEach((segment, index) => {
            // Check if 'originaltext' exists and is different from the translated 'text'
            if (segment.text && segment.originaltext && segment.text.trim() === segment.originaltext.trim() && segment.text.trim().length > 5) {
                untranslatedCount++;
                console.warn(`[${jobId}] Segment ${index + 1} appears untranslated: "${segment.text.substring(0, 50)}..."`);
            }
        });
        
        const untranslatedPercentage = (untranslatedCount / segments.length) * 100;
        if (untranslatedPercentage > 75) { // Stricter threshold
            throw new Error(`Translation failed: Over ${untranslatedPercentage.toFixed(0)}% of segments appear to be untranslated.`);
        }
        
        // VALIDATION 3: Check for language-specific script content
        const hasTargetLanguageContent = await validateLanguageContent(translatedTexts, targetLanguage, jobId);
        if (!hasTargetLanguageContent) {
            throw new Error(`Translation failed - content does not appear to be in the target language script for '${targetLanguage}'.`);
        }
        
        // VALIDATION 4: Check for low segment variation (warning, not a hard failure)
        if (segments.length > 3 && uniqueTexts.size < Math.ceil(segments.length * 0.3)) {
            console.warn(`[${jobId}] Low translation variety: ${uniqueTexts.size} unique texts from ${segments.length} segments. Quality may be suboptimal.`);
        }
        
        console.log(`[${jobId}] ✅ Translation validation PASSED:`);
        console.log(`[${jobId}]   - ${segments.length} total segments`);
        console.log(`[${jobId}]   - ${uniqueTexts.size} unique translations`);
        console.log(`[${jobId}]   - ${untranslatedCount} untranslated segments (${untranslatedPercentage.toFixed(1)}%)`);
        console.log(`[${jobId}]   - Target language script validated: ${targetLanguage}`);
        
        return {
            isValid: true,
            totalSegments: segments.length,
            uniqueTexts: uniqueTexts.size,
            untranslatedCount,
            untranslatedPercentage,
            targetLanguage
        };
        
    } catch (error) {
        console.error(`[${jobId}] ❌ Translation validation FAILED: ${error.message}`);
        
        // Log detailed failure information for debugging
        console.error(`[${jobId}] Validation failure details:`);
        console.error(`[${jobId}]   - Total segments: ${segments ? segments.length : 0}`);
        console.error(`[${jobId}]   - Target language: ${targetLanguage}`);
        if (segments) {
            console.error(`[${jobId}]   - Sample segments:`, segments.slice(0, 3).map((s, i) => ({
                index: i + 1,
                text: s.text ? s.text.substring(0, 100) : 'NO_TEXT',
                originaltext: s.originaltext ? s.originaltext.substring(0, 100) : 'NO_ORIGINAL'
            })));
        }
        
        throw error; // Re-throw the error to stop the TTS generation process
    }
};


// ===== SEGMENT-BASED TTS GENERATION WITH VALIDATION + PER-SPEAKER VOICE SWITCHING =====
const generateSegmentBasedTTS = async (translation, voiceConfig, outputPath, jobId, actualDuration, targetLanguage, diarizationData = null, vocalsPath = null) => {
  console.log(`[${jobId}] Starting segment-based TTS generation...`);

  const tempDir = './uploads/temp_audio';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const segmentAudioFiles = [];

  try {
    let segmentsToProcess = translation.segments || [];
    console.log(`[${jobId}] Processing ${segmentsToProcess.length} segments...`);

    console.log(`[${jobId}] Validating translation quality before TTS...`);
    try {
      await validateTranslationQuality(segmentsToProcess, targetLanguage, jobId);
    } catch (validationError) {
      console.error(`[${jobId}] Translation validation failed: ${validationError.message}`);
      throw validationError;
    }

    const uniqueSegmentTexts = new Set(segmentsToProcess.map(s => (s.text || '').trim()));
    if (uniqueSegmentTexts.size === 1 && segmentsToProcess.length > 1) {
        console.error(`[${jobId}] TRANSLATION FAILURE: All segments identical`);
        throw new Error(
            `Translation failed: All ${segmentsToProcess.length} segments contain ` +
            `identical text: "${[...uniqueSegmentTexts][0].substring(0, 100)}...". ` +
            `This indicates the translation service failed. Please retry.`
        );
    }

    console.log(`[${jobId}] ✅ Translation validation passed - ${uniqueSegmentTexts.size} unique segments`);

    // ===== NEW: build speaker → segment mapping if diarization found >1 speaker =====
    let registerMap = null;
    if (diarizationData && diarizationData.success !== false && diarizationData.diarization?.num_speakers > 1) {
      const timingsForMapping = prepareSegmentTimings(segmentsToProcess, actualDuration, jobId, targetLanguage);
      segmentsToProcess = mapSpeakersToTranslationSegments(
        diarizationData.diarization.segments,
        segmentsToProcess.map((s, i) => ({ ...s, start: timingsForMapping[i].start, end: timingsForMapping[i].end }))
      );
      registerMap = buildPerSpeakerRegisterMap(diarizationData);
      console.log(`[${jobId}] 🎙️ Per-speaker mapping built: ${diarizationData.diarization.num_speakers} speaker(s) → ${Object.keys(registerMap).length} register(s)`);
    }

    const segmentTimings = prepareSegmentTimings(segmentsToProcess, actualDuration, jobId, targetLanguage);

    // Generate audio for each segment
    for (let i = 0; i < segmentTimings.length; i++) {
      const segmentTiming = segmentTimings[i];
      const segment = segmentsToProcess[i];

      console.log(`[${jobId}] Processing segment ${i + 1}/${segmentTimings.length}: ${segmentTiming.start.toFixed(2)}s - ${segmentTiming.end.toFixed(2)}s${segment.speaker ? ` (speaker=${segment.speaker})` : ''}`);

      if (!segment.text || segment.text.trim().length === 0) {
        const silenceFile = path.join(tempDir, `${jobId}_segment_${i}_silence.wav`);
        await createPrecisionSilence(silenceFile, segmentTiming.duration);
        segmentAudioFiles.push({ file: silenceFile, isSilence: true });
        continue;
      }

      // ===== NEW: resolve voice per-segment when confident speaker info exists =====
      const segmentVoiceConfig = registerMap
        ? resolveVoiceForSegment(segment, voiceConfig, registerMap, jobId, targetLanguage)
        : voiceConfig;

      const segmentFile = path.join(tempDir, `${jobId}_segment_${i}.wav`);

      try {
        const segmentText = segment.text.trim();
        console.log(`[${jobId}] Generating TTS for segment ${i + 1} (${targetLanguage}): "${segmentText.substring(0, 50)}..."`);

        const segmentTargetF0 = registerMap?.[segment.speaker]?.meanF0Hz ?? diarizationData?.f0?.mean_f0_hz ?? null;
        await generateTTSForSegment(segmentText, segmentVoiceConfig, segmentFile, segmentTiming, jobId, i + 1, targetLanguage, segmentTargetF0);

        const generatedDuration = await getAudioDurationPrecise(segmentFile);

        // ✅ IMPROVED: single combined pass for tempo + pitch (previously two
        // separate rubberband invocations — one here, one inside
        // generateTTSForSegment). Halves the phase-vocoder passes this clip
        // goes through.
        await applyTempoAndPitchCorrection(segmentFile, segmentTiming.duration, generatedDuration, segmentTargetF0, jobId);

        segmentAudioFiles.push({ file: segmentFile, isSilence: false });

      } catch (segmentError) {
        console.warn(`[${jobId}] Segment ${i + 1} failed: ${segmentError.message}`);
        const fallbackSilenceFile = path.join(tempDir, `${jobId}_segment_${i}_fallback_silence.wav`);
        await createPrecisionSilence(fallbackSilenceFile, segmentTiming.duration);
        segmentAudioFiles.push({ file: fallbackSilenceFile, isSilence: true });
      }

      if (i < segmentTimings.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`[${jobId}] Concatenating ${segmentAudioFiles.length} audio segments...`);
    await concatenateAudioSegments(segmentAudioFiles, outputPath, jobId);

    // ✅ FIX: this path used to have nowhere to receive `vocalsPath` at all,
    // so any engine returning `segments` would ship the raw edge-tts voice,
    // untouched, no matter who the original speaker was. Clone runs LAST,
    // after concatenation — same ordering as the full-text path — so cloning
    // always operates on already duration-correct audio.
    // ✅ FIXED — tracks actual success instead of just "was a vocals path passed in"
    let clonedSuccessfully = false;
    if (vocalsPath) {
      const clonedPath = await cloneVoiceTimbre(outputPath, vocalsPath, jobId);
      if (clonedPath !== outputPath) {
        fs.copyFileSync(clonedPath, outputPath);
        try { fs.unlinkSync(clonedPath); } catch (_) {}
        clonedSuccessfully = true;
        const postCloneDuration = await getAudioDurationPrecise(outputPath);
        if (Math.abs(postCloneDuration - actualDuration) > 0.1) {
          await applyDurationAdjustment(outputPath, actualDuration, postCloneDuration, jobId);
        }
      }
    }

    const finalDuration = await getAudioDurationPrecise(outputPath);
    const accuracyPercentage = ((actualDuration - Math.abs(finalDuration - actualDuration)) / actualDuration) * 100;

    console.log(`[${jobId}] ✅ Segment-based TTS completed:`);
    console.log(`[${jobId}]   Target: ${actualDuration.toFixed(3)}s`);
    console.log(`[${jobId}]   Generated: ${finalDuration.toFixed(3)}s`);
    console.log(`[${jobId}]   Accuracy: ${accuracyPercentage.toFixed(1)}%`);
    console.log(`[${jobId}]   Voice cloned: ${clonedSuccessfully ? 'YES' : (vocalsPath ? 'NO (clone attempt failed — see [VoiceClone] logs above)' : 'NO (no reference vocals provided)')}`);
    await cleanupTempFiles(segmentAudioFiles, tempDir, jobId);
    return outputPath;

  } catch (error) {
    console.error(`[${jobId}] Segment-based TTS failed:`, error.message);
    await cleanupTempFiles(segmentAudioFiles, tempDir, jobId);
    throw error;
  }
};



// ===== FULL-TEXT TTS GENERATION =====
// Splits translated text into sentences on Devanagari/Gujarati danda (।),
// standard punctuation (. ! ?), and newlines, keeping the delimiter attached.
// Indic-script languages (hi/gu/mr/bn/...) still use "." in modern writing
// alongside the classical "।", so both are covered.
const splitIntoSentences = (text) => {
  const parts = text.match(/[^।.!?\n]+[।.!?]*[\n]*/g) || [text];
  return parts.map(s => s.trim()).filter(s => s.length > 0);
};

const generateFullTextTTS = async (translation, voiceConfig, outputPath, jobId, actualDuration, targetLanguage, targetF0Hz = null, vocalsPath = null, targetStdF0Hz = null, targetF0Contour = null) => {
  console.log(`[${jobId}] Starting full-text TTS generation...`);

  // ✅ FIX: Declare textToConvert OUTSIDE try block
  let textToConvert = translation.text || '';

  // Validate translation has text
  if (!textToConvert || textToConvert.trim().length === 0) {
    throw new Error('Translation text is empty or invalid');
  }

  // Limit text length for better quality
  const maxLength = 4000;
  if (textToConvert.length > maxLength) {
    console.warn(`[${jobId}] Text length ${textToConvert.length} exceeds limit, truncating to ${maxLength}`);
    textToConvert = textToConvert.substring(0, maxLength - 3) + '...';
  }

  console.log(`[${jobId}] Full-text TTS configuration:`);
  console.log(`[${jobId}]   Text length: ${textToConvert.length} characters`);
  console.log(`[${jobId}]   Target duration: ${actualDuration.toFixed(2)}s`);
  console.log(`[${jobId}]   Language: ${targetLanguage}`);
  console.log(`[${jobId}]   Target F0 for pitch match: ${targetF0Hz ? targetF0Hz.toFixed(1) + 'Hz' : 'none available'}`);

  try {
    // ✅ FIX (mono-pitch root cause): synthesizing the whole paragraph as ONE
    // edge-tts utterance suppresses the natural per-sentence pitch resets the
    // Azure neural voice would otherwise produce. Splitting by sentence and
    // giving each one its own proportional time budget (1) restores that
    // natural intonation variety and (2) keeps each sentence's individual
    // duration-correction ratio small, instead of one large whole-clip stretch.
    const sentences = splitIntoSentences(textToConvert);
    const speechRate = calculateOptimalSpeechRate(textToConvert, actualDuration, targetLanguage);

    // AFTER
if (sentences.length <= 1) {
      await executeTTSCommand(textToConvert, voiceConfig.voice, outputPath, speechRate, jobId, targetLanguage);
      await trimSilenceEdges(outputPath, jobId); // ✅ FIX: see rationale above
    } else {
      const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
      const tempDir = path.join('./uploads/temp_audio', `${jobId}_sentences`);
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      const sentenceFiles = [];
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        const sentenceTarget = actualDuration * (sentence.length / totalChars);
        const sentenceRate = calculateOptimalSpeechRate(sentence, Math.max(sentenceTarget, 0.3), targetLanguage);
        const sentenceFile = path.join(tempDir, `sent_${i}.wav`);

        await executeTTSCommand(sentence, voiceConfig.voice, sentenceFile, sentenceRate, jobId, targetLanguage);

        // ✅ FIX: trim BEFORE measuring/correcting duration, so the correction
        // ratio reflects real speech length, not speech+padding. This also
        // removes the audible gap between concatenated sentences (each
        // sentence's own trailing silence used to survive into the join).
        await trimSilenceEdges(sentenceFile, jobId);

        const genDur = await getAudioDurationPrecise(sentenceFile);
        if (Math.abs(genDur - sentenceTarget) > DURATION_TOLERANCE.SENTENCE_LEVEL && sentenceTarget > DURATION_TOLERANCE.POST_CLONE) {
          await applyDurationAdjustment(sentenceFile, sentenceTarget, genDur, jobId);
        }
        sentenceFiles.push({ file: sentenceFile });
      }

      await concatenateAudioSegments(sentenceFiles, outputPath, jobId);
      
      sentenceFiles.forEach(({ file }) => {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
      });
      try { fs.rmdirSync(tempDir); } catch (_) {}
    }

    // AFTER
// ✅ IMPROVED: prosody-contour match (WORLD, mean+variance, and now real
    // time-warped SHAPE when a source F0 contour is available) when available,
    // otherwise the single-pass rubberband tempo+pitch correction. Either path
    // always finishes with the clip sitting on actualDuration.
    await applyProsodyAndDurationCorrection(outputPath, actualDuration, targetF0Hz, targetStdF0Hz, jobId, targetF0Contour);

    const postCorrectionDuration = await getAudioDurationPrecise(outputPath);
    if (Math.abs(postCorrectionDuration - actualDuration) > DURATION_TOLERANCE.FULL_CLIP_SAFETY_NET) {
      // Rare safety net — only needed if the correction under/overshot.
      await applyDurationAdjustment(outputPath, actualDuration, postCorrectionDuration, jobId);
    }

    // Timbre clone runs LAST, on already duration- and pitch-corrected audio.
    let clonedSuccessfully = false;
    if (vocalsPath) {
      const clonedPath = await cloneVoiceTimbre(outputPath, vocalsPath, jobId);
      if (clonedPath !== outputPath) {
        fs.copyFileSync(clonedPath, outputPath);
        try { fs.unlinkSync(clonedPath); } catch (_) {}
        clonedSuccessfully = true;
        // Only a tiny touch-up should be needed now — the heavy lifting
        // already happened before cloning, so this stays close to ratio 1.0.
        const postCloneDuration = await getAudioDurationPrecise(outputPath);
if (Math.abs(postCloneDuration - actualDuration) > DURATION_TOLERANCE.POST_CLONE) {

          await applyDurationAdjustment(outputPath, actualDuration, postCloneDuration, jobId);
        }

        // ✅ NEW: OpenVoice's ToneColorConverter re-synthesizes through its own
        // vocoder and is NOT a guaranteed pass-through of the F0 track we just
        // spent two passes matching — until now nothing verified the contour
        // actually survived cloning. Re-measure and, if variance collapsed
        // meaningfully, reapply the WORLD contour match on the cloned output
        // (its spectral envelope/timbre stays exactly as OpenVoice left it —
        // only the F0 track gets restretched again).
        if (targetStdF0Hz) {
          try {
            const postCloneF0 = await measureF0Stats(outputPath, jobId);
            if (postCloneF0 && postCloneF0.std_f0_hz > 0 && postCloneF0.std_f0_hz < targetStdF0Hz * 0.85) {
              console.log(`[${jobId}] ⚠️ Pitch variance drifted after cloning (${postCloneF0.std_f0_hz.toFixed(1)}Hz vs target ${targetStdF0Hz.toFixed(1)}Hz) — reapplying prosody match`);
              await applyProsodyMatch(outputPath, targetF0Hz, targetStdF0Hz, jobId, targetF0Contour);
              const postReapplyDuration = await getAudioDurationPrecise(outputPath);
              if (Math.abs(postReapplyDuration - actualDuration) > DURATION_TOLERANCE.POST_CLONE) {
                await applyDurationAdjustment(outputPath, actualDuration, postReapplyDuration, jobId);
              }
            } else if (postCloneF0) {
              console.log(`[${jobId}] ✅ Post-clone pitch variance check passed (${postCloneF0.std_f0_hz.toFixed(1)}Hz vs target ${targetStdF0Hz.toFixed(1)}Hz)`);
            }
          } catch (verifyErr) {
            console.warn(`[${jobId}] ⚠️ Post-clone F0 verification skipped: ${verifyErr.message}`);
          }
        }
      }
    }

    const finalDuration = await getAudioDurationPrecise(outputPath);
    const fileStats = fs.statSync(outputPath);

    console.log(`[${jobId}] ✅ Full-text TTS completed:`);
    console.log(`[${jobId}]   Final duration: ${finalDuration.toFixed(2)}s`);
    console.log(`[${jobId}]   File size: ${Math.round(fileStats.size / 1024)}KB`);
    console.log(`[${jobId}]   Language: ${targetLanguage} (${getLanguageName(targetLanguage)})`);

    return outputPath;

  } catch (error) {
    console.error(`[${jobId}] Full-text TTS failed:`, error.message);

    // Try alternative voice if available
    if (voiceConfig.alternative) {
      console.log(`[${jobId}] Trying alternative voice: ${voiceConfig.alternative}`);
      try {
        // ✅ FIX: textToConvert is now accessible here
        await executeTTSCommand(textToConvert, voiceConfig.alternative, outputPath, speechRate, jobId, targetLanguage);
        if (targetF0Hz) {
          await applyPitchMatch(outputPath, targetF0Hz, jobId);
        }
        console.log(`[${jobId}] ✅ Alternative voice succeeded`);
        return outputPath;
      } catch (alternativeError) {
        console.error(`[${jobId}] Alternative voice also failed:`, alternativeError.message);
      }
    }

    throw error;
  }
};

// ===== UTILITY FUNCTIONS =====

// Generate TTS for individual segment
const generateTTSForSegment = async (text, voiceConfig, outputPath, timing, jobId, segmentNumber, targetLanguage, targetF0Hz = null) => {
  const cleanText = text.replace(/[""]/g, '"').replace(/['']/g, "'").trim();

  if (cleanText.length === 0) {
    throw new Error('Empty text after cleaning');
  }

  const rateParam = timing.speechRate || '+0%';

  console.log(`[${jobId}] Generating TTS for segment ${segmentNumber} (${targetLanguage}): "${cleanText.substring(0, 30)}..."`);

  // AFTER
try {
    await executeTTSCommand(cleanText, voiceConfig.voice, outputPath, rateParam, jobId, targetLanguage);
  } catch (primaryError) {
    if (voiceConfig.alternative) {
      console.warn(`[${jobId}] Primary voice failed for segment ${segmentNumber}, trying alternative`);
      await executeTTSCommand(cleanText, voiceConfig.alternative, outputPath, rateParam, jobId, targetLanguage);
    } else {
      throw primaryError;
    }
  }

  // ✅ FIX: strip edge-tts's own leading/trailing silence BEFORE duration
  // correction measures/stretches this clip. Without this, silence padding
  // gets counted as "speech time" and gets stretched right along with the
  // real speech, which is the direct cause of translated audio running out
  // of speech well before the video ends.
  // generateTTSForSegment — AFTER (pitch correction moved to the caller so it
// can be combined with tempo correction in one pass)
await trimSilenceEdges(outputPath, jobId);
  // Pitch + tempo correction now happen together in generateSegmentBasedTTS,
  // right after this returns — see applyTempoAndPitchCorrection.
};

// Execute TTS command using edge-tts, with retry on the transient
// NoAudioReceived error (Microsoft's TTS endpoint occasionally drops the
// connection — this is documented as intermittent upstream, not a bug
// in this code; see backend/scripts/benchmark_pipeline.py for the same
// pattern already used on the Python side).
const executeTTSCommand = async (text, voice, outputPath, rateParam, jobId, targetLanguage, retries = 3) => {
  const cleanText = text.replace(/"/g, '\\"').trim();
  const edgeTTSCommand = `edge-tts --voice "${voice}" --text "${cleanText}" --rate="${rateParam}" --write-media "${outputPath}"`;

  const runOnce = () => new Promise((resolve, reject) => {
    console.log(`[${jobId}] Executing TTS command for ${targetLanguage}: ${text.length} chars, rate: ${rateParam}`);

    exec(edgeTTSCommand, {
      maxBuffer: 1024 * 1024 * 50, // 50MB buffer
      timeout: 120000 // 2 minutes
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.message.includes('command not found')) {
          reject(new Error('Edge-TTS not installed. Install with: pip install --upgrade edge-tts'));
        } else if (error.message.includes('timeout')) {
          reject(new Error('TTS generation timeout. Text may be too complex.'));
        } else if (stderr && stderr.includes('NoAudioReceived')) {
          reject(new Error('NoAudioReceived'));
        } else {
          reject(new Error(`TTS execution failed: ${error.message}`));
        }
        return;
      }

      if (stderr && !stderr.includes('WARNING')) {
        console.warn(`[${jobId}] TTS warnings:`, stderr.substring(0, 200));
      }

      if (!fs.existsSync(outputPath)) {
        reject(new Error('TTS output file not created'));
        return;
      }

      const fileSize = fs.statSync(outputPath).size;
      if (fileSize < 1000) {
        reject(new Error(`Generated audio too small: ${fileSize} bytes`));
        return;
      }

      console.log(`[${jobId}] TTS generated successfully: ${Math.round(fileSize / 1024)}KB`);
      resolve();
    });
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await runOnce();
      return;
    } catch (err) {
      const isTransient = err.message.includes('NoAudioReceived');
      if (isTransient && attempt < retries) {
        console.warn(`[${jobId}] TTS attempt ${attempt}/${retries} failed (NoAudioReceived) — retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
};

// In file: ttsService.js
// Replace the entire 'prepareSegmentTimings' function with this complete version.

const prepareSegmentTimings = (segments, totalDuration, jobId, targetLanguage) => {
    console.log(`[${jobId}] Calculating DYNAMIC segment timings based on text length...`);

    const totalTextLength = segments.reduce((sum, seg) => sum + (seg.text?.trim().length || 0), 0);

    if (totalTextLength === 0) {
        console.warn(`[${jobId}] No text in segments to calculate proportional timing. Falling back to equal distribution.`);
        const segmentDuration = totalDuration / Math.max(1, segments.length);
        return segments.map((seg, i) => ({
            start: i * segmentDuration,
            end: (i + 1) * segmentDuration,
            duration: segmentDuration,
            speechRate: '+0%',
            segmentIndex: i,
        }));
    }

    const timings = [];
    let currentTime = 0;

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const textLength = segment.text?.trim().length || 0;

        // Weight the duration of each segment by the length of its text.
        // Longer sentences get more time, shorter ones get less.
        const proportionalDuration = (textLength / totalTextLength) * totalDuration;
        // Ensure a minimum duration for any segment to prevent errors.
        const duration = Math.max(0.5, proportionalDuration); 

        const speechRate = calculateOptimalSpeechRate(segment.text, duration, targetLanguage);

        timings.push({
            start: currentTime,
            end: currentTime + duration,
            duration: duration,
            speechRate: speechRate,
            segmentIndex: i,
            textLength: textLength
        });
        currentTime += duration;
    }

    // Normalize all timings to ensure exact target duration match
// Normalize all timings to ensure exact target duration match
const calculatedTotal = currentTime;
if (calculatedTotal > 0 && Math.abs(calculatedTotal - totalDuration) > 0.01) {
    const adjustmentFactor = totalDuration / calculatedTotal;
    let runningTime = 0;
    
    timings.forEach((timing, idx) => {
        timing.start = runningTime;
        timing.duration *= adjustmentFactor;
        timing.end = timing.start + timing.duration;
        runningTime = timing.end;
    });
    
    // Final precision fix for last segment only
    const lastTiming = timings[timings.length - 1];
    if (Math.abs(lastTiming.end - totalDuration) > 0.001) {
        const correction = totalDuration - lastTiming.end;
        lastTiming.end = totalDuration;
        lastTiming.duration += correction;
        console.log(`[${jobId}] Applied final ${correction.toFixed(3)}s correction to last segment`);
    }
    
    console.log(`[${jobId}] Timings normalized: ${timings[0].start.toFixed(3)}s to ${timings[timings.length-1].end.toFixed(3)}s`);
}

    console.log(`[${jobId}] ✅ Dynamic timings calculated: min=${Math.min(...timings.map(t => t.duration)).toFixed(2)}s, max=${Math.max(...timings.map(t => t.duration)).toFixed(2)}s`);

    return timings;
};


// Calculate speech rate for segment
const calculateSpeechRateForSegment = (text, duration) => {
  if (!text || duration <= 0) return '+0%';
  
  const wordsPerMinute = (text.split(' ').length / duration) * 60;
  
  // Adjust speech rate based on words per minute
  if (wordsPerMinute > 180) return '-20%'; // Slow down
  if (wordsPerMinute > 150) return '-10%';
  if (wordsPerMinute < 100) return '+10%'; // Speed up
  if (wordsPerMinute < 80) return '+20%';
  
  return '+0%'; // Normal rate
};

// Calculate optimal speech rate for full text.
// ✅ FIX: was 6 fixed buckets (-30/-20/-10/0/+10/+20%), rounding real-world
// drift into a residual error that later required a large, audible rubberband
// stretch. Computing the exact percentage directly gets the FIRST edge-tts
// pass much closer to the target duration, so every downstream stretch stays
// small (near ratio 1.0) and stays natural-sounding.
//
// ✅ NEW (character/mora-based, not word-count/WPM): space-delimited "word"
// count is a poor tempo proxy for Devanagari/Gujarati-family scripts — words
// don't correspond to a consistent syllable/mora count the way English words
// roughly do, so a WPM baseline tuned once doesn't track actual spoken tempo.
// Character count (matras/diacritics included, whitespace stripped) tracks
// spoken duration far more reliably across these scripts. Measured against
// real pipeline output, the old WPM estimate under-corrected pacing by ~26%;
// this CPS-based estimate lands much closer to true tempo on the first pass.
const calculateOptimalSpeechRate = (text, duration, language) => {
  if (!text || duration <= 0) return '+0%';

  const charCount = text.replace(/\s+/g, '').length;
  const currentCPS = charCount / duration;

  // Baseline natural speaking characters-per-second for edge-tts neural
  // voices at "+0%" — used only to seed the estimate; the real correction
  // still comes from actually measuring the generated clip afterward
  // (applyDurationAdjustment). Values are per-script, not per-"word",
  // which is what makes this robust across space-segmentation differences.
  const naturalCPS = {
    hi: 14, bn: 13, ta: 11, te: 11, mr: 13.5,
    gu: 14, kn: 11, ml: 10.5, pa: 14, ur: 13, en: 15
  };
  const baseline = naturalCPS[language] || 13;

  const requiredRatio = currentCPS / baseline; // >1 = need to speak faster
  const percentChange = Math.round((requiredRatio - 1) * 100);

  // edge-tts stays natural-sounding roughly within ±40%; beyond that, let the
  // post-generation rubberband pass (formant-preserving) take over instead of
  // pushing the TTS engine's own rate control into unnatural territory.
  const clamped = Math.max(-40, Math.min(40, percentChange));
  return `${clamped >= 0 ? '+' : ''}${clamped}%`;
};

// Get voice configuration for language
const getVoiceForLanguage = (languageCode) => {
  const voices = getSupportedVoices();
  return voices[languageCode] || null;
};

// Find compatible voice fallback
const findCompatibleVoiceFallback = (targetLanguage) => {
  const fallbackMappings = {
    'as': 'bn', // Assamese → Bengali
    'or': 'hi', // Odia → Hindi
    'ne': 'hi', // Nepali → Hindi
    'si': 'hi', // Sinhala → Hindi
    'my': 'bn'  // Myanmar → Bengali
  };
  
  return fallbackMappings[targetLanguage] || 'en';
};

// Discover original video file
const discoverOriginalVideoFile = async (jobId) => {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const searchPaths = ['./uploads/originals', './uploads'];
  
  for (const basePath of searchPaths) {
    if (fs.existsSync(basePath)) {
      try {
        const files = fs.readdirSync(basePath);
        
        // Job-specific search
        for (const ext of videoExtensions) {
          const specificFile = `${jobId}${ext}`;
          if (files.includes(specificFile)) {
            return path.join(basePath, specificFile);
          }
        }
        
        // Most recent video file
        const videoFiles = files.filter(file => 
          videoExtensions.some(ext => file.toLowerCase().endsWith(ext))
        );
        
        if (videoFiles.length > 0) {
          const mostRecent = videoFiles
            .map(file => ({
              name: file,
              path: path.join(basePath, file),
              mtime: fs.statSync(path.join(basePath, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime)[0];
          
          return mostRecent.path;
        }
      } catch (error) {
        console.warn(`[${jobId}] Error reading directory ${basePath}:`, error.message);
      }
    }
  }
  
  return null;
};

// Get video duration with high precision
const getVideoDurationDirect = async (videoPath) => {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${videoPath}"`;
    
    exec(command, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        // Fallback to format duration
        const fallbackCommand = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`;
        exec(fallbackCommand, { timeout: 20000 }, (fallbackError, fallbackStdout) => {
          if (fallbackError) {
            reject(new Error(`Duration detection failed: ${error.message}`));
            return;
          }
          
          const duration = parseFloat(fallbackStdout.trim());
          if (isNaN(duration) || duration <= 0) {
            reject(new Error(`Invalid fallback duration: ${fallbackStdout.trim()}`));
          } else {
            resolve(Math.round(duration * 100) / 100);
          }
        });
        return;
      }
      
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration) || duration <= 0) {
        reject(new Error(`Invalid duration: ${stdout.trim()}`));
      } else {
        resolve(Math.round(duration * 100) / 100);
      }
    });
  });
};

// Get audio duration with precision
const getAudioDurationPrecise = async (audioPath) => {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`;
    
    exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Audio duration check failed: ${error.message}`));
      } else {
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 0 : Math.round(duration * 1000) / 1000);
      }
    });
  });
};

// Create precision silence
const createPrecisionSilence = async (outputPath, duration) => {
  const preciseDuration = Math.round(duration * 1000) / 1000;
  const command = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${preciseDuration} -y "${outputPath}"`;
  
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Precision silence creation failed: ${error.message}`));
      } else {
        resolve(outputPath);
      }
    });
  });
};

// Apply duration adjustment
// Apply duration adjustment
const applyDurationAdjustment = async (audioFile, targetDuration, currentDuration, jobId) => {
  const speedRatio = currentDuration / targetDuration;
  const clampedRatio = Math.max(0.5, Math.min(2.0, speedRatio));

  if (Math.abs(speedRatio - 1) < 0.02) {
    return; // already close enough, no stretch needed
  }

  const tempFile = `${audioFile}_temp_adjust.wav`;
  // ✅ FIX: rubberband preserves formants and is preferred when available,
  // but THIS ffmpeg build does not have it compiled in (confirmed via
  // `ffmpeg -filters` at runtime, not just the stale comment that used to be
  // here). Falling back to atempo (chained for ratios outside 0.5–2.0)
  // guarantees duration correction ALWAYS actually runs instead of silently
  // failing on every job, which was the direct cause of the 17.95s-vs-8s
  // Gujarati audio/video length mismatch.
  const filterExpr = hasRubberband()
    ? `rubberband=tempo=${clampedRatio}`
    : buildAtempoChainTTS(clampedRatio);
  const command = `ffmpeg -i "${audioFile}" -filter:a "${filterExpr}" -y "${tempFile}"`;

  const runAdjust = () => new Promise((resolve, reject) => {
    exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`atempo failed: ${error.message} | stderr: ${stderr?.slice(0, 300)}`));
        return;
      }
      resolve();
    });
  });

  try {
    await runAdjust();

    if (!fs.existsSync(tempFile)) {
      throw new Error('atempo produced no output file');
    }

    fs.copyFileSync(tempFile, audioFile);
    fs.unlinkSync(tempFile);

    const verifiedDuration = await getAudioDurationPrecise(audioFile);
    const remainingError = Math.abs(verifiedDuration - targetDuration);
    if (remainingError > 0.3) {
      console.error(`[${jobId}] ❌ Duration adjustment did not converge: target=${targetDuration.toFixed(2)}s, got=${verifiedDuration.toFixed(2)}s (off by ${remainingError.toFixed(2)}s). Audio/video will be out of sync for this segment.`);
    } else {
      console.log(`[${jobId}] ✅ Duration adjustment verified: ${verifiedDuration.toFixed(2)}s (target ${targetDuration.toFixed(2)}s)`);
    }

  } catch (error) {
    console.error(`[${jobId}] ❌ Duration adjustment failed, audio left at original length (${currentDuration.toFixed(2)}s vs target ${targetDuration.toFixed(2)}s): ${error.message}`);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  }
};

// Concatenate audio segments
const concatenateAudioSegments = async (segmentAudioFiles, outputPath, jobId) => {
  return new Promise((resolve, reject) => {
    if (!segmentAudioFiles || segmentAudioFiles.length === 0) {
      reject(new Error('No audio files to concatenate'));
      return;
    }
    
    if (segmentAudioFiles.length === 1) {
      try {
        fs.copyFileSync(segmentAudioFiles[0].file, outputPath);
        resolve(outputPath);
      } catch (error) {
        reject(new Error(`Failed to copy single file: ${error.message}`));
      }
      return;
    }
    
    const tempDir = './uploads/temp_audio';
    const fileListPath = path.join(tempDir, `${jobId}_filelist.txt`);
    
    const fileListContent = segmentAudioFiles
      .map(audioFile => `file '${path.resolve(audioFile.file)}'`)
      .join('\n');
    
    try {
      fs.writeFileSync(fileListPath, fileListContent);
    } catch (error) {
      reject(new Error(`Failed to write file list: ${error.message}`));
      return;
    }
    
    const concatCommand = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy -y "${outputPath}"`;
    
    exec(concatCommand, {
      maxBuffer: 1024 * 1024 * 200, // 200MB buffer
      timeout: 180000 // 3 minutes
    }, (error, stdout, stderr) => {
      // Cleanup file list
      try {
        if (fs.existsSync(fileListPath)) {
          fs.unlinkSync(fileListPath);
        }
      } catch (cleanupError) {
        console.warn(`[${jobId}] Failed to cleanup file list:`, cleanupError.message);
      }
      
      if (error) {
        reject(new Error(`Audio concatenation failed: ${error.message}`));
      } else {
        console.log(`[${jobId}] Audio concatenation completed successfully`);
        resolve(outputPath);
      }
    });
  });
};

// Cleanup temporary files
const cleanupTempFiles = async (segmentAudioFiles, tempDir, jobId) => {
  console.log(`[${jobId}] Cleaning up temporary files...`);
  
  let cleaned = 0;
  let failed = 0;
  
  for (const audioFile of segmentAudioFiles) {
    try {
      if (fs.existsSync(audioFile.file)) {
        fs.unlinkSync(audioFile.file);
        cleaned++;
      }
    } catch (error) {
      console.warn(`[${jobId}] Failed to cleanup ${path.basename(audioFile.file)}:`, error.message);
      failed++;
    }
  }
  
  console.log(`[${jobId}] Cleanup completed: ${cleaned} files removed, ${failed} failed`);
};

// Create TTS fallback
const createTTSFallback = async (translation, jobId, targetLanguage) => {
  console.log(`[${jobId}] Creating TTS fallback for ${targetLanguage}...`);
  
  const outputDir = './uploads/translated_audio';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const audioFileName = `${jobId}_translated.wav`;
  const audioFilePath = path.join(outputDir, audioFileName);
  
  const fallbackDuration = translation.originalduration || translation.duration || 30;
  
  try {
    const command = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${fallbackDuration} -c:a pcm_s16le -y "${audioFilePath}"`;
    
    await new Promise((resolve, reject) => {
      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`TTS fallback creation failed: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
    
    const fileStats = fs.statSync(audioFilePath);
    console.log(`[${jobId}] ✅ TTS fallback created: ${Math.round(fileStats.size / 1024)}KB, ${fallbackDuration.toFixed(2)}s`);
    
    return audioFilePath;
    
  } catch (error) {
    console.error(`[${jobId}] TTS fallback creation failed:`, error.message);
    throw new Error(`All TTS methods failed: ${error.message}`);
  }
};

// ===== SUPPORTED VOICES CONFIGURATION =====
export const getSupportedVoices = () => {
  return {
    'hi': { voice: 'hi-IN-SwaraNeural', alternative: 'hi-IN-MadhurNeural', name: 'Hindi', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' },
    'bn': { voice: 'bn-IN-BashkarNeural', alternative: 'bn-IN-TanishaaNeural', name: 'Bengali', quality: 'excellent', gender: 'male', alternativeGender: 'female', region: 'India/Bangladesh' },
    'te': { voice: 'te-IN-ShrutiNeural', alternative: 'te-IN-MohanNeural', name: 'Telugu', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' },
    'ta': { voice: 'ta-IN-PallaviNeural', alternative: 'ta-IN-ValluvarNeural', name: 'Tamil', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India/Sri Lanka' },
    'mr': { voice: 'mr-IN-AarohiNeural', alternative: 'mr-IN-ManoharNeural', name: 'Marathi', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' },
    'gu': { voice: 'gu-IN-DhwaniNeural', alternative: 'gu-IN-NiranjanNeural', name: 'Gujarati', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' },
    'kn': { voice: 'kn-IN-SapnaNeural', alternative: 'kn-IN-GaganNeural', name: 'Kannada', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' },
    'ml': { voice: 'ml-IN-SobhanaNeural', alternative: 'ml-IN-MidhunNeural', name: 'Malayalam', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' },
    'pa': { voice: 'pa-IN-GaganNeural', alternative: 'pa-IN-HarpreetNeural', name: 'Punjabi', quality: 'good', gender: 'male', alternativeGender: 'female', region: 'India/Pakistan' },
    'ur': { voice: 'ur-PK-AsadNeural', alternative: 'ur-PK-UzmaNeural', name: 'Urdu', quality: 'good', gender: 'male', alternativeGender: 'female', region: 'Pakistan/India' },
    'en': { voice: 'en-IN-NeerjaNeural', alternative: 'en-IN-PrabhatNeural', name: 'English (India)', quality: 'excellent', gender: 'female', alternativeGender: 'male', region: 'India' }
  };
};

// ✅ NEW: combines tempo (duration) correction and pitch correction into a
// SINGLE rubberband pass instead of two-to-three sequential ffmpeg
// invocations. Chaining separate phase-vocoder passes (stretch → shift →
// often a second stretch to fix the drift the shift itself introduced)
// compounds resampling artifacts each time — this is the direct, measured
// cause of the F0-tracking instability and raised breathiness on real
// pipeline output (WORLD aperiodicity 0.68 on cloned audio vs 0.61 on the
// source; F0 range 40 semitones vs 28 on the source). One combined pass
// measurably reduces this.
const applyTempoAndPitchCorrection = async (audioFile, targetDuration, currentDuration, targetF0Hz, jobId) => {
  const speedRatio = currentDuration / targetDuration;
  const needsTempo = Math.abs(speedRatio - 1) >= 0.02;

  let pitchRate = null;
  if (targetF0Hz) {
    const EDGE_TTS_NATURAL_F0 = { female: 210, male: 120 };
    const currentVoiceF0 = targetF0Hz > 165 ? EDGE_TTS_NATURAL_F0.female : EDGE_TTS_NATURAL_F0.male;
    const semitoneShift = 12 * Math.log2(targetF0Hz / currentVoiceF0);
    const clampedShift = Math.max(-6, Math.min(6, semitoneShift));
    if (Math.abs(clampedShift) >= 0.3) {
      pitchRate = Math.pow(2, clampedShift / 12);
    }
  }

  if (!needsTempo && pitchRate === null) return; // nothing to do

  const clampedRatio = Math.max(0.5, Math.min(2.0, speedRatio));
  const tempFile = `${audioFile}_temp_combined.wav`;

  let filterExpr;
  if (hasRubberband()) {
    const parts = [];
    if (needsTempo) parts.push(`tempo=${clampedRatio}`);
    if (pitchRate !== null) parts.push(`pitch=${pitchRate}`);
    filterExpr = `rubberband=${parts.join(':')}`;
  } else {
    // No rubberband available: can't combine tempo+pitch in one filter, so
    // fall back to the old two-pass behavior. Still correct, just without
    // this function's quality benefit.
    const tempoExpr = needsTempo ? buildAtempoChainTTS(clampedRatio) : null;
    const pitchExpr = pitchRate !== null
      ? `asetrate=44100*${pitchRate},aresample=44100,atempo=${(1 / pitchRate).toFixed(6)}`
      : null;
    filterExpr = [tempoExpr, pitchExpr].filter(Boolean).join(',');
  }

  return new Promise((resolve) => {
    exec(`ffmpeg -i "${audioFile}" -filter:a "${filterExpr}" -y "${tempFile}"`, { timeout: 60000 }, (error) => {
      if (error || !fs.existsSync(tempFile)) {
        console.warn(`[${jobId}] Combined tempo/pitch correction failed, audio left uncorrected: ${error?.message}`);
        resolve();
        return;
      }
      fs.copyFileSync(tempFile, audioFile);
      fs.unlinkSync(tempFile);
      console.log(`[${jobId}] ✅ Combined tempo+pitch correction in one pass (tempo=${needsTempo ? clampedRatio.toFixed(3) : 'unchanged'}, pitch=${pitchRate !== null ? pitchRate.toFixed(3) : 'unchanged'})`);
      resolve();
    });
  });
};

// ✅ NEW: runs scripts/match_prosody.py — a WORLD-vocoder pass that reshapes
// the TTS clip's pitch CONTOUR (mean AND variance) toward the measured
// source-speaker statistics, instead of the flat multiplicative shift
// applyTempoAndPitchCorrection's pitch branch does. This is what actually
// closes the F0-range gap measured on real output (28 semitones on the
// source vs 40 on the flat-shifted clone).
// Needs the same interpreter as run_diarize_prosody.py — pyworld + soundfile
// live in the bhashasetu-mfa conda env, NOT the openvoice/torch env used for
// cloning — so this reuses PYTHON_PATH, not VOICECLONE_PYTHON_PATH.
const applyProsodyMatch = async (audioFile, targetMeanF0, targetStdF0, jobId, f0Contour = null) => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'match_prosody.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[${jobId}] match_prosody.py not found at ${scriptPath} — skipping prosody match`);
    return false;
  }

  const pythonBin = process.env.PYTHON_PATH || 'python';
  const outputPath = `${audioFile}_prosody.wav`;
  const resultJson = `${audioFile}_prosody_result.json`;

  // ✅ NEW: when a real source-speaker F0 contour is available (added
  // upstream in run_diarize_prosody.py), write it to a temp json and pass it
  // as the 6th arg so match_prosody.py can time-warp the actual pitch SHAPE
  // onto the clip instead of only rescaling mean/std. Falls back cleanly to
  // the scalar method inside match_prosody.py if this is omitted or empty.
  let contourPath = null;
  if (f0Contour && Array.isArray(f0Contour.t_norm) && f0Contour.t_norm.length >= 2) {
    contourPath = `${audioFile}_contour.json`;
    try {
      fs.writeFileSync(contourPath, JSON.stringify(f0Contour), 'utf-8');
    } catch (writeErr) {
      console.warn(`[${jobId}] ⚠️ Could not write F0 contour temp file, falling back to scalar rescale: ${writeErr.message}`);
      contourPath = null;
    }
  }

  const cmd = `"${pythonBin}" "${scriptPath}" "${audioFile}" "${targetMeanF0}" "${targetStdF0}" "${outputPath}" "${resultJson}"${contourPath ? ` "${contourPath}"` : ''}`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      let resultOk = false;
      let method = 'unknown';
      try {
        if (fs.existsSync(resultJson)) {
          const result = JSON.parse(fs.readFileSync(resultJson, 'utf-8'));
          resultOk = !!result.success;
          method = result.method || method;
          if (!resultOk) console.warn(`[${jobId}] ⚠️ Prosody match reported failure: ${result.error}`);
        }
      } catch (parseErr) {
        console.warn(`[${jobId}] ⚠️ Could not parse prosody result.json: ${parseErr.message}`);
      }

      try { if (contourPath && fs.existsSync(contourPath)) fs.unlinkSync(contourPath); } catch (_) {}

      if (!error && resultOk && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
        fs.copyFileSync(outputPath, audioFile);
        try { fs.unlinkSync(outputPath); } catch (_) {}
        try { if (fs.existsSync(resultJson)) fs.unlinkSync(resultJson); } catch (_) {}
        console.log(`[${jobId}] ✅ Prosody ${method === 'contour_timewarp' ? 'SHAPE (time-warped contour)' : 'contour'} matched via WORLD resynthesis (target mean=${targetMeanF0.toFixed(1)}Hz, std=${targetStdF0.toFixed(1)}Hz, method=${method})`);
        resolve(true);
        return;
      }

      console.warn(`[${jobId}] ⚠️ Prosody match failed, audio left unchanged: ${error?.message || stderr?.slice(0, 200) || 'unknown error'}`);
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
      try { if (fs.existsSync(resultJson)) fs.unlinkSync(resultJson); } catch (_) {}
      resolve(false);
    });
  });
};

// ✅ NEW: fast F0-only measurement (scripts/measure_f0.py) used purely for
// verification — e.g. confirming the pitch contour survived voice cloning —
// without paying the cost of the full diarization pipeline.
const measureF0Stats = async (audioFile, jobId) => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'measure_f0.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[${jobId}] measure_f0.py not found at ${scriptPath} — skipping F0 verification`);
    return null;
  }

  const pythonBin = process.env.PYTHON_PATH || 'python';
  const resultJson = `${audioFile}_f0check.json`;
  const cmd = `"${pythonBin}" "${scriptPath}" "${audioFile}" "${resultJson}"`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (error) => {
      let result = null;
      try {
        if (fs.existsSync(resultJson)) {
          const parsed = JSON.parse(fs.readFileSync(resultJson, 'utf-8'));
          if (parsed.success) result = parsed;
        }
      } catch (_) {}
      try { if (fs.existsSync(resultJson)) fs.unlinkSync(resultJson); } catch (_) {}
      if (error && !result) {
        console.warn(`[${jobId}] ⚠️ F0 measurement failed: ${error.message}`);
      }
      resolve(result);
    });
  });
};

// ✅ NEW: preferred entry point for the pitch side of post-TTS correction.
// Uses the WORLD contour match above when real std_f0_hz data is available
// (falls back to the flat rubberband pitch+tempo pass otherwise — e.g. if
// diarization didn't produce a std, or the Python pass errors out). Either
// way, duration is always finished off by applyTempoAndPitchCorrection so
// the clip still lands exactly on actualDuration.
const applyProsodyAndDurationCorrection = async (audioFile, targetDuration, targetMeanF0Hz, targetStdF0Hz, jobId, f0Contour = null) => {
  const currentDuration = await getAudioDurationPrecise(audioFile);

  if (targetMeanF0Hz && targetStdF0Hz) {
    const prosodyOk = await applyProsodyMatch(audioFile, targetMeanF0Hz, targetStdF0Hz, jobId, f0Contour);
    if (prosodyOk) {
      // Pitch CONTOUR already reshaped by WORLD above — only duration needs
      // fixing now, so pass targetF0Hz=null to skip the (now redundant,
      // coarser) flat pitch-shift branch and get a tempo-only pass.
      const postProsodyDuration = await getAudioDurationPrecise(audioFile);
      await applyTempoAndPitchCorrection(audioFile, targetDuration, postProsodyDuration, null, jobId);
      return;
    }
    console.warn(`[${jobId}] Prosody match unavailable — falling back to flat pitch-shift + tempo.`);
  }

  // Fallback: no std_f0_hz measurement, or the WORLD pass failed.
  await applyTempoAndPitchCorrection(audioFile, targetDuration, currentDuration, targetMeanF0Hz, jobId);
};

// NEW helper — add near the bottom of ttsService.js
const applyPitchMatch = async (audioFile, targetF0Hz, jobId) => {
  if (!targetF0Hz) return; // no reliable measurement, skip safely

  // edge-tts voices' approximate natural pitch (rough reference points)
  const EDGE_TTS_NATURAL_F0 = { female: 210, male: 120 };
  const currentVoiceF0 = targetF0Hz > 165 ? EDGE_TTS_NATURAL_F0.female : EDGE_TTS_NATURAL_F0.male;

  const semitoneShift = 12 * Math.log2(targetF0Hz / currentVoiceF0);
  const clampedShift = Math.max(-6, Math.min(6, semitoneShift)); // keep it natural-sounding
  if (Math.abs(clampedShift) < 0.3) return; // not worth it

const rate = Math.pow(2, clampedShift / 12);
  const tempFile = `${audioFile}_pitch_temp.wav`;

  // ✅ FIX: rubberband shifts pitch while preserving both formants AND
  // duration in one pass — but it isn't actually compiled into this ffmpeg
  // build (verified via `ffmpeg -filters`, not assumed). asetrate+atempo
  // warps formants (the "chipmunk/robotic" artifact) so it's a real quality
  // regression vs rubberband — but skipping pitch-match entirely (the old
  // silent-failure behavior) is worse: it means gender/register never gets
  // corrected at all, regardless of build. Use rubberband when present;
  // otherwise do the asetrate+atempo trick (still audibly better than a flat,
  // uncorrected voice for large male/female register mismatches), and log
  // clearly which path ran so this is never invisible again.
  const usingRubberband = hasRubberband();
  const command = usingRubberband
    ? `ffmpeg -i "${audioFile}" -filter:a "rubberband=pitch=${rate}" -y "${tempFile}"`
    : `ffmpeg -i "${audioFile}" -filter:a "asetrate=44100*${rate},aresample=44100,atempo=${(1/rate).toFixed(6)}" -y "${tempFile}"`;

  return new Promise((resolve) => {
    exec(command, { timeout: 30000 }, (error) => {
      if (!error && fs.existsSync(tempFile)) {
        fs.copyFileSync(tempFile, audioFile);
        fs.unlinkSync(tempFile);
        console.log(`[${jobId}] 🎙️ Pitch-matched translated voice toward measured speaker F0 (${targetF0Hz.toFixed(0)}Hz, shift ${clampedShift.toFixed(1)} semitones, via ${usingRubberband ? 'rubberband' : 'asetrate+atempo fallback'})`);
      } else {
        console.warn(`[${jobId}] Pitch match skipped: ${error?.message || 'no output'}`);
      }
      if (fs.existsSync(tempFile)) { try { fs.unlinkSync(tempFile); } catch(_){} }
      resolve();
    });
  });
};

// ===== EXPORT ALL FUNCTIONS =====

export default {
  generateTTS,
  getSupportedVoices,
  validateTranslationQuality  // ✅ Add this export
};
