// services/durationAwareTranslation.js - SPEECH TIMING CALCULATOR WITH PRECISE SEGMENT CONTROL

import * as syllableModule from 'syllable';
import compromise from 'compromise';
import fs from 'fs';
import path from 'path';

// Handle different export styles
const syllable = syllableModule.default || syllableModule;

// ===== ENHANCED SPEECH DURATION CALCULATION WITH LANGUAGE-SPECIFIC TIMING =====
export const calculateSpeechDuration = (text, language = 'en', complexity = 'normal') => {
  console.log(`Calculating speech duration for ${language}: "${text.substring(0, 50)}..."`);
  
  if (!text || text.trim().length === 0) {
    return 0.5; // Minimum duration for empty text
  }

  let syllableCount;
  let wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  
  try {
    syllableCount = syllable(text);
  } catch (error) {
    console.warn('Syllable calculation failed, using fallback estimation');
    syllableCount = estimateSyllablesAdvanced(text, language);
  }
  
  // Enhanced language-specific speech rates with complexity factors
  const languageRates = {
    'en': { 
      wpm: { slow: 120, normal: 150, fast: 180 }, 
      spm: { slow: 360, normal: 450, fast: 540 },
      complexity_factor: 1.0,
      pause_factor: 0.95 // English has fewer natural pauses
    },
    'hi': { 
      wpm: { slow: 110, normal: 130, fast: 155 }, 
      spm: { slow: 330, normal: 390, fast: 465 },
      complexity_factor: 1.15, // Hindi has more complex phonetics
      pause_factor: 1.05 // More natural pauses in Hindi speech
    },
    'bn': { 
      wpm: { slow: 115, normal: 140, fast: 165 }, 
      spm: { slow: 345, normal: 420, fast: 495 },
      complexity_factor: 1.10,
      pause_factor: 1.08
    },
    'te': { 
      wpm: { slow: 110, normal: 135, fast: 160 }, 
      spm: { slow: 330, normal: 405, fast: 480 },
      complexity_factor: 1.20, // Telugu has complex consonant clusters
      pause_factor: 1.10
    },
    'ta': { 
      wpm: { slow: 105, normal: 125, fast: 150 }, 
      spm: { slow: 315, normal: 375, fast: 450 },
      complexity_factor: 1.25, // Tamil has the most complex phonetics
      pause_factor: 1.12
    },
    'mr': { 
      wpm: { slow: 110, normal: 130, fast: 155 }, 
      spm: { slow: 330, normal: 390, fast: 465 },
      complexity_factor: 1.15,
      pause_factor: 1.06
    },
    'gu': { 
      wpm: { slow: 105, normal: 125, fast: 150 }, 
      spm: { slow: 315, normal: 375, fast: 450 },
      complexity_factor: 1.18,
      pause_factor: 1.08
    },
    'kn': { 
      wpm: { slow: 110, normal: 135, fast: 160 }, 
      spm: { slow: 330, normal: 405, fast: 480 },
      complexity_factor: 1.20,
      pause_factor: 1.09
    },
    'ml': { 
      wpm: { slow: 108, normal: 130, fast: 155 }, 
      spm: { slow: 324, normal: 390, fast: 465 },
      complexity_factor: 1.22,
      pause_factor: 1.11
    },
    'pa': { 
      wpm: { slow: 112, normal: 132, fast: 158 }, 
      spm: { slow: 336, normal: 396, fast: 474 },
      complexity_factor: 1.12,
      pause_factor: 1.04
    },
    'ur': { 
      wpm: { slow: 115, normal: 138, fast: 165 }, 
      spm: { slow: 345, normal: 414, fast: 495 },
      complexity_factor: 1.08,
      pause_factor: 1.03
    }
  };

  const rates = languageRates[language] || languageRates['en'];
  const speedRates = rates.wpm[complexity] ? rates : languageRates['en'];
  
  // Calculate base durations
  const wordBasedDuration = (wordCount / speedRates.wpm[complexity]) * 60;
  const syllableBasedDuration = (syllableCount / speedRates.spm[complexity]) * 60;
  
  // Use the longer duration as base (more conservative approach)
  let baseDuration = Math.max(wordBasedDuration, syllableBasedDuration);
  
  // Apply language-specific adjustments
  baseDuration *= rates.complexity_factor;
  baseDuration *= rates.pause_factor;
  
  // Add punctuation pause time
  const punctuationPauses = (text.match(/[।.!?;,]/g) || []).length;
  const pauseTime = punctuationPauses * 0.3; // 300ms per punctuation mark
  
  // Add breathing pause time for long sentences
  const sentenceCount = text.split(/[।.!?]+/).filter(s => s.trim().length > 0).length;
  const breathingPauses = Math.max(0, sentenceCount - 1) * 0.5; // 500ms between sentences
  
  const finalDuration = baseDuration + pauseTime + breathingPauses;
  
  // Ensure minimum and maximum bounds
  const minDuration = Math.max(0.5, wordCount * 0.2); // Minimum 200ms per word
  const maxDuration = wordCount * 2.0; // Maximum 2s per word
  
  const clampedDuration = Math.max(minDuration, Math.min(maxDuration, finalDuration));
  
  console.log(`Duration calculation: ${wordCount} words, ${syllableCount} syllables → ${clampedDuration.toFixed(2)}s`);
  
  return clampedDuration;
};

