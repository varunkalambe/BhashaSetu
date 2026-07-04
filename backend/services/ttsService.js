// services/ttsService.js - FIXED TTS SEGMENT REPETITION ISSUE

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

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
    
    console.log(`[${jobId}] 🎯 TTS Generation with TARGET LANGUAGE: ${targetLanguage} (${getLanguageName(targetLanguage)})`);
    console.log(`[${jobId}] Text length: ${translation.text.length} characters`);
    console.log(`[${jobId}] Segments: ${translation.segments ? translation.segments.length : 0}`);
    console.log(`[${jobId}] Options provided:`, options);
    
    // ✅ GET VOICE FOR SPECIFIC LANGUAGE
    const voiceConfig = getVoiceForLanguage(targetLanguage);
    
    if (!voiceConfig) {
      console.warn(`[${jobId}] No direct voice available for language: ${targetLanguage}`);
      
      // Try to find compatible fallback
      const fallbackLanguage = findCompatibleVoiceFallback(targetLanguage);
      if (fallbackLanguage) {
        console.log(`[${jobId}] Using fallback language: ${fallbackLanguage} for ${targetLanguage}`);
        const fallbackVoice = getVoiceForLanguage(fallbackLanguage);
        
        if (fallbackVoice) {
          return await generateTTSWithVoice(translation, jobId, fallbackVoice, targetLanguage, options);
        }
      }
      
      throw new Error(`No TTS voice available for language: ${targetLanguage}`);
    }
    
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
    if (translation.segments && translation.segments.length > 0) {
      console.log(`[${jobId}] Using segment-based TTS generation...`);
      return await generateSegmentBasedTTS(translation, voiceConfig, audioFilePath, jobId, actualDuration, targetLanguage);
    } else {
      console.log(`[${jobId}] Using full-text TTS generation...`);
      return await generateFullTextTTS(translation, voiceConfig, audioFilePath, jobId, actualDuration, targetLanguage);
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


// ===== CRITICAL FIX: SEGMENT-BASED TTS GENERATION WITH VALIDATION =====
const generateSegmentBasedTTS = async (translation, voiceConfig, outputPath, jobId, actualDuration, targetLanguage) => {
  console.log(`[${jobId}] Starting segment-based TTS generation...`);
  
  const tempDir = './uploads/temp_audio';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const segmentAudioFiles = [];
  
  try {
    let segmentsToProcess = translation.segments || [];
    console.log(`[${jobId}] Processing ${segmentsToProcess.length} segments...`);

    // ✅ FIX #1: VALIDATE TRANSLATION QUALITY BEFORE TTS GENERATION
    console.log(`[${jobId}] Validating translation quality before TTS...`);
    
    try {
      await validateTranslationQuality(segmentsToProcess, targetLanguage, jobId);
    } catch (validationError) {
      console.error(`[${jobId}] Translation validation failed: ${validationError.message}`);
      throw validationError; // Stop processing if validation fails
    }

    // ✅ FIX #2: CHECK FOR IDENTICAL CONTENT AND THROW ERROR (Don't mask the problem)
    const uniqueSegmentTexts = new Set(segmentsToProcess.map(s => (s.text || '').trim()));
    
    if (uniqueSegmentTexts.size === 1 && segmentsToProcess.length > 1) {
        console.error(`[${jobId}] TRANSLATION FAILURE: All segments identical`);
        
        // ✅ THROW ERROR - Don't mask the problem with artificial content
        throw new Error(
            `Translation failed: All ${segmentsToProcess.length} segments contain ` +
            `identical text: "${[...uniqueSegmentTexts][0].substring(0, 100)}...". ` +
            `This indicates the translation service failed. Please retry.`
        );
    }
    
    console.log(`[${jobId}] ✅ Translation validation passed - ${uniqueSegmentTexts.size} unique segments`);
    
    const segmentTimings = prepareSegmentTimings(segmentsToProcess, actualDuration, jobId);
    
    // Generate audio for each segment
    for (let i = 0; i < segmentTimings.length; i++) {
      const segmentTiming = segmentTimings[i];
      const segment = segmentsToProcess[i];
      
      console.log(`[${jobId}] Processing segment ${i + 1}/${segmentTimings.length}: ${segmentTiming.start.toFixed(2)}s - ${segmentTiming.end.toFixed(2)}s`);
      
      if (!segment.text || segment.text.trim().length === 0) {
        const silenceFile = path.join(tempDir, `${jobId}_segment_${i}_silence.wav`);
        await createPrecisionSilence(silenceFile, segmentTiming.duration);
        segmentAudioFiles.push({ file: silenceFile, isSilence: true });
        continue;
      }
      
      const segmentFile = path.join(tempDir, `${jobId}_segment_${i}.wav`);
      
      try {
        const segmentText = segment.text.trim();
        console.log(`[${jobId}] Generating TTS for segment ${i + 1} (${targetLanguage}): "${segmentText.substring(0, 50)}..."`);
        
        await generateTTSForSegment(segmentText, voiceConfig, segmentFile, segmentTiming, jobId, i + 1, targetLanguage);
        
        const generatedDuration = await getAudioDurationPrecise(segmentFile);
        const durationError = Math.abs(generatedDuration - segmentTiming.duration);
        
        if (durationError > 0.1) {
          console.log(`[${jobId}] Adjusting segment ${i + 1} duration: ${generatedDuration.toFixed(3)}s → ${segmentTiming.duration.toFixed(3)}s`);
          await applyDurationAdjustment(segmentFile, segmentTiming.duration, generatedDuration, jobId);
        }
        
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
    
    const finalDuration = await getAudioDurationPrecise(outputPath);
    const accuracyPercentage = ((actualDuration - Math.abs(finalDuration - actualDuration)) / actualDuration) * 100;
    
    console.log(`[${jobId}] ✅ Segment-based TTS completed:`);
    console.log(`[${jobId}]   Target: ${actualDuration.toFixed(3)}s`);
    console.log(`[${jobId}]   Generated: ${finalDuration.toFixed(3)}s`);
    console.log(`[${jobId}]   Accuracy: ${accuracyPercentage.toFixed(1)}%`);
    
    await cleanupTempFiles(segmentAudioFiles, tempDir, jobId);
    return outputPath;
    
  } catch (error) {
    console.error(`[${jobId}] Segment-based TTS failed:`, error.message);
    await cleanupTempFiles(segmentAudioFiles, tempDir, jobId);
    throw error;
  }
};




// ===== FULL-TEXT TTS GENERATION =====
const generateFullTextTTS = async (translation, voiceConfig, outputPath, jobId, actualDuration, targetLanguage) => {
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
  
  // Calculate optimal speech rate
  const speechRate = calculateOptimalSpeechRate(textToConvert, actualDuration, targetLanguage);
  
  console.log(`[${jobId}] Full-text TTS configuration:`);
  console.log(`[${jobId}]   Text length: ${textToConvert.length} characters`);
  console.log(`[${jobId}]   Target duration: ${actualDuration.toFixed(2)}s`);
  console.log(`[${jobId}]   Speech rate: ${speechRate}`);
  console.log(`[${jobId}]   Language: ${targetLanguage}`);
  
  try {
    // Generate TTS
    await executeTTSCommand(textToConvert, voiceConfig.voice, outputPath, speechRate, jobId, targetLanguage);
    
    // Adjust duration if needed
    const generatedDuration = await getAudioDurationPrecise(outputPath);
    const durationError = Math.abs(generatedDuration - actualDuration);
    
    if (durationError > 0.5) { // 500ms tolerance for full text
      console.log(`[${jobId}] Adjusting full-text duration: ${generatedDuration.toFixed(2)}s → ${actualDuration.toFixed(2)}s`);
      await applyDurationAdjustment(outputPath, actualDuration, generatedDuration, jobId);
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
const generateTTSForSegment = async (text, voiceConfig, outputPath, timing, jobId, segmentNumber, targetLanguage) => {
  const cleanText = text.replace(/[""]/g, '"').replace(/['']/g, "'").trim();
  
  if (cleanText.length === 0) {
    throw new Error('Empty text after cleaning');
  }
  
  const rateParam = timing.speechRate || '+0%';
  
  console.log(`[${jobId}] Generating TTS for segment ${segmentNumber} (${targetLanguage}): "${cleanText.substring(0, 30)}..."`);
  
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
};

// Execute TTS command using edge-tts
const executeTTSCommand = async (text, voice, outputPath, rateParam, jobId, targetLanguage) => {
  return new Promise((resolve, reject) => {
    const cleanText = text.replace(/"/g, '\\"').trim();
    const edgeTTSCommand = `edge-tts --voice "${voice}" --text "${cleanText}" --rate="${rateParam}" --write-media "${outputPath}"`;
    
    console.log(`[${jobId}] Executing TTS command for ${targetLanguage}: ${text.length} chars, rate: ${rateParam}`);
    
    exec(edgeTTSCommand, {
      maxBuffer: 1024 * 1024 * 50, // 50MB buffer
      timeout: 120000 // 2 minutes
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.message.includes('command not found')) {
          reject(new Error('Edge-TTS not installed. Install with: pip install edge-tts'));
        } else if (error.message.includes('timeout')) {
          reject(new Error('TTS generation timeout. Text may be too complex.'));
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
};

// In file: ttsService.js
// Replace the entire 'prepareSegmentTimings' function with this complete version.

const prepareSegmentTimings = (segments, totalDuration, jobId) => {
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

        const speechRate = calculateSpeechRateForSegment(segment.text, duration);

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

// Calculate optimal speech rate for full text
const calculateOptimalSpeechRate = (text, duration, language) => {
  if (!text || duration <= 0) return '+0%';
  
  const wordsPerMinute = (text.split(' ').length / duration) * 60;
  
  // Language-specific adjustments
  const languageFactors = {
    'hi': 1.0,
    'bn': 1.1,
    'ta': 0.9,
    'te': 0.9,
    'mr': 1.0,
    'gu': 1.0,
    'kn': 0.9,
    'ml': 0.9,
    'pa': 1.0,
    'ur': 1.0,
    'en': 1.2
  };
  
  const factor = languageFactors[language] || 1.0;
  const adjustedWPM = wordsPerMinute * factor;
  
  if (adjustedWPM > 200) return '-30%';
  if (adjustedWPM > 180) return '-20%';
  if (adjustedWPM > 160) return '-10%';
  if (adjustedWPM < 90) return '+20%';
  if (adjustedWPM < 110) return '+10%';
  
  return '+0%';
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
const applyDurationAdjustment = async (audioFile, targetDuration, currentDuration, jobId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const speedRatio = currentDuration / targetDuration;
      const clampedRatio = Math.max(0.5, Math.min(2.0, speedRatio));
      
      if (Math.abs(speedRatio - 1) < 0.02) {
        resolve();
        return;
      }
      
      const tempFile = `${audioFile}_temp_adjust.wav`;
      const command = `ffmpeg -i "${audioFile}" -filter:a "atempo=${clampedRatio}" -y "${tempFile}"`;
      
      exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          console.warn(`[${jobId}] Duration adjustment failed:`, error.message);
          resolve(); // Don't fail entire process
          return;
        }
        
        try {
          if (fs.existsSync(tempFile)) {
            fs.copyFileSync(tempFile, audioFile);
            fs.unlinkSync(tempFile);
          }
          resolve();
        } catch (fileError) {
          console.warn(`[${jobId}] File operation failed:`, fileError.message);
          resolve();
        }
      });
      
    } catch (error) {
      console.warn(`[${jobId}] Duration adjustment setup failed:`, error.message);
      resolve();
    }
  });
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
    'hi': {
      voice: 'hi-IN-SwaraNeural',
      alternative: 'hi-IN-MadhurNeural',
      name: 'Hindi',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    },
    'bn': {
      voice: 'bn-IN-BashkarNeural',
      alternative: 'bn-IN-TanishaaNeural',
      name: 'Bengali',
      quality: 'excellent',
      gender: 'male',
      region: 'India/Bangladesh'
    },
    'te': {
      voice: 'te-IN-ShrutiNeural',
      alternative: 'te-IN-MohanNeural',
      name: 'Telugu',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    },
    'ta': {
      voice: 'ta-IN-PallaviNeural',
      alternative: 'ta-IN-ValluvarNeural',
      name: 'Tamil',
      quality: 'excellent',
      gender: 'female',
      region: 'India/Sri Lanka'
    },
    'mr': {
      voice: 'mr-IN-AarohiNeural',
      alternative: 'mr-IN-ManoharNeural',
      name: 'Marathi',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    },
    'gu': {
      voice: 'gu-IN-DhwaniNeural',
      alternative: 'gu-IN-NiranjanNeural',
      name: 'Gujarati',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    },
    'kn': {
      voice: 'kn-IN-SapnaNeural',
      alternative: 'kn-IN-GaganNeural',
      name: 'Kannada',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    },
    'ml': {
      voice: 'ml-IN-SobhanaNeural',
      alternative: 'ml-IN-MidhunNeural',
      name: 'Malayalam',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    },
    'pa': {
      voice: 'pa-IN-GaganNeural',
      alternative: 'pa-IN-HarpreetNeural',
      name: 'Punjabi',
      quality: 'good',
      gender: 'male',
      region: 'India/Pakistan'
    },
    'ur': {
      voice: 'ur-PK-AsadNeural',
      alternative: 'ur-PK-UzmaNeural',
      name: 'Urdu',
      quality: 'good',
      gender: 'male',
      region: 'Pakistan/India'
    },
    'en': {
      voice: 'en-IN-NeerjaNeural',
      alternative: 'en-IN-PrabhatNeural',
      name: 'English (India)',
      quality: 'excellent',
      gender: 'female',
      region: 'India'
    }
  };
};

// ===== EXPORT ALL FUNCTIONS =====

export default {
  generateTTS,
  getSupportedVoices,
  validateTranslationQuality  // ✅ Add this export
};
