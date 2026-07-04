import dotenv from 'dotenv';
import https from 'https';
import fs from 'fs';
import path from 'path';



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


// ===== MAIN TRANSLATION FUNCTION - WITH LIBRETRANSLATE RETRY LOGIC =====
export const translateText = async (text, sourceLang, targetLang, jobId = 'unknown') => {
  console.log(`[${jobId}] Starting translation: ${sourceLang} → ${targetLang}`);

  // ADD THESE LINES:
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


  // ===== PRIORITY 2: MYMEMORY API (PRIMARY FREE FALLBACK) =====
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
  try {
    console.log(`[${jobId}] Attempting Google Translate...`);
    const result = await translateWithMyMemory(jobId, sourceLang, targetLang, text);

    if (result && result.text) {
      console.log(`[${jobId}] ✅ Google Translate successful`);
      return result;
    }
  } catch (googleError) {
    console.warn(`[${jobId}] Google Translate failed: ${googleError.message}`);
  }

  // All services failed
  throw new Error(`All translation services failed for ${sourceLang} → ${targetLang}`);
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
  getSupportedIndianLanguages,
  getMostCommonIndianLanguages,
  getBestTranslationPairs,
  isLanguagePairSupported
};