// ===== ADVANCED SYLLABLE ESTIMATION WITH LANGUAGE SUPPORT =====
const estimateSyllablesAdvanced = (text, language = 'en') => {
  if (!text || text.trim().length === 0) return 0;
  
  const words = text.toLowerCase().trim().split(/\s+/);
  let totalSyllables = 0;
  
  // Language-specific syllable estimation rules
  const syllableRules = {
    'en': {
      vowels: 'aeiouy',
      vowelClusters: ['ai', 'au', 'ea', 'ee', 'ei', 'ie', 'io', 'oa', 'oo', 'ou', 'ue', 'ui'],
      silentEndings: ['e', 'ed', 'es'],
      multipliers: { consonantClusters: 1.1 }
    },
    'hi': {
      vowels: 'aeiouअआइईउऊएऐओऔअं',
      vowelClusters: ['ai', 'au', 'ei', 'ou'],
      silentEndings: [],
      multipliers: { consonantClusters: 1.3, conjuncts: 1.2 }
    },
    'bn': {
      vowels: 'aeiouঅআইঈউঊএঐওঔ',
      vowelClusters: ['ai', 'au', 'ei', 'ou'],
      silentEndings: [],
      multipliers: { consonantClusters: 1.2, conjuncts: 1.1 }
    }
  };
  
  const rules = syllableRules[language] || syllableRules['en'];
  
  for (const word of words) {
    if (word.length === 0) continue;
    
    // Remove non-alphabetic characters for counting
    const cleanWord = word.replace(/[^a-zA-Zঅ-৯অ-হ़-়া-ৎ০-৯अ-ह़-़ा-ृ०-९]/g, '');
    if (cleanWord.length === 0) {
      totalSyllables += 1; // Count non-alphabetic words as 1 syllable
      continue;
    }
    
    let syllables = 0;
    let previousWasVowel = false;
    
    // Count vowel groups
    for (let i = 0; i < cleanWord.length; i++) {
      const char = cleanWord[i];
      const isVowel = rules.vowels.includes(char);
      
      if (isVowel && !previousWasVowel) {
        syllables++;
      }
      previousWasVowel = isVowel;
    }
    
    // Handle silent endings for English
    if (language === 'en') {
      for (const ending of rules.silentEndings) {
        if (cleanWord.endsWith(ending) && syllables > 1) {
          syllables -= 0.5; // Reduce syllable count for silent endings
        }
      }
    }
    
    // Apply language-specific multipliers
    if (rules.multipliers.consonantClusters) {
      const consonantClusters = (cleanWord.match(/[bcdfghjklmnpqrstvwxyz]{2,}/gi) || []).length;
      syllables *= (1 + consonantClusters * 0.1 * rules.multipliers.consonantClusters);
    }
    
    // Minimum of 1 syllable per word
    syllables = Math.max(Math.round(syllables), 1);
    totalSyllables += syllables;
  }
  
  return Math.round(totalSyllables);
};

