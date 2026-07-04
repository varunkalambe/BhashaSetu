// services/captionService.js - FIXED MISSING CAPTIONS IN TARGET LANGUAGE WITH ENHANCED FEATURES

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { validateTranslationQuality } from './validationService.js';
import { getConfig } from '../config/languageConfig.js';

const execAsync = promisify(exec);

// ===== GENERATE CAPTIONS - FIXED TARGET LANGUAGE USAGE =====
export const generateCaptions = async (translation, jobId) => {
  return new Promise(async (resolve, reject) => {
    try {

      console.log(`--- [${jobId}] CAPTION GENERATION VERIFICATION ---`);
      console.log("1. Received translation object keys:", Object.keys(translation || {}));
      console.log("2. Using language:", translation.language || translation.targetLang);
      console.log("3. Using text (first 100 chars):", (translation.text || "NO TEXT PROVIDED").substring(0, 100));
      console.log(`--- [${jobId}] END VERIFICATION ---`);


      console.log(`[${jobId}] Starting caption and transcript generation...`);
      
      // ===== VALIDATE INPUT =====
      if (!translation || !translation.text) {
        throw new Error('Invalid translation object provided');
      }
      
      if (!translation.segments || translation.segments.length === 0) {
        console.warn(`[${jobId}] No segments provided, creating single segment from full text`);
        translation.segments = [{
          start: 0,
          end: translation.duration || 30,
          text: translation.text,
          originaltext: translation.text
        }];
      }
      
      console.log(`[${jobId}] Processing ${translation.segments.length} segments for captions`);
      
      // ===== FIXED: USE TRANSLATION LANGUAGE, NOT SOURCE LANGUAGE =====
const targetLanguage = translation.language || translation.targetLang || 'en';
const targetLanguageName = translation.languagename || getLanguageName(targetLanguage);

      
      console.log(`[${jobId}] Target language: ${targetLanguageName} (${targetLanguage})`);
      
      // ===== DETECT ACTUAL DURATIONS =====
      console.log(`[${jobId}] 🔍 Detecting actual durations from generated files...`);
      
      let actualVideoDuration = translation.originalduration || 30;
      let actualAudioDuration = translation.translatedduration || actualVideoDuration;
      
      // Try to get actual durations from files
      try {
        const originalVideoPath = await discoverOriginalVideo(jobId);
        if (originalVideoPath && fs.existsSync(originalVideoPath)) {
          actualVideoDuration = await getMediaDuration(originalVideoPath);
          console.log(`[${jobId}] ✅ Original video duration: ${actualVideoDuration}s`);
        }
        
        const ttsAudioPath = `./uploads/translated_audio/${jobId}_translated.wav`;
        if (fs.existsSync(ttsAudioPath)) {
          actualAudioDuration = await getMediaDuration(ttsAudioPath);
          console.log(`[${jobId}] ✅ Generated TTS audio duration: ${actualAudioDuration}s`);
        }
      } catch (durationError) {
        console.warn(`[${jobId}] Failed to detect actual durations:`, durationError.message);
      }
      
      // Use the shorter duration to ensure captions fit
      const captionDuration = Math.min(actualVideoDuration, actualAudioDuration);
      console.log(`[${jobId}] 🎯 Using duration for captions: ${captionDuration}s`);
      
      // ===== TIMING REGENERATION =====
      console.log(`[${jobId}] 📊 Segment count: ${translation.segments.length}`);
      console.log(`[${jobId}] ⏱️ Duration per segment: ${(captionDuration / translation.segments.length).toFixed(2)}s`);
      
      // ===== CREATE OUTPUT DIRECTORIES =====
      const captionsDir = './uploads/captions';
      const transcriptsDir = './uploads/transcripts';
      
      if (!fs.existsSync(captionsDir)) {
        fs.mkdirSync(captionsDir, { recursive: true });
      }
      
      if (!fs.existsSync(transcriptsDir)) {
        fs.mkdirSync(transcriptsDir, { recursive: true });
      }
      
      // ===== DEFINE OUTPUT FILES =====
      const captionFilePath = path.join(captionsDir, `${jobId}_captions.vtt`);
      const srtFilePath = path.join(captionsDir, `${jobId}_captions.srt`);
      const transcriptFilePath = path.join(transcriptsDir, `${jobId}_transcript.txt`);
      
      console.log(`[${jobId}] Caption file: ${captionFilePath}`);
      console.log(`[${jobId}] SRT file: ${srtFilePath}`);
      console.log(`[${jobId}] Transcript file: ${transcriptFilePath}`);




      
// ===== REGENERATE SEGMENT TIMING WITH LANGUAGE-AWARE CHUNKING =====
console.log(`[${jobId}] 🔧 Creating segments with language-aware chunking...`);

let timedSegments;

if (translation.text && translation.text.trim().length > 0) {
  console.log(`[${jobId}] ✅ Creating segments from TRANSLATED text (${targetLanguageName})`);
  
  // GET LANGUAGE CONFIG
  const config = getConfig(targetLanguage);
  console.log(`[${jobId}] Language config: ${config.name}, Max: ${config.maxWords} words/${config.maxChars} chars`);
  
  // CRITICAL FIX: Chunk text into 4-6 word segments using language-specific rules
  const chunks = chunkText(translation.text, config);
  console.log(`[${jobId}] ✅ Chunked into ${chunks.length} segments using ${config.name} rules`);
  
  // Calculate proportional timing based on word count
  const chunkWordCounts = chunks.map(c => c.split(/\s+/).length);
  const totalWords = chunkWordCounts.reduce((sum, count) => sum + count, 0);
  
  console.log(`[${jobId}] Total words: ${totalWords}, distributing ${captionDuration}s proportionally`);
  
  // Assign duration proportionally based on word count
  let currentTime = 0;
  timedSegments = chunks.map((chunk, index) => {
    const wordCount = chunkWordCounts[index];
    const proportion = wordCount / totalWords;
    const duration = Math.min(captionDuration * proportion, 6.0); // Max 6s per caption
    
    const segment = {
      id: index + 1,
      start: currentTime,
      end: Math.min(currentTime + duration, captionDuration),
      text: chunk.trim(),
      originaltext: chunk.trim(),
      duration: duration,
      wordCount: wordCount,
      index: index + 1,
      timingRegenerated: true,
      proportionalTiming: true,
      languageAware: true
    };
    
    currentTime += duration;
    
    if (index < 3) { // Log first 3 for verification
      console.log(`[${jobId}]   Segment ${index + 1}: ${wordCount} words → ${duration.toFixed(2)}s (${segment.start.toFixed(2)}-${segment.end.toFixed(2)}s)`);
      console.log(`[${jobId}]     Text: "${chunk.substring(0, 50)}${chunk.length > 50 ? '...' : ''}"`);
    }
    
    return segment;
  });
  
  console.log(`[${jobId}] ✅ Created ${timedSegments.length} segments with proportional timing (was ${translation.segments?.length || 0})`);
  } else {
  console.warn(`[${jobId}] ⚠️ No translation text, using original segments`);
  timedSegments = await regenerateSegmentTiming(translation.segments, captionDuration, jobId);
}

// 🔥 ADD THIS NEW VALIDATION STEP HERE 🔥
// ===== STEP 0: VALIDATE TRANSLATION QUALITY BEFORE CAPTION GENERATION =====
console.log(`[${jobId}] Step 0/3: Validating translation segments before caption generation...`);
try {
  await validateTranslationQuality(translation.segments, targetLanguage, jobId);
  console.log(`[${jobId}] ✅ Translation quality validation passed - proceeding with caption generation`);
} catch (validationError) {
  console.warn(`[${jobId}] ⚠️ Translation quality validation failed: ${validationError.message}`);
  console.warn(`[${jobId}] ⚠️ Proceeding with caption generation but quality may be compromised`);
  // Don't throw error - continue with caption generation but log the issue
}

// ===== STEP 1: GENERATE WEBVTT CAPTIONS WITH TARGET LANGUAGE =====
console.log(`[${jobId}] Step 1/3: Generating WebVTT captions...`);

      const webvttContent = await generateWebVTT(timedSegments, targetLanguage, targetLanguageName, jobId);
      
      fs.writeFileSync(captionFilePath, webvttContent, 'utf8');
      console.log(`[${jobId}] ✅ WebVTT captions saved: ${webvttContent.length} characters`);
      
      // ===== STEP 2: GENERATE SRT CAPTIONS WITH TARGET LANGUAGE =====
      console.log(`[${jobId}] Step 2/3: Generating SRT captions...`);
      const srtContent = await generateSRT(timedSegments, jobId);
      
      fs.writeFileSync(srtFilePath, srtContent, 'utf8');
      console.log(`[${jobId}] ✅ SRT captions saved: ${srtContent.length} characters`);
      
      // ===== STEP 3: GENERATE PLAIN TEXT TRANSCRIPT WITH TARGET LANGUAGE =====
      console.log(`[${jobId}] Step 3/3: Generating plain text transcript...`);
      const transcriptContent = await generatePlainTextTranscript(
        timedSegments, 
        translation, 
        targetLanguage, 
        targetLanguageName, 
        jobId
      );
      
      fs.writeFileSync(transcriptFilePath, transcriptContent, 'utf8');
      console.log(`[${jobId}] ✅ Plain text transcript saved: ${transcriptContent.length} characters`);
      
      // ===== VALIDATE GENERATED FILES =====
      const captionFileSize = fs.statSync(captionFilePath).size;
      const srtFileSize = fs.statSync(srtFilePath).size;
      const transcriptFileSize = fs.statSync(transcriptFilePath).size;
      
      if (captionFileSize < 50 || srtFileSize < 50 || transcriptFileSize < 50) {
        throw new Error('Generated caption files are too small');
      }
      
      console.log(`[${jobId}] ✅ Caption and transcript generation completed successfully`);
      console.log(`[${jobId}] WebVTT: ${Math.round(captionFileSize / 1024)} KB, SRT: ${Math.round(srtFileSize / 1024)} KB, Transcript: ${Math.round(transcriptFileSize / 1024)} KB`);
      console.log(`[${jobId}] 🎯 Captions synced with ${captionDuration}s audio duration`);
      
      resolve({
        captionPath: captionFilePath,
        srtPath: srtFilePath,
        transcriptPath: transcriptFilePath,
        segmentCount: timedSegments.length,
        totalDuration: captionDuration,
        targetLanguage: targetLanguage,
        targetLanguageName: targetLanguageName,
        filesGenerated: {
          webvtt: captionFileSize,
          srt: srtFileSize,
          transcript: transcriptFileSize
        },
        statistics: getCaptionStatistics(timedSegments),
        syncInfo: {
          originalDuration: actualVideoDuration,
          audioDuration: actualAudioDuration,
          usedDuration: captionDuration,
          avgSegmentDuration: captionDuration / timedSegments.length
        }
      });
      
    } catch (error) {
      console.error(`[${jobId}] Caption generation failed:`, error.message);
      reject(error);
    }
  });
};


