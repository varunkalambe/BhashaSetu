import dotenv from 'dotenv';
import https from 'https';
import fs from 'fs';
import path from 'path';
// AFTER
import { translateWithIndicTrans2, translateMultipleWithIndicTrans2 } from './enhancedPipelineService.js';



// ===== CRITICAL FIX: PROPER GOOGLE TRANSLATE IMPORT =====
// ===== CRITICAL FIX: PROPER GOOGLE TRANSLATE IMPORT =====
let translate = null;
let googleTranslateAvailable = false;

try {
  // Try the current import first
  const googleTranslate = await import('@vitalets/google-translate-api');
  translate = googleTranslate.default;
  googleTranslateAvailable = true;
  console.log('✅ Google Translate API loaded successfully');
} catch (importError) {
  console.warn('⚠️ Google Translate API import failed:', importError.message);
  console.warn('⚠️ Google Translate will be unavailable. Only LibreTranslate will be used.');
  translate = null;
  googleTranslateAvailable = false;
}


// RATE LIMITING TRACKERS
let dailyGoogleTranslations = 0;
let lastResetDate = new Date().toDateString();
let googleBlocked = false;
let blockUntil = null;

import { validateTranslationQuality } from './validationService.js';


const translateWithOpenAI = async (text, sourceLang, targetLang, jobId) => {
  console.log(`[${jobId}] Using OpenAI for translation...`);

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured');
    }

    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the following text from ${sourceLang} to ${targetLang}. Return only the translated text, nothing else.`
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.3,
    });

    const translatedText = completion.choices[0].message.content.trim();

    return {
      text: translatedText,
      sourceLang: sourceLang,
      targetLang: targetLang,
      engine: 'openai-gpt',
      success: true
    };

  } catch (error) {
    console.error(`[${jobId}] OpenAI translation failed: ${error.message}`);
    throw error;
  }
};



const translateWithMyMemory = async (text, sourceLang, targetLang, jobId = 'unknown') => {
  console.log(`[${jobId}] Using MyMemory API for translation to ${targetLang}...`);
console.log(`[${jobId}] Text to translate (first 100 chars): ${text.substring(0, 100)}...`);


  try {
    // ✅ ADD YOUR EMAIL HERE to get 50k chars/day instead of 5k
    const userEmail = "varunkalambe4294@gmail.com";  // Change this!

    const fullUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}&de=${userEmail}`;

    const fullResponse = await fetch(fullUrl);
    const fullData = await fullResponse.json();

    if (fullData.responseStatus !== 200) {
      throw new Error(`MyMemory API error: ${fullData.responseDetails || 'Unknown error'}`);
    }

    const translatedText = fullData.responseData.translatedText;
    console.log(`[${jobId}] ✅ MyMemory translation successful`);

    return {
      text: translatedText,
      language: targetLang,
      sourceLang: sourceLang,
      targetLang: targetLang,
      engine: 'mymemory',
      success: true
    };

  } catch (error) {
    throw new Error(`MyMemory API Error: ${error.message}`);
  }
};



const validateTranslationScript = (text, targetLang, jobId) => {
  // Script detection regex patterns
  const scripts = {
    arabic: /[\u0600-\u06FF\u0750-\u077F]/,
    devanagari: /[\u0900-\u097F]/,
    gujarati: /[\u0A80-\u0AFF]/,
    kannada: /[\u0C80-\u0CFF]/,
    telugu: /[\u0C00-\u0C7F]/,
    tamil: /[\u0B80-\u0BFF]/,
    bengali: /[\u0980-\u09FF]/,
    malayalam: /[\u0D00-\u0D7F]/,
    latin: /[a-zA-Z]/
  };

  // Expected scripts for each language
  const expectedScripts = {
    'hi': ['devanagari', 'latin'],
    'gu': ['gujarati', 'latin'],
    'kn': ['kannada', 'latin'],
    'te': ['telugu', 'latin'],
    'ta': ['tamil', 'latin'],
    'bn': ['bengali', 'latin'],
    'ml': ['malayalam', 'latin'],
    'mr': ['devanagari', 'latin'],
    'ur': ['arabic', 'latin'],
    'en': ['latin']
  };

  // Detect which scripts are present
  const detectedScripts = [];
  for (const [scriptName, regex] of Object.entries(scripts)) {
    if (regex.test(text)) {
      detectedScripts.push(scriptName);
    }
  }

  const acceptable = expectedScripts[targetLang] || ['latin'];

  // Check for mixed scripts (more than 2 = problematic)
  if (detectedScripts.length > 2) {
    console.warn(`[${jobId}] ❌ Mixed scripts: ${detectedScripts.join(', ')}`);
    return {
      isValid: false,
      reason: `Mixed scripts: ${detectedScripts.join(', ')}`
    };
  }

  // Check if main script matches expected
  const hasExpectedScript = acceptable.some(script => detectedScripts.includes(script));

  if (!hasExpectedScript && detectedScripts.length > 0) {
    console.warn(`[${jobId}] ❌ Wrong script: Expected ${acceptable.join('/')}, got ${detectedScripts[0]}`);
    return {
      isValid: false,
      reason: `Wrong script: Expected ${acceptable.join('/')}, got ${detectedScripts[0]}`
    };
  }

  console.log(`[${jobId}] ✅ Translation validated: ${detectedScripts.join(', ')}`);

  return {
    isValid: true,
    reason: 'Translation valid'
  };
};