// ===== ENHANCED TRANSLATION LENGTH CONSTRAINT WITH TIMING PRECISION =====
export const constrainTranslationLength = async (originalText, translatedText, targetDuration, targetLanguage, segmentIndex = 0) => {
  console.log(`Constraining translation length for segment ${segmentIndex}: target=${targetDuration.toFixed(2)}s`);
  
  const originalDuration = calculateSpeechDuration(originalText, 'en');
  const translatedDuration = calculateSpeechDuration(translatedText, targetLanguage);
  const durationRatio = targetDuration / translatedDuration;
  
  console.log(`Duration analysis: original=${originalDuration.toFixed(2)}s, translated=${translatedDuration.toFixed(2)}s, ratio=${durationRatio.toFixed(3)}`);

  // More precise tolerance for better timing
  if (Math.abs(durationRatio - 1) < 0.10) { // 10% tolerance
    console.log('Duration within acceptable range, no adjustment needed');
    return {
      text: translatedText,
      duration: translatedDuration,
      adjustment: 'none',
      ratio: durationRatio,
      quality_score: 100
    };
  }

  let adjustedText = translatedText;
  let adjustmentType = 'none';
  let qualityScore = 90; // Start with high quality, deduct for adjustments
  
  if (durationRatio < 0.75) { // Translation is too long
    console.log(`Translation too long (${durationRatio.toFixed(3)}), shortening...`);
    adjustedText = await shortenTranslationPrecise(translatedText, targetLanguage, targetDuration);
    adjustmentType = 'shortened';
    qualityScore -= 15; // Deduct for shortening
    
  } else if (durationRatio > 1.3) { // Translation is too short
    console.log(`Translation too short (${durationRatio.toFixed(3)}), expanding...`);
    adjustedText = await expandTranslationNatural(translatedText, targetLanguage, targetDuration);
    adjustmentType = 'expanded';
    qualityScore -= 10; // Less deduction for expansion
  }

  const finalDuration = calculateSpeechDuration(adjustedText, targetLanguage);
  const finalRatio = targetDuration / finalDuration;
  
  // Additional quality assessment
  if (Math.abs(finalRatio - 1) < 0.05) qualityScore += 10; // Bonus for precise timing
  
  console.log(`Adjustment completed: ${adjustmentType}, final duration=${finalDuration.toFixed(2)}s, ratio=${finalRatio.toFixed(3)}`);
  
  return {
    text: adjustedText,
    duration: finalDuration,
    adjustment: adjustmentType,
    ratio: finalRatio,
    original_length: translatedText.length,
    adjusted_length: adjustedText.length,
    quality_score: Math.max(0, Math.min(100, qualityScore)),
    timing_precision: Math.abs(finalRatio - 1) < 0.1 ? 'high' : 'medium'
  };
};

// ===== PRECISE TRANSLATION SHORTENING =====
const shortenTranslationPrecise = async (text, language, targetDuration) => {
  console.log(`Shortening translation: target=${targetDuration.toFixed(2)}s`);
  
  const doc = compromise(text);
  const sentences = doc.sentences().out('array');
  
  if (sentences.length <= 1) {
    // Single sentence - reduce word by word intelligently
    return shortenSingleSentence(text, language, targetDuration);
  }

  // Multiple sentences - prioritize by importance and duration
  const sentenceAnalysis = sentences.map((sentence, index) => ({
    text: sentence.trim(),
    index,
    importance: calculateSentenceImportanceAdvanced(sentence, language),
    duration: calculateSpeechDuration(sentence, language),
    wordCount: sentence.split(/\s+/).length
  }));

  // Sort by importance (descending) and duration efficiency
  sentenceAnalysis.sort((a, b) => {
    const importanceWeight = (b.importance - a.importance) * 10;
    const efficiencyWeight = (a.duration / a.wordCount) - (b.duration / b.wordCount);
    return importanceWeight + efficiencyWeight;
  });

  // Select sentences that fit within target duration
  const selectedSentences = [];
  let accumulatedDuration = 0;

  for (const sentence of sentenceAnalysis) {
    if (accumulatedDuration + sentence.duration <= targetDuration * 0.95) { // 5% buffer
      selectedSentences.push(sentence);
      accumulatedDuration += sentence.duration;
    }
  }

  if (selectedSentences.length === 0) {
    // If no sentences fit, take the most important one and shorten it
    const mostImportant = sentenceAnalysis[0];
    return shortenSingleSentence(mostImportant.text, language, targetDuration);
  }

  // Reassemble in original order
  const finalSentences = selectedSentences
    .sort((a, b) => a.index - b.index)
    .map(s => s.text);

  return finalSentences.join(' ');
};