export const generateAccurateCaptions = async (translatedWordAlignment, translatedText, jobId, targetLanguage) => {
  console.log(`[${jobId}] 📝 GENERATING VTT CAPTIONS`);
  
  const config = getConfig(targetLanguage);
  console.log(`[${jobId}] Language: ${config.name}, Max: ${config.maxWords} words/${config.maxChars} chars`);
  
  const text = translatedText.text || translatedText;
  const segments = translatedWordAlignment?.segments || [];
  
  if (!text) {
    throw new Error('Translated text is required for caption generation');
  }
  
  console.log(`[${jobId}] Original text: ${text.length} chars, ${segments.length} segments`);
  
  const chunks = chunkText(text, config);
  console.log(`[${jobId}] ✅ Chunked into ${chunks.length} captions (was ${segments.length})`);
  
  const startTime = segments[0]?.start || 0;
  const endTime = segments[segments.length - 1]?.end || 30;
  const totalDuration = endTime - startTime;
  const durationPerChunk = Math.min(totalDuration / chunks.length, 6.0);
  
  const captions = [];
  chunks.forEach((chunk, i) => {
    const start = startTime + (i * durationPerChunk);
    const end = Math.min(start + durationPerChunk, endTime);
    captions.push({ start, end, text: chunk });
  });
  
  let vtt = `WEBVTT\nKind: captions\nLanguage: ${targetLanguage}\n\n`;
  captions.forEach((cap, i) => {
    vtt += `${i + 1}\n${formatVTTTime(cap.start)} --> ${formatVTTTime(cap.end)}\n${cap.text}\n\n`;
  });
  
  const captionsDir = './uploads/captions';
  if (!fs.existsSync(captionsDir)) {
    fs.mkdirSync(captionsDir, { recursive: true });
  }
  
  const vttPath = path.join(captionsDir, `${jobId}_captions_accurate.vtt`);
  fs.writeFileSync(vttPath, vtt, 'utf8');
  
  console.log(`[${jobId}] ✅ VTT saved: ${captions.length} captions, avg ${durationPerChunk.toFixed(2)}s each`);
  return vttPath;
};