const translateWithGoogleTranslate = async (text, sourceLang, targetLang, jobId) => {
  console.log(`[${jobId}] Using Google Translate fallback...`);

  try {
    // Fallback to free public API
    const https = await import('https');
    const querystring = await import('querystring');

    const params = querystring.stringify({
      client: 'gtx',
      sl: sourceLang,
      tl: targetLang,
      dt: 't',
      q: text
    });

    const url = `https://translate.googleapis.com/translate_a/single?${params}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const translatedText = parsed[0].map(item => item[0]).join('');

            resolve({
              text: translatedText,
              sourceLang: sourceLang,
              targetLang: targetLang,
              engine: 'google-translate-free',
              success: true
            });
          } catch (parseError) {
            reject(new Error('Google Translate parsing failed'));
          }
        });
      }).on('error', reject);
    });

  } catch (error) {
    console.error(`[${jobId}] Google Translate failed: ${error.message}`);
    throw error;
  }
};


// ===== MAIN TRANSLATION FUNCTION - WITH REAL MULTI-ENGINE FALLBACK CHAIN =====
// ✅ FIX: Every engine below is now actually reachable. Previously "PRIORITY 3" called
// translateWithMyMemory a second time with its arguments in the wrong order (jobId was
// being passed in as the text to translate), so Google Translate was never really invoked
// as a fallback. translateWithOpenAI and translateWithGoogleTranslate were fully implemented
// but dead (never called) - they are now wired into the real pipeline as genuine fallback
// tiers instead of being unreachable dead code.
export const translateText = async (text, sourceLang, targetLang, jobId = 'unknown') => {
  console.log(`[${jobId}] Starting translation: ${sourceLang} → ${targetLang}`);

  // Validate distinct languages
  if (sourceLang === targetLang) {
    console.log(`[${jobId}] Skipping translation: same language (${sourceLang})`);
    return {
      text: text,
      language: targetLang,
      sourceLang: sourceLang,
      targetLang: targetLang,
      engine: 'none',
      success: true
    };
  }

  const attemptedEngines = [];

  // ✅ NEW: Actually GATE on the COMET-Kiwi / LaBSE quality-estimation score instead of
  // only logging it. Previously `qe_score` was computed and printed but never influenced
  // whether the IndicTrans2 result was accepted — a badly-scored translation and a
  // perfectly-scored one were treated identically. Threshold is deliberately soft: below
  // it, we don't discard the result, we just give higher-priority engines a chance first
  // and keep this one as a safety net (see the end of the function) so a low score never
  // turns into a hard job failure when it's the only translation we managed to produce.
  const MIN_QE_SCORE = parseFloat(process.env.INDICTRANS2_MIN_QE_SCORE || '0.5');
  let bestFallbackCandidate = null;

  // ===== PRIORITY 0: INDICTRANS2 (LOCAL, FREE, NO API KEY, HIGH QUALITY) =====
  attemptedEngines.push('indictrans2');
  try {
    console.log(`[${jobId}] Attempting local IndicTrans2 translation...`);
    const result = await translateWithIndicTrans2(text, sourceLang, targetLang, jobId);
    if (result && result.text) {
      if (!verifyProperScript(result.text, targetLang)) {
        console.warn(`[${jobId}] ⚠️ IndicTrans2 output may be romanized, falling back`);
      } else if (result.qe_score != null && result.qe_score < MIN_QE_SCORE) {
        console.warn(`[${jobId}] ⚠️ IndicTrans2 QE score ${result.qe_score.toFixed(3)} (via ${result.qe_method}) is below the ${MIN_QE_SCORE} threshold — trying a higher-priority engine before accepting it`);
        bestFallbackCandidate = result; // keep as a safety net, don't discard it yet
      } else {
        const qeLabel = result.qe_score != null
          ? `QE=${result.qe_score.toFixed(3)} via ${result.qe_method}`
          : 'QE unavailable, accepting on script validity alone';
        console.log(`[${jobId}] ✅ IndicTrans2 translation accepted (${qeLabel})`);
        return result;
      }
    }
  } catch (indicError) {
    console.warn(`[${jobId}] IndicTrans2 translation failed: ${indicError.message}`);
  }

  // ===== PRIORITY 1: OPENAI (HIGHEST QUALITY, ONLY IF CONFIGURED) =====
// AFTER
const hasRealOpenAIKey = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('sk-');
if (hasRealOpenAIKey) {
    attemptedEngines.push('openai');
    try {
      console.log(`[${jobId}] Attempting OpenAI translation...`);
      const result = await translateWithOpenAI(text, sourceLang, targetLang, jobId);

      if (result && result.text) {
        console.log(`[${jobId}] ✅ OpenAI translation successful`);
        if (!verifyProperScript(result.text, targetLang)) {
          console.warn(`[${jobId}] ⚠️ Translation may be romanized, not proper script`);
        }
        return result;
      }
    } catch (openaiError) {
      console.warn(`[${jobId}] OpenAI translation failed: ${openaiError.message}`);
    }
  } else {
    console.log(`[${jobId}] Skipping OpenAI (OPENAI_API_KEY not configured)`);
  }

  // ===== PRIORITY 2: MYMEMORY API (PRIMARY FREE FALLBACK) =====
  attemptedEngines.push('mymemory');
  try {
    console.log(`[${jobId}] Attempting MyMemory API translation...`);
    const result = await translateWithMyMemory(text, sourceLang, targetLang, jobId);

    if (result && result.text) {
      console.log(`[${jobId}] ✅ MyMemory translation successful`);
      if (!verifyProperScript(result.text, targetLang)) {
        console.warn(`[${jobId}] ⚠️ Translation may be romanized, not proper script`);
      }
      return result;
    }
  } catch (myMemoryError) {
    console.warn(`[${jobId}] MyMemory translation failed: ${myMemoryError.message}`);
  }

  // ===== PRIORITY 3: GOOGLE TRANSLATE (LAST RESORT) =====
  // ✅ FIX: Calls the correct function (translateWithGoogleTranslate, not translateWithMyMemory
  // again) with arguments in the correct order matching its signature
  // (text, sourceLang, targetLang, jobId).
  attemptedEngines.push('google-translate');
  try {
    console.log(`[${jobId}] Attempting Google Translate...`);
    const result = await translateWithGoogleTranslate(text, sourceLang, targetLang, jobId);

    if (result && result.text) {
      console.log(`[${jobId}] ✅ Google Translate successful`);
      if (!verifyProperScript(result.text, targetLang)) {
        console.warn(`[${jobId}] ⚠️ Translation may be romanized, not proper script`);
      }
      return result;
    }
  } catch (googleError) {
    console.warn(`[${jobId}] Google Translate failed: ${googleError.message}`);
  }

  // ✅ NEW: If every higher-priority engine failed or was unconfigured, don't throw away
  // the one translation we do have just because its QE score was mediocre — a below-
  // threshold translation is still far better than no dubbed audio at all. Callers that
  // care can check `qe_below_threshold` on the returned object (e.g. to flag the job for
  // manual review) without the pipeline hard-failing over it.
  if (bestFallbackCandidate) {
    console.warn(`[${jobId}] ⚠️ All higher-priority engines failed or were unavailable — using the below-threshold IndicTrans2 result instead of failing the job (QE=${bestFallbackCandidate.qe_score.toFixed(3)} via ${bestFallbackCandidate.qe_method}, threshold=${MIN_QE_SCORE})`);
    return { ...bestFallbackCandidate, qe_below_threshold: true };
  }

  // All services failed - throw a clear, descriptive error instead of silently
  // returning something the caller might mistake for a real translation.
  throw new Error(`All translation services failed for ${sourceLang} → ${targetLang}. Tried: ${attemptedEngines.join(', ')}.`);
};

function verifyProperScript(text, targetLanguage) {
  const scriptRanges = {
    'hi': /[\u0900-\u097F]/, // Devanagari
    'gu': /[\u0A80-\u0AFF]/, // Gujarati
    'ta': /[\u0B80-\u0BFF]/, // Tamil
    'te': /[\u0C00-\u0C7F]/, // Telugu
    'kn': /[\u0C80-\u0CFF]/, // Kannada
    'ml': /[\u0D00-\u0D7F]/, // Malayalam
    'bn': /[\u0980-\u09FF]/, // Bengali
    'pa': /[\u0A00-\u0A7F]/, // Gurmukhi (Punjabi)
    'mr': /[\u0900-\u097F]/, // Devanagari (Marathi)
    'or': /[\u0B00-\u0B7F]/, // Oriya
    'ur': /[\u0600-\u06FF]/  // Arabic script (Urdu)
  };

  const scriptPattern = scriptRanges[targetLanguage];
  if (!scriptPattern) return true; // Unknown language, skip check

  return scriptPattern.test(text);
}



// ===== GOOGLE TRANSLATE FALLBACK WITH FIXED IMPORT - CRITICAL FIX =====
const translateWithGoogleFixed = async (transcription, targetLanguage, originalDuration, jobId) => {
  // Reset daily counter and check for blocks
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyGoogleTranslations = 0;
    lastResetDate = today;
    googleBlocked = false;
    blockUntil = null;
  }
  if (googleBlocked && blockUntil && new Date() < blockUntil) {
    throw new Error(`Google Translate is temporarily blocked due to rate limits. Try again after ${blockUntil.toLocaleTimeString()}`);
  }
  if (dailyGoogleTranslations >= 25) {
    throw new Error('Google Translate daily usage limit has been reached (25 calls).');
  }

  // ✅ CRITICAL FIX: This definitively checks if 'translate' is a callable function.
  // This is the most important part of the fix to prevent "translate is not a function".
  if (!googleTranslateAvailable || typeof translate !== 'function') {
    throw new Error('Google Translate API is not available or failed to load correctly. Ensure @vitalets/google-translate-api is installed.');
  }

  console.log(`[${jobId}] Using Google Translate fallback (${dailyGoogleTranslations}/25 used today)...`);

  const sourceLanguage = 'hi';
  let detectedSourceLanguage = sourceLanguage;

  try {
    // ===== TRANSLATE FULL TEXT (NOW SAFE) =====
    console.log(`[${jobId}] Translating full text with Google to ${targetLanguage}...`);
    const fullResult = await translate(transcription.text, {
      from: sourceLanguage,
      to: targetLanguage,
      fetchOptions: { timeout: 10000 }, // 10 second timeout
      agent: null  // ✅ ADD THIS LINE
    });

    const fullTextTranslation = fullResult.text;
    console.log(`[${jobId}] ✅ Google full text translation successful`);

    if (fullResult.from?.language?.iso) {
      detectedSourceLanguage = fullResult.from.language.iso;
    }
    dailyGoogleTranslations++;

    // ===== TRANSLATE SEGMENTS (NOW SAFE) =====
    const translatedSegments = [];
    let successfulSegments = 0;
    const segments = transcription.segments || [];

    for (const segment of segments) {
      // Use original text for empty segments
      if (!segment.text || segment.text.trim().length === 0) {
        translatedSegments.push({ ...segment, text: '', originaltext: segment.text || '' });
        continue;
      }

      // Respect the daily limit
      if (dailyGoogleTranslations < 25) {
        try {
          const segmentResult = await translate(segment.text.trim(), {
            from: detectedSourceLanguage,
            to: targetLanguage,
            fetchOptions: { timeout: 8000 },
            agent: null  // ✅ ADD THIS LINE
          });

          translatedSegments.push({ ...segment, text: segmentResult.text, originaltext: segment.text });
          successfulSegments++;
          dailyGoogleTranslations++;
          await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit delay
        } catch (segmentError) {
          console.warn(`[${jobId}] Google segment translation failed: ${segmentError.message}`);
          if (segmentError.message.includes('Too Many Requests') || segmentError.message.includes('429')) {
            googleBlocked = true;
            blockUntil = new Date(Date.now() + 6 * 60 * 60 * 1000); // Block for 6 hours
            console.error(`[${jobId}] Google Translate rate limit hit. Blocking until ${blockUntil.toLocaleTimeString()}`);
            break; // Stop processing more segments
          }
          // On other errors, keep original text for this segment
          translatedSegments.push({ ...segment, text: segment.text, originaltext: segment.text, translationerror: true });
        }
      } else {
        // If limit is hit, fill remaining segments with original text
        translatedSegments.push({ ...segment, text: segment.text, originaltext: segment.text, translationerror: true });
      }
    }

    // Finalize and return the result object
    const supportedLanguages = getSupportedIndianLanguages();
    return {
      text: fullTextTranslation,
      language: targetLanguage,
      languagename: supportedLanguages[targetLanguage],
      originallanguage: detectedSourceLanguage,
      originallanguagename: supportedLanguages[detectedSourceLanguage] || detectedSourceLanguage,
      confidence: 0.95,
      segments: translatedSegments,
      translationservice: 'google-translate-fixed',
      translationneeded: true,
      translationquality: successfulSegments / Math.max(segments.length, 1),
      originalduration: originalDuration,
      userselectedlanguage: targetLanguage,
    };

  } catch (error) {
    // Catch errors from the main full-text call, especially rate limiting
    if (error.message.includes('Too Many Requests') || error.message.includes('429')) {
      googleBlocked = true;
      blockUntil = new Date(Date.now() + 6 * 60 * 60 * 1000);
      console.error(`[${jobId}] Google Translate rate limit hit. Blocking until ${blockUntil.toLocaleTimeString()}`);
    }
    throw new Error(`Google Translate Fixed Error: ${error.message}`);
  }
};




// ===== ✅ NEW: SEGMENT-AWARE TRANSLATION =====
// Root cause this closes: processController.js used to call
// `translateText(transcription.text, ...)` — passing only the flattened
// full-text string — so `transcription.segments` (Whisper's own sentence-
// level start/end timing, already extracted in PIPELINE STEP 3/7) was
// silently discarded before translation ever ran. That's why
// `translation.segments` was always empty for every engine (IndicTrans2 /
// Google / MyMemory all just returned a flat {text} object back), which in
// turn meant the entire segment-aware TTS architecture already written in
// ttsService.js (generateSegmentBasedTTS, resolveVoiceForSegment,
// buildPerSpeakerRegisterMap, per-segment targetF0Hz) was dead code — every
// real job took the full-text branch with one flat, job-level pitch/loudness
// target for the whole clip.
//
// This translates each Whisper segment individually (reusing the exact same
// multi-engine fallback chain as translateText, just called once per
// segment) and reassembles a real `segments` array with per-segment timing
// preserved, so the segment-aware pipeline actually activates.
// AFTER
export const translateSegments = async (transcription, sourceLang, targetLang, jobId = 'unknown') => {
  const sourceSegments = transcription.segments || [];

  if (sourceSegments.length === 0) {
    const fullResult = await translateText(transcription.text, sourceLang, targetLang, jobId);
    console.log(`[${jobId}] No transcription segments available — returning flat translation (segments stay empty).`);
    return fullResult;
  }

  // ✅ IMPROVED: previously this called translateText once for the full text
  // AND once per segment — each call spawning a fresh Python process that
  // reloaded the IndicTrans2 model from scratch (~15-19s every time; 5 loads
  // for a 4-segment job, 60-95s of pure overhead on a real run). Try ALL of
  // them (full text + every segment) through ONE batched IndicTrans2 call
  // first; only items that fail validation there fall back to the full
  // multi-engine chain (translateText), exactly as before.
  const segmentTexts = sourceSegments.map(s => (s.text || '').trim());
  const allTexts = [transcription.text, ...segmentTexts];

  console.log(`[${jobId}] Attempting batched IndicTrans2 translation for full text + ${sourceSegments.length} segment(s)...`);

  let batchResults = null;
  try {
    batchResults = await translateMultipleWithIndicTrans2(allTexts, sourceLang, targetLang, jobId);
  } catch (batchError) {
    console.warn(`[${jobId}] Batched IndicTrans2 translation failed entirely (${batchError.message}) — falling back to per-item translation.`);
  }

  const MIN_QE_SCORE = parseFloat(process.env.INDICTRANS2_MIN_QE_SCORE || '0.5');
  const resolveItem = async (text, label, index) => {
    const batchItem = batchResults ? batchResults[index] : null;
    const scriptOk = batchItem && verifyProperScript(batchItem.text, targetLang);
    const qeOk = batchItem && (batchItem.qe_score == null || batchItem.qe_score >= MIN_QE_SCORE);
    if (batchItem && scriptOk && qeOk) return batchItem;

    console.log(`[${jobId}] ${label} needs the full fallback chain (batch result ${batchItem ? 'below quality threshold' : 'unavailable'})`);
    return translateText(text, sourceLang, targetLang, `${jobId}_${label}`);
  };

  const fullResult = await resolveItem(transcription.text, 'fulltext', 0);

  console.log(`[${jobId}] Resolving ${sourceSegments.length} segment(s)...`);
  const translatedSegments = [];
  for (let i = 0; i < sourceSegments.length; i++) {
    const segment = sourceSegments[i];
    const segmentText = segmentTexts[i];

    if (!segmentText) {
      translatedSegments.push({ ...segment, text: '', originaltext: segment.text || '' });
      continue;
    }

    try {
      const segResult = await resolveItem(segmentText, `seg${i}`, i + 1);
      translatedSegments.push({
        ...segment,
        text: segResult.text,
        originaltext: segment.text,
        engine: segResult.engine || fullResult.engine,
      });
    } catch (segError) {
      console.warn(`[${jobId}] Segment ${i + 1}/${sourceSegments.length} translation failed, keeping original text: ${segError.message}`);
      translatedSegments.push({ ...segment, text: segment.text, originaltext: segment.text, translationerror: true });
    }
  }

  console.log(`[${jobId}] ✅ Built ${translatedSegments.length} translated segment(s) with preserved timing.`);

  return {
    ...fullResult,
    segments: translatedSegments,
  };
};
// ===== SKIPPED TRANSLATION (SAME LANGUAGE) =====
const createSkippedTranslation = async (transcription, sourceLanguage, targetLanguage, jobId) => {
  console.log(`[${jobId}] Creating skipped translation (same language: ${targetLanguage})`);

  const supportedLanguages = getSupportedIndianLanguages();

  const translation = {
    text: transcription.text,
    language: targetLanguage,  // ✅ USE USER-SELECTED TARGET LANGUAGE
    languagename: supportedLanguages[targetLanguage],
    originallanguage: sourceLanguage,
    originallanguagename: supportedLanguages[sourceLanguage] || sourceLanguage,
    confidence: transcription.confidence || 0.95,
    segments: transcription.segments || [],
    translationservice: 'translation-skipped',
    translationneeded: false,
    totalsegments: transcription.segments ? transcription.segments.length : 0,
    successfulsegments: transcription.segments ? transcription.segments.length : 0,
    failedsegments: 0,
    translationquality: 1.0,
    originalduration: transcription.duration || 0,
    translatedduration: transcription.duration || 0,
    durationpreserved: true,
    userselectedlanguage: targetLanguage,  // ✅ TRACK USER SELECTION
    languageoveridden: false
  };

  return translation;
};

// ===== CRITICAL FIX: THROW ERROR ON TRANSLATION FAILURE INSTEAD OF CREATING FALLBACK CONTENT =====
const createMeaningfulFallbackTranslation = async (transcription, sourceLanguage, targetLanguage, originalDuration, jobId, reason) => {
  console.error(`[${jobId}] CRITICAL: All translation services failed - ${reason}`);
  console.error(`[${jobId}] Halting process to prevent generation of invalid content.`);

  // ✅ FIX: Throw a clear, descriptive error to stop the entire processing pipeline.
  // This prevents the TTS and video assembly steps from running with incorrect, repetitive text.
  throw new Error(`Translation failed: ${reason}. Cannot proceed with invalid content. Please check primary API key configuration or retry the job.`);
};

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

// ===== SAVE TRANSLATION TO FILESYSTEM =====
const saveTranslationToFilesystem = async (translation, jobId) => {
  try {
    const translationsDir = './uploads/translations';
    if (!fs.existsSync(translationsDir)) {
      fs.mkdirSync(translationsDir, { recursive: true });
    }

    const translationFile = path.join(translationsDir, `${jobId}_translation.json`);

    const translationData = {
      jobId: jobId,
      timestamp: new Date().toISOString(),
      translation: translation,
      serviceused: translation.translationservice,
      success: true,
      durationpreserved: translation.durationpreserved,
      userselectedlanguage: translation.userselectedlanguage,
      languageoveridden: translation.languageoveridden || false,
      fallbackused: translation.fallbackused || false,
      uniquecontentcreated: translation.uniquecontentcreated || false
    };

    fs.writeFileSync(translationFile, JSON.stringify(translationData, null, 2));

    console.log(`[${jobId}] ✅ Translation saved to filesystem: ${translationFile}`);
    console.log(`[${jobId}] Language preserved: ${translation.language} (${translation.languagename})`);

  } catch (saveError) {
    console.error(`[${jobId}] Failed to save translation to filesystem:`, saveError.message);
  }
};

// ===== LOG TRANSLATION ERROR TO FILESYSTEM =====
const logTranslationError = async (jobId, errorMessage, errorStack) => {
  try {
    const errorsDir = './uploads/errors';
    if (!fs.existsSync(errorsDir)) {
      fs.mkdirSync(errorsDir, { recursive: true });
    }

    const errorFile = path.join(errorsDir, `${jobId}_translation_error.json`);

    const errorData = {
      jobId: jobId,
      timestamp: new Date().toISOString(),
      errormessage: errorMessage,
      errorstack: errorStack,
      step: 'translation',
      service: 'translation-service'
    };

    fs.writeFileSync(errorFile, JSON.stringify(errorData, null, 2));

    console.log(`[${jobId}] Error logged to filesystem: ${errorFile}`);

  } catch (logError) {
    console.error(`[${jobId}] Failed to log error to filesystem:`, logError.message);
  }
};

// ===== SUPPORTED INDIAN LANGUAGES =====
export const getSupportedIndianLanguages = () => {
  return {
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
    'en': 'English',
    'as': 'অসমীয়া (Assamese)',
    'or': 'ଓଡ଼ିଆ (Odia)',
    'ne': 'नेपाली (Nepali)',
    'si': 'සිංහල (Sinhala)',
    'my': 'မြန်မာ (Myanmar)'
  };
};

export const getMostCommonIndianLanguages = () => {
  return {
    'hi': 'हिंदी (Hindi) - Source',
    'bn': 'বাংলা (Bengali)',
    'ta': 'தமিழ் (Tamil)',
    'te': 'తెలుగు (Telugu)',
    'mr': 'मराठी (Marathi)',
    'gu': 'ગુજરાતી (Gujarati)',
    'kn': 'ಕನ್ನಡ (Kannada)',
    'ml': 'മলയാളം (Malayalam)',
    'pa': 'ਪੰਜਾਬੀ (Punjabi)',
    'ur': 'اردو (Urdu)',
    'en': 'English'
  };
};

export const getBestTranslationPairs = () => {
  return [
    { from: 'hi', to: 'bn', quality: '95%', note: 'हिंदी → বাংলা (Excellent)' },
    { from: 'hi', to: 'ta', quality: '93%', note: 'हिंदी → தமிழ் (Excellent)' },
    { from: 'hi', to: 'te', quality: '92%', note: 'हिंदी → తెలుగు (Excellent)' },
    { from: 'hi', to: 'mr', quality: '91%', note: 'हिंदी → मराठी (Very Good)' },
    { from: 'hi', to: 'gu', quality: '90%', note: 'हिंदी → ગુજરાતી (Very Good)' },
    { from: 'hi', to: 'en', quality: '97%', note: 'हिंदी → English (Excellent)' }
  ];
};

export const isLanguagePairSupported = (sourceLang, targetLang) => {
  const supportedLanguages = getSupportedIndianLanguages();
  const bestPairs = getBestTranslationPairs();

  const sourceSupported = supportedLanguages.hasOwnProperty(sourceLang);
  const targetSupported = supportedLanguages.hasOwnProperty(targetLang);
  const pairOptimized = bestPairs.some(pair => pair.from === sourceLang && pair.to === targetLang);

  return {
    supported: sourceSupported && targetSupported,
    sourceSupported: sourceSupported,
    targetSupported: targetSupported,
    pairOptimized: pairOptimized,
    recommendation: pairOptimized ? 'Excellent' : (sourceSupported && targetSupported) ? 'Good' : 'Not Supported'
  };
};

// ===== EXPORT ALL FUNCTIONS =====
export default {
  translateText,
  translateSegments,
  getSupportedIndianLanguages,
  getMostCommonIndianLanguages,
  getBestTranslationPairs,
  isLanguagePairSupported
};