// ===== SHORTEN SINGLE SENTENCE =====
const shortenSingleSentence = (text, language, targetDuration) => {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const currentDuration = calculateSpeechDuration(text, language);
  const reductionRatio = targetDuration / currentDuration;
  
  const targetWordCount = Math.max(1, Math.floor(words.length * reductionRatio * 0.9)); // 10% buffer
  
  // Preserve important words (nouns, verbs, adjectives)
  const doc = compromise(text);
  const importantWords = [
    ...doc.nouns().out('array'),
    ...doc.verbs().out('array'),
    ...doc.adjectives().out('array')
  ].map(w => w.toLowerCase());
  
  const preservedWords = [];
  const remainingWords = [];
  
  for (const word of words) {
    if (importantWords.includes(word.toLowerCase()) || preservedWords.length < targetWordCount * 0.6) {
      preservedWords.push(word);
    } else {
      remainingWords.push(word);
    }
  }
  
  // Add remaining words until target count
  const finalWords = [...preservedWords];
  for (const word of remainingWords) {
    if (finalWords.length < targetWordCount) {
      finalWords.push(word);
    } else {
      break;
    }
  }
  
  return finalWords.join(' ') + (finalWords.length < words.length ? '...' : '');
};

// ===== NATURAL TRANSLATION EXPANSION =====
const expandTranslationNatural = async (text, language, targetDuration) => {
  console.log(`Expanding translation naturally: target=${targetDuration.toFixed(2)}s`);
  
  const currentDuration = calculateSpeechDuration(text, language);
  const expansionNeeded = targetDuration - currentDuration;
  
  if (expansionNeeded < 0.5) {
    return text; // Minimal expansion needed
  }

  let expandedText = text;
  const doc = compromise(text);

  // Strategy 1: Add natural connectors and fillers
  const naturalFillers = {
    'hi': [' वास्तव में ', ' निश्चित रूप से ', ' जैसा कि आप जानते हैं ', ' यह स्पष्ट है कि ', ' महत्वपूर्ण बात यह है कि '],
    'bn': [' আসলে ', ' নিশ্চিতভাবে ', ' যেমনটা আপনি জানেন ', ' এটা স্পষ্ট যে ', ' গুরুত্বপূর্ণ বিষয় হলো '],
    'te': [' నిజంగా ', ' ఖచ్చితంగా ', ' మీకు తెలిసినట్లుగా ', ' ఇది స్పష్టంగా ఉంది ', ' ముఖ్యమైన విషయం ఏమిటంటే '],
    'ta': [' உண்மையில் ', ' நிச்சயமாக ', ' நீங்கள் அறிந்தபடி ', ' இது தெளิவாக உள்ளது ', ' முக்கியமான விషయம் என்னவென்றால் '],
    'mr': [' खरोखर ', ' नक्कीच ', ' जसे तुम्हाला माहीत आहे ', ' हे स्पष्ट आहे की ', ' महत्त्वाची गोष्ट अशी की '],
    'gu': [' ખરેખર ', ' ચોક્કસપણે ', ' જેમ તમે જાણો છો ', ' આ સ્પષ્ટ છે કે ', ' મહત્વપૂર્ણ વાત એ છે કે '],
    'kn': [' ನಿಜವಾಗಿ ', ' ಖಚಿತವಾಗಿ ', ' ನಿಮಗೆ ತಿಳಿದಿರುವಂತೆ ', ' ಇದು ಸ್ಪಷ್ಟವಾಗಿದೆ ', ' ಮುಖ್ಯ ವಿಷಯವೆಂದರೆ '],
    'ml': [' യഥാർത്ഥത്തിൽ ', ' തീർച്ചയായും ', ' നിങ്ങൾക്ക് അറിയാവുന്നതുപോലെ ', ' ഇത് വ്യക്തമാണ് ', ' പ്രധാനപ്പെട്ട കാര്യം എന്തെന്നാൽ '],
    'en': [' actually ', ' certainly ', ' as you know ', ' it is clear that ', ' the important thing is that ']
  };

  const fillers = naturalFillers[language] || naturalFillers['en'];
  
  // Strategy 2: Add descriptive adjectives and adverbs
  const sentences = expandedText.split(/[।.!?]+/).filter(s => s.trim().length > 0);
  const expandedSentences = sentences.map((sentence, index) => {
    let expanded = sentence.trim();
    
    // Add filler at the beginning of alternate sentences
    if (index % 2 === 0 && fillers.length > 0) {
      const randomFiller = fillers[Math.floor(Math.random() * fillers.length)];
      expanded = randomFiller + expanded;
    }
    
    // Add natural pauses with commas
    if (expanded.length > 20 && !expanded.includes(',')) {
      const midPoint = Math.floor(expanded.split(' ').length / 2);
      const words = expanded.split(' ');
      words[midPoint] = words[midPoint] + ',';
      expanded = words.join(' ');
    }
    
    return expanded;
  });

  expandedText = expandedSentences.join('। ');
  
  // Strategy 3: If still short, add emphasis words
  const currentExpandedDuration = calculateSpeechDuration(expandedText, language);
  if (currentExpandedDuration < targetDuration * 0.9) {
    const emphasisWords = {
      'hi': [' बहुत ', ' अत्यधिक ', ' विशेष रूप से '],
      'bn': [' খুব ', ' অত্যন্ত ', ' বিশেষভাবে '],
      'te': [' చాలా ', ' అధికంగా ', ' ప్రత్యేకంగా '],
      'ta': [' மிகவும் ', ' அதிகமாக ', ' குறிப்பாக '],
      'mr': [' खूप ', ' जास्त ', ' विशेषत: '],
      'en': [' very ', ' extremely ', ' especially ']
    };
    
    const emphasis = emphasisWords[language] || emphasisWords['en'];
    const randomEmphasis = emphasis[Math.floor(Math.random() * emphasis.length)];
    
    // Add emphasis to the first significant word
    const words = expandedText.split(' ');
    if (words.length > 3) {
      words[2] = randomEmphasis + words[2];
      expandedText = words.join(' ');
    }
  }

  return expandedText;
};