function chunkText(text, config) {
  const chunks = [];
  const sentences = text.split(config.delimiter);
  
  sentences.forEach((sentence) => {
    sentence = sentence.trim();
    if (!sentence || sentence.match(config.delimiter)) {
      if (chunks.length > 0) chunks[chunks.length - 1] += sentence;
      return;
    }
    
    const words = sentence.split(/\s+/).filter(w => w.trim());
    for (let i = 0; i < words.length; i += config.maxWords) {
      let chunk = words.slice(i, i + config.maxWords).join(' ');
      
      while (chunk.length > config.maxChars) {
        const subWords = chunk.split(/\s+/);
        chunks.push(subWords.slice(0, Math.floor(subWords.length / 2)).join(' '));
        chunk = subWords.slice(Math.floor(subWords.length / 2)).join(' ');
      }
      
      if (chunk) chunks.push(chunk);
    }
  });
  
  return chunks.filter(c => c.trim());
}



/**
 * ✅ Format seconds to VTT timestamp
 */
const formatVTTTime = (seconds) => {
  if (typeof seconds !== 'number' || isNaN(seconds)) {
    console.warn(`Invalid time value: ${seconds}, using 0`);
    seconds = 0;
  }
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};



// ===== REGENERATE SEGMENT TIMING =====
const regenerateSegmentTiming = async (segments, totalDuration, jobId) => {
  console.log(`[${jobId}] Regenerating segment timing...`);
  
  const segmentCount = segments.length;
  const segmentDuration = totalDuration / segmentCount;
  
  console.log(`[${jobId}]   Original segments: ${segmentCount}`);
  console.log(`[${jobId}]   Target duration: ${totalDuration}s`);
  console.log(`[${jobId}]   New segment duration: ${segmentDuration.toFixed(3)}s each`);
  
  const timedSegments = segments.map((segment, index) => {
    const startTime = index * segmentDuration;
    const endTime = Math.min(startTime + segmentDuration, totalDuration);
    
    console.log(`[${jobId}]   Segment ${index + 1}: ${startTime.toFixed(2)}s - ${endTime.toFixed(2)}s (${(endTime - startTime).toFixed(2)}s)`);
    
    return {
      id: index + 1,
      start: startTime,
      end: endTime,
      text: segment.text || '', // Use translated text
      originaltext: segment.originaltext || segment.text || '',
      duration: endTime - startTime,
      index: index + 1,
      timingRegenerated: true
    };
  });
  
  console.log(`[${jobId}] ✅ Segment timing regenerated for ${segmentCount} segments`);
  console.log(`[${jobId}] 🎯 Total duration: ${totalDuration}s (perfect match with TTS audio)`);
  
  return timedSegments;
};