// ===== ADVANCED SENTENCE IMPORTANCE CALCULATION =====
const calculateSentenceImportanceAdvanced = (sentence, language) => {
  const doc = compromise(sentence);
  let importance = 0;

  // Base grammatical importance
  importance += doc.nouns().length * 3;      // Nouns are very important
  importance += doc.verbs().length * 2.5;    // Verbs are crucial for meaning
  importance += doc.adjectives().length * 1.5; // Adjectives add context
  importance += doc.adverbs().length * 1;    // Adverbs modify meaning
  
  // Sentence type importance
  if (doc.has('#Question')) importance += 4;     // Questions are important
  if (doc.has('#Imperative')) importance += 3;  // Commands are important
  if (doc.has('#Exclamation')) importance += 2; // Exclamations add emphasis
  
  // Content-based importance
  if (sentence.includes('important') || sentence.includes('crucial') || sentence.includes('essential')) {
    importance += 3;
  }
  
  // Length penalty for overly short sentences
  if (sentence.length < 15) importance -= 2;
  
  // Bonus for sentences with numbers or specific data
  if (/\d/.test(sentence)) importance += 2;
  
  // Language-specific adjustments
  if (language !== 'en') {
    // Non-English sentences might need slight importance boost for preservation
    importance *= 1.1;
  }

  return Math.max(0, importance);
};