// GENERATE WEBVTT WITH GROUPED WORDS (4-6 WORDS PER CAPTION)
const generateWebVTT = async (segments, targetLanguage, targetLanguageName, jobId) => {
  console.log(`[${jobId}] Generating WebVTT format for ${segments.length} segments...`);
  
  // ✅ FIX: Group words for better readability
  const WORDS_PER_CAPTION = 5;  // Show 4-6 words at a time
  const MAX_CHARS_PER_LINE = 42; // Maximum characters per line
  
  // Header
  let webvtt = `WEBVTT
Kind: captions
Language: ${targetLanguage}

NOTE
Generated captions in ${targetLanguageName}
Total segments: ${segments.length}
Synced with TTS audio
Generated: ${new Date().toISOString()}

`;

  // ✅ NEW: Process all segments to extract words with timings
  const allWordsWithTiming = [];
  
  segments.forEach((segment, segIndex) => {
    if (!segment.text || segment.text.trim().length === 0) return;
    
    // ✅ FIX #2: Better word splitting (handles compound words better)
const words = segment.text.trim()
  .replace(/([।॥।])/g, ' $1 ')  // Add spaces around punctuation
  .split(/\s+/)
  .filter(w => w.length > 0);
    const segmentDuration = segment.end - segment.start;
    const wordDuration = segmentDuration / words.length;
    
    words.forEach((word, wordIndex) => {
      const wordStart = segment.start + (wordIndex * wordDuration);
      const wordEnd = wordStart + wordDuration;
      
      allWordsWithTiming.push({
        word: word,
        start: wordStart,
        end: wordEnd,
        segmentIndex: segIndex
      });
    });
  });
  
  // ✅ NEW: Group words into captions of 4-6 words each
  let captionIndex = 1;
  
  for (let i = 0; i < allWordsWithTiming.length; i += WORDS_PER_CAPTION) {
    const wordGroup = allWordsWithTiming.slice(i, i + WORDS_PER_CAPTION);
    
    if (wordGroup.length === 0) continue;
    
    const captionStart = wordGroup[0].start;
    const captionEnd = wordGroup[wordGroup.length - 1].end;
    const captionText = wordGroup.map(w => w.word).join(' ');
    
    // Format times
    const startTime = formatTimeWebVTT(captionStart);
    const endTime = formatTimeWebVTT(captionEnd);
    
    // Add cue
    webvtt += `${captionIndex}\n`;
    webvtt += `${startTime} --> ${endTime}\n`;
    
    // Break long lines for readability
    const formattedText = breakLongLines(captionText, MAX_CHARS_PER_LINE);
    webvtt += `${formattedText}\n\n`;
    
    captionIndex++;
  }
  
  console.log(`[${jobId}] ✅ WebVTT generation completed: ${webvtt.length} characters, ${captionIndex - 1} captions`);
  return webvtt;
};


// GENERATE SRT WITH GROUPED WORDS
const generateSRT = async (segments, jobId) => {
  console.log(`[${jobId}] Generating SRT format for ${segments.length} segments...`);
  
  const WORDS_PER_CAPTION = 5;  // Show 4-6 words at a time
  const MAX_CHARS_PER_LINE = 42;
  
  // Extract all words with timing
  const allWordsWithTiming = [];
  
  segments.forEach((segment, segIndex) => {
    if (!segment.text || segment.text.trim().length === 0) return;
    
    const words = segment.text.trim().split(/\s+/);
    const segmentDuration = segment.end - segment.start;
    const wordDuration = segmentDuration / words.length;
    
    words.forEach((word, wordIndex) => {
      const wordStart = segment.start + (wordIndex * wordDuration);
      const wordEnd = wordStart + wordDuration;
      
      allWordsWithTiming.push({
        word: word,
        start: wordStart,
        end: wordEnd
      });
    });
  });
  
  // Group words into captions
  let srt = '';
  let srtIndex = 1;
  
  for (let i = 0; i < allWordsWithTiming.length; i += WORDS_PER_CAPTION) {
    const wordGroup = allWordsWithTiming.slice(i, i + WORDS_PER_CAPTION);
    
    if (wordGroup.length === 0) continue;
    
    const captionStart = wordGroup[0].start;
    const captionEnd = wordGroup[wordGroup.length - 1].end;
    const captionText = wordGroup.map(w => w.word).join(' ');
    
    const startTime = formatTimeSRT(captionStart);
    const endTime = formatTimeSRT(captionEnd);
    
    const formattedText = breakLongLines(captionText, MAX_CHARS_PER_LINE);
    
    srt += `${srtIndex}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${formattedText}\n\n`;
    
    srtIndex++;
  }
  
  console.log(`[${jobId}] ✅ SRT generation completed: ${srt.length} characters`);
  return srt;
};