// ===== SEGMENT-AWARE TRANSLATION WITH PRECISE TIMING CONTROL =====
export const segmentAwareTranslation = async (originalSegments, translatedSegments, targetLanguage, jobId = 'unknown') => {
  console.log(`[${jobId}] Processing ${originalSegments.length} segments for duration-aware translation`);
  
  const constrainedSegments = [];
  let totalSuccessful = 0;

  for (let i = 0; i < Math.min(originalSegments.length, translatedSegments.length); i++) {
    const originalSeg = originalSegments[i];
    const translatedSeg = translatedSegments[i];
    
    console.log(`[${jobId}] Processing segment ${i + 1}/${originalSegments.length}`);
    
    // Calculate target duration with multiple approaches
    let targetDuration = originalSeg.duration;
    
    if (!targetDuration || targetDuration <= 0) {
      // Fallback duration calculation
      targetDuration = calculateSpeechDuration(originalSeg.text, 'en');
      console.log(`[${jobId}] Calculated fallback duration for segment ${i + 1}: ${targetDuration.toFixed(2)}s`);
    }

    try {
      const constrainedTranslation = await constrainTranslationLength(
        originalSeg.text,
        translatedSeg.text,
        targetDuration,
        targetLanguage,
        i
      );

      const finalSegment = {
        ...translatedSeg,
        text: constrainedTranslation.text,
        duration: constrainedTranslation.duration,
        original_duration: targetDuration,
        duration_ratio: constrainedTranslation.ratio,
        adjustment_type: constrainedTranslation.adjustment,
        quality_score: constrainedTranslation.quality_score,
        timing_precision: constrainedTranslation.timing_precision,
        word_count: constrainedTranslation.text.split(/\s+/).length,
        character_count: constrainedTranslation.text.length
      };

      constrainedSegments.push(finalSegment);
      
      if (Math.abs(constrainedTranslation.ratio - 1) < 0.15) {
        totalSuccessful++;
      }
      
      console.log(`[${jobId}] Segment ${i + 1} processed: ${constrainedTranslation.adjustment} (quality: ${constrainedTranslation.quality_score})`);
      
    } catch (segmentError) {
      console.error(`[${jobId}] Segment ${i + 1} processing failed:`, segmentError.message);
      
      // Fallback: use original translated segment with basic duration
      constrainedSegments.push({
        ...translatedSeg,
        duration: targetDuration,
        original_duration: targetDuration,
        duration_ratio: 1.0,
        adjustment_type: 'failed',
        quality_score: 50,
        timing_precision: 'low',
        error: segmentError.message
      });
    }
  }

  // Calculate overall statistics
  const totalOriginalDuration = originalSegments.reduce((sum, seg) => 
    sum + (seg.duration || calculateSpeechDuration(seg.text, 'en')), 0);
  const totalTranslatedDuration = constrainedSegments.reduce((sum, seg) => 
    sum + (seg.duration || 0), 0);
  
  const averageQuality = constrainedSegments.reduce((sum, seg) => 
    sum + (seg.quality_score || 50), 0) / constrainedSegments.length;

  const result = {
    segments: constrainedSegments,
    statistics: {
      total_segments: constrainedSegments.length,
      successful_constraints: totalSuccessful,
      success_rate: (totalSuccessful / constrainedSegments.length) * 100,
      total_original_duration: totalOriginalDuration,
      total_translated_duration: totalTranslatedDuration,
      duration_preservation_ratio: totalOriginalDuration / (totalTranslatedDuration || 1),
      average_quality_score: averageQuality,
      timing_accuracy: totalSuccessful / constrainedSegments.length >= 0.8 ? 'high' : 'medium'
    },
    quality_metrics: {
      perfect_timing: constrainedSegments.filter(s => Math.abs(s.duration_ratio - 1) < 0.05).length,
      good_timing: constrainedSegments.filter(s => Math.abs(s.duration_ratio - 1) < 0.15).length,
      acceptable_timing: constrainedSegments.filter(s => Math.abs(s.duration_ratio - 1) < 0.25).length,
      poor_timing: constrainedSegments.filter(s => Math.abs(s.duration_ratio - 1) >= 0.25).length
    }
  };

  console.log(`[${jobId}] ✅ Segment-aware translation completed:`);
  console.log(`[${jobId}]   Success rate: ${result.statistics.success_rate.toFixed(1)}%`);
  console.log(`[${jobId}]   Duration preservation: ${result.statistics.duration_preservation_ratio.toFixed(3)}`);
  console.log(`[${jobId}]   Average quality: ${result.statistics.average_quality_score.toFixed(1)}/100`);
  console.log(`[${jobId}]   Timing accuracy: ${result.statistics.timing_accuracy}`);

  return result;
};

// ===== SPEECH RATE OPTIMIZATION FOR TTS =====
export const optimizeSpeechRateForTTS = (text, targetDuration, language = 'en') => {
  const naturalDuration = calculateSpeechDuration(text, language);
  const requiredSpeedRatio = naturalDuration / targetDuration;
  
  // Clamp speed ratio to reasonable bounds for natural speech
  const minSpeed = 0.6;  // 60% of normal speed
  const maxSpeed = 1.8;  // 180% of normal speed
  const clampedRatio = Math.max(minSpeed, Math.min(maxSpeed, requiredSpeedRatio));
  
  // Convert to Edge-TTS rate parameter
  let rateParam;
  if (clampedRatio > 1.0) {
    rateParam = `+${Math.round((clampedRatio - 1.0) * 100)}%`;
  } else {
    rateParam = `-${Math.round((1.0 - clampedRatio) * 100)}%`;
  }
  
  return {
    speed_ratio: clampedRatio,
    rate_param: rateParam,
    expected_duration: naturalDuration / clampedRatio,
    duration_accuracy: Math.abs((naturalDuration / clampedRatio) - targetDuration) < 0.2,
    quality_impact: clampedRatio < 0.8 || clampedRatio > 1.5 ? 'medium' : 'low'
  };
};

// ===== EXPORT ALL FUNCTIONS =====
export default {
  calculateSpeechDuration,
  constrainTranslationLength,
  segmentAwareTranslation,
  optimizeSpeechRateForTTS
};