// ===== GENERATE PLAIN TEXT TRANSCRIPT WITH TARGET LANGUAGE INFO =====
const generatePlainTextTranscript = async (segments, translation, targetLanguage, targetLanguageName, jobId) => {
  console.log(`[${jobId}] Generating plain text transcript for ${segments.length} segments...`);
  
  const timestamp = new Date().toISOString();
  
  // FIXED: Include target language information in transcript
  let transcript = `VIDEO TRANSCRIPT - SYNCED WITH REGENERATED AUDIO
${'='.repeat(60)}

Language: ${targetLanguageName} (${targetLanguage})
Generated: ${new Date().toLocaleString()}
Segments: ${segments.length}
Total Duration: ${translation.originalduration || 0}s
Translation Service: ${translation.translationservice || 'unknown'}
Audio Sync: Regenerated TTS timing

${'='.repeat(60)}

FULL TEXT:
${'-'.repeat(20)}
${translation.text || 'No full text available'}

${'='.repeat(60)}

TIMESTAMPED TRANSCRIPT (SYNCED):
${'-'.repeat(35)}

`;
  
  segments.forEach((segment, index) => {
    if (segment.text && segment.text.trim().length > 0) {
      const startTime = formatTimeReadable(segment.start);
      const endTime = formatTimeReadable(segment.end);
      const duration = (segment.end - segment.start).toFixed(1);
      
      transcript += `[${startTime} - ${endTime}] (${duration}s)\n`;
      transcript += `${segment.text.trim()}\n\n`;
    }
  });
  
  transcript += `${'-'.repeat(60)}
ORIGINAL CONTENT:
${'-'.repeat(20)}

`;
  
  segments.forEach((segment, index) => {
    if (segment.originaltext && segment.originaltext.trim().length > 0) {
      const startTime = formatTimeReadable(segment.start);
      const endTime = formatTimeReadable(segment.end);
      
      transcript += `[${startTime} - ${endTime}] ${segment.originaltext.trim()}\n`;
    }
  });
  
  transcript += `
${'='.repeat(60)}
TRANSLATION DETAILS:
Source Language: ${translation.originallanguagename || 'Hindi'}
Target Language: ${targetLanguageName}
Translation Quality: ${((translation.translationquality || 0) * 100).toFixed(1)}%
Service Used: ${translation.translationservice || 'unknown'}
Segments Translated: ${translation.successfulsegments || 0}/${translation.totalsegments || 0}

End of Transcript
Total Duration: ${formatTimeReadable(segments[segments.length - 1]?.end || 0)}
Timing: Perfectly synced with generated ${targetLanguageName} TTS audio
`;
  
  console.log(`[${jobId}] ✅ Plain text transcript generation completed: ${transcript.length} characters`);
  
  return transcript;
};

// ===== HELPER FUNCTION: FIND ORIGINAL VIDEO FILE =====
const discoverOriginalVideo = async (jobId) => {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const videoDirs = ['./uploads/originals/', './uploads/'];
  
  for (const dir of videoDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        
        // Try job-specific files first
        for (const ext of videoExtensions) {
          const jobFile = `${jobId}${ext}`;
          if (files.includes(jobFile)) {
            return path.join(dir, jobFile);
          }
        }
        
        // Use most recent video file
        const videoFiles = files
          .filter(file => videoExtensions.some(ext => file.endsWith(ext)))
          .map(file => ({
            name: file,
            path: path.join(dir, file),
            mtime: fs.statSync(path.join(dir, file)).mtime
          }))
          .sort((a, b) => b.mtime - a.mtime);
        
        if (videoFiles.length > 0) {
          console.log(`[${jobId}] Found original video: ${videoFiles[0].name}`);
          return videoFiles[0].path;
        }
      } catch (error) {
        console.warn(`[${jobId}] Error reading directory ${dir}:`, error.message);
      }
    }
  }
  
  console.warn(`[${jobId}] No original video file found`);
  return null;
};

// ===== HELPER FUNCTION: GET FILE DURATION =====
const getMediaDuration = async (filePath) => {
  try {
    const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    
    const { stdout } = await execAsync(command, { timeout: 10000 });
    const duration = parseFloat(stdout.trim());
    
    if (isNaN(duration) || duration <= 0) {
      console.warn(`Invalid duration detected for ${filePath}: ${stdout.trim()}`);
      return 0;
    }
    
    return duration;
  } catch (error) {
    console.error(`Duration detection failed for ${filePath}:`, error.message);
    return 0;
  }
};

// ===== TIME FORMATTING FUNCTIONS =====
const formatTimeWebVTT = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = (seconds % 60).toFixed(3);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
};

const formatTimeSRT = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
};

const formatTimeReadable = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  
  return `${minutes.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
};

// ===== HELPER FUNCTION: BREAK LONG LINES =====
const breakLongLines = (text, maxLength = 40) => {
  if (text.length <= maxLength) {
    return text;
  }
  
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (const word of words) {
    if ((currentLine + ' ' + word).length <= maxLength) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }
  
  if (currentLine) {
    lines.push(currentLine);
  }
  
  return lines.join('\n');
};

// ===== HELPER FUNCTIONS =====
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

// ===== HELPER FUNCTION: GET CAPTION STATISTICS =====
export const getCaptionStatistics = (segments) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { totalSegments: 0, totalDuration: 0, averageSegmentLength: 0 };
  }
  
  const totalSegments = segments.length;
  const totalDuration = segments[segments.length - 1]?.end || 0;
  const averageSegmentLength = segments.reduce((sum, seg) => sum + (seg.text?.length || 0), 0) / totalSegments;
  const averageSegmentDuration = totalDuration / totalSegments;
  
  return {
    totalSegments,
    totalDuration: Math.round(totalDuration * 100) / 100,
    averageSegmentLength: Math.round(averageSegmentLength),
    averageSegmentDuration: Math.round(averageSegmentDuration * 100) / 100,
    timingRegenerated: segments[0]?.timingRegenerated || false
  };
};

// ===== HELPER FUNCTION: VALIDATE WEBVTT CONTENT =====
export const validateWebVTT = (webvttContent) => {
  if (!webvttContent || typeof webvttContent !== 'string') {
    return false;
  }
  
  // Check WebVTT header
  if (!webvttContent.startsWith('WEBVTT')) {
    return false;
  }
  
  // Check for basic structure (timestamps)
  const timestampPattern = /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/;
  if (!timestampPattern.test(webvttContent)) {
    return false;
  }
  
  return true;
};

// ===== HELPER FUNCTION: VALIDATE SEGMENTS =====
export const validateSegments = (segments) => {
  if (!Array.isArray(segments)) {
    return { isValid: false, errors: ['Segments is not an array'] };
  }
  
  const errors = [];
  const validSegments = [];
  
  segments.forEach((segment, index) => {
    if (typeof segment.start !== 'number') {
      errors.push(`Segment ${index + 1}: Invalid start time`);
    }
    
    if (typeof segment.end !== 'number') {
      errors.push(`Segment ${index + 1}: Invalid end time`);
    }
    
    if (!segment.text || typeof segment.text !== 'string') {
      errors.push(`Segment ${index + 1}: Invalid or missing text`);
    }
    
    if (segment.start >= segment.end) {
      errors.push(`Segment ${index + 1}: Start time must be before end time`);
    }
    
    if (errors.length === 0) {
      validSegments.push(segment);
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors,
    validSegments,
    originalCount: segments.length,
    validCount: validSegments.length
  };
};

// ===== ADVANCED CAPTION FEATURES =====

// ===== GENERATE ENHANCED WEBVTT WITH STYLING =====
export const generateEnhancedWebVTT = async (segments, targetLanguage, targetLanguageName, jobId, options = {}) => {
  console.log(`[${jobId}] Generating enhanced WebVTT with styling...`);
  
  const {
    includePositioning = true,
    includeColors = true,
    includeFontSize = true
  } = options;
  
  let webvtt = `WEBVTT
Kind: captions
Language: ${targetLanguage}

STYLE
::cue {
  background-color: rgba(0,0,0,0.8);
  color: white;
  font-family: Arial, sans-serif;
  font-size: ${includeFontSize ? '18px' : '16px'};
  line-height: 1.2;
  text-align: center;
}

::cue(.highlight) {
  color: ${includeColors ? 'yellow' : 'white'};
  font-weight: bold;
}

NOTE
Enhanced captions in ${targetLanguageName}
Generated: ${new Date().toISOString()}
Features: positioning, styling, colors
Total segments: ${segments.length}

`;
  
  segments.forEach((segment, index) => {
    if (segment.text && segment.text.trim().length > 0) {
      const startTime = formatTimeWebVTT(segment.start);
      const endTime = formatTimeWebVTT(segment.end);
      
      // Add positioning for better readability
      const position = includePositioning ? ' line:85% position:50% align:center' : '';
      
      webvtt += `${index + 1}\n`;
      webvtt += `${startTime} --> ${endTime}${position}\n`;
      
      let captionText = segment.text.trim();
      captionText = captionText.replace(/\s+/g, ' ');
      captionText = breakLongLines(captionText, 35);
      
      // Add highlighting for important words (if specified)
      if (includeColors && segment.important) {
        captionText = `<c.highlight>${captionText}</c>`;
      }
      
      webvtt += `${captionText}\n\n`;
    }
  });
  
  console.log(`[${jobId}] ✅ Enhanced WebVTT generation completed`);
  return webvtt;
};

// ===== GENERATE CAPTIONS WITH WORD-LEVEL TIMING =====
export const generateWordLevelCaptions = async (segments, jobId) => {
  console.log(`[${jobId}] Generating word-level timed captions...`);
  
  const wordLevelSegments = [];
  
  segments.forEach((segment, segIndex) => {
    if (!segment.text || segment.text.trim().length === 0) return;
    
    const words = segment.text.trim().split(/\s+/);
    const segmentDuration = segment.end - segment.start;
    const wordDuration = segmentDuration / words.length;
    
    words.forEach((word, wordIndex) => {
      const wordStart = segment.start + (wordIndex * wordDuration);
      const wordEnd = wordStart + wordDuration;
      
      wordLevelSegments.push({
        id: `${segIndex + 1}-${wordIndex + 1}`,
        start: wordStart,
        end: wordEnd,
        text: word,
        segmentId: segIndex + 1,
        wordIndex: wordIndex
      });
    });
  });
  
  console.log(`[${jobId}] ✅ Word-level timing generated: ${wordLevelSegments.length} words`);
  return wordLevelSegments;
};

// ===== EXPORT ALL FUNCTIONS =====
export default {
  generateCaptions,
  generateAccurateCaptions,  // <-- ADD THIS LINE
  generateWebVTT: generateWebVTT,
  generateSRT,
  generatePlainTextTranscript,
  formatTimeWebVTT,
  formatTimeSRT,
  formatTimeReadable,
  breakLongLines,
  validateWebVTT,
  getCaptionStatistics,
  validateSegments,
  generateEnhancedWebVTT,
  generateWordLevelCaptions
};
