import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const generatePhonemeControlledTTS = async (text, phonemeTimings, voiceConfig, outputPath, jobId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const tempDir = `./uploads/phoneme_tts/${jobId}`;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const ssmlText = await generateSSMLWithTimings(text, phonemeTimings, voiceConfig);
      const ssmlFile = path.join(tempDir, 'speech.ssml');
      fs.writeFileSync(ssmlFile, ssmlText);

      console.log(`[${jobId}] Generating phoneme-controlled TTS with ${phonemeTimings.length} timing constraints`);

      const ttsCommand = `edge-tts --ssml-file "${ssmlFile}" --voice "${voiceConfig.voice}" --write-media "${outputPath}"`;

      exec(ttsCommand, { 
        maxBuffer: 1024 * 1024 * 50,
        timeout: 180000 
      }, async (error, stdout, stderr) => {
        if (error) {
          console.warn(`[${jobId}] Phoneme TTS failed, using fallback:`, error.message);
          const fallbackPath = await generateFallbackTTS(text, voiceConfig, outputPath, jobId);
          resolve(fallbackPath);
          return;
        }

        if (fs.existsSync(outputPath)) {
          const generatedDuration = await getAudioDuration(outputPath);
          const targetDuration = phonemeTimings[phonemeTimings.length - 1]?.end || 0;
          
          console.log(`[${jobId}] Phoneme TTS completed: ${generatedDuration}s (target: ${targetDuration}s)`);
          
          if (Math.abs(generatedDuration - targetDuration) > 1.0 && targetDuration > 0) {
            const adjustedPath = await adjustToExactDuration(outputPath, targetDuration, jobId);
            resolve(adjustedPath);
          } else {
            resolve(outputPath);
          }
        } else {
          const fallbackPath = await generateFallbackTTS(text, voiceConfig, outputPath, jobId);
          resolve(fallbackPath);
        }
      });

    } catch (error) {
      reject(error);
    }
  });
};

const generateSSMLWithTimings = async (text, phonemeTimings, voiceConfig) => {
  let ssml = `<?xml version="1.0" encoding="UTF-8"?>
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceConfig.lang || 'en-US'}">
<voice name="${voiceConfig.voice}">`;

  if (!phonemeTimings || phonemeTimings.length === 0) {
    ssml += `<prosody rate="medium" pitch="medium">${escapeXML(text)}</prosody>`;
  } else {
    let currentIndex = 0;
    
    for (const timing of phonemeTimings) {
      if (timing.alignment_failed) {
        ssml += `<prosody rate="medium">${escapeXML(timing.text)}</prosody> `;
        continue;
      }

      const rate = calculateOptimalRate(timing.text, timing.duration);
      const pauseBefore = timing.start - (currentIndex > 0 ? phonemeTimings[currentIndex - 1].end : 0);
      
      if (pauseBefore > 0.1) {
        ssml += `<break time="${Math.min(pauseBefore, 2).toFixed(1)}s"/>`;
      }
      
      ssml += `<prosody rate="${rate}%" pitch="medium">${escapeXML(timing.text)}</prosody> `;
      currentIndex++;
    }
  }

  ssml += `</voice>
</speak>`;

  return ssml;
};

const calculateOptimalRate = (text, targetDuration) => {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const normalWPM = 150;
  const requiredWPM = Math.max(50, Math.min(300, (wordCount / Math.max(targetDuration / 60, 0.01))));
  const ratePercentage = Math.round((requiredWPM / normalWPM) * 100);
  
  return Math.max(50, Math.min(200, ratePercentage));
};

const escapeXML = (text) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

const adjustToExactDuration = async (audioPath, targetDuration, jobId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const currentDuration = await getAudioDuration(audioPath);
      const speedRatio = currentDuration / targetDuration;
      const clampedRatio = Math.max(0.5, Math.min(2.0, speedRatio));
      
      const adjustedPath = audioPath.replace(/\.(wav|mp3)$/, '_duration_adjusted.$1');
      
      const adjustCommand = `ffmpeg -i "${audioPath}" -filter:a "atempo=${clampedRatio}" -y "${adjustedPath}"`;
      
      exec(adjustCommand, { timeout: 45000 }, (error, stdout, stderr) => {
        if (error) {
          console.warn(`[${jobId}] Duration adjustment failed:`, error.message);
          resolve(audioPath);
          return;
        }
        
        console.log(`[${jobId}] Audio duration adjusted by factor: ${clampedRatio.toFixed(3)}`);
        resolve(adjustedPath);
      });
      
    } catch (error) {
      resolve(audioPath);
    }
  });
};

const generateSegmentedPhoneTTS = async (segments, phonemeTimings, voiceConfig, outputPath, jobId) => {
  const segmentFiles = [];
  const tempDir = `./uploads/phoneme_segments/${jobId}`;
  
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentPhonemes = phonemeTimings.filter(p => p.segment_index === i);
      const segmentFile = path.join(tempDir, `segment_${i}.wav`);
      
      console.log(`[${jobId}] Generating phoneme TTS for segment ${i + 1}/${segments.length}`);
      
      await generatePhonemeControlledTTS(
        segment.text,
        segmentPhonemes,
        voiceConfig,
        segmentFile,
        `${jobId}_seg_${i}`
      );

      if (fs.existsSync(segmentFile)) {
        segmentFiles.push(segmentFile);
      } else {
        console.warn(`[${jobId}] Segment ${i} TTS failed, creating silence`);
        const silenceFile = path.join(tempDir, `silence_${i}.wav`);
        await createSilence(silenceFile, segment.duration || 1);
        segmentFiles.push(silenceFile);
      }
    }

    await concatenateAudioFiles(segmentFiles, outputPath, jobId);
    
    segmentFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (cleanupError) {
        console.warn(`[${jobId}] Cleanup failed for ${file}`);
      }
    });

    console.log(`[${jobId}] Phoneme-controlled segmented TTS completed`);
    return outputPath;

  } catch (error) {
    console.error(`[${jobId}] Phoneme segmented TTS failed:`, error.message);
    throw error;
  }
};

const generateFallbackTTS = async (text, voiceConfig, outputPath, jobId) => {
  return new Promise((resolve, reject) => {
    const fallbackCommand = `edge-tts --voice "${voiceConfig.voice}" --text "${text.replace(/"/g, '').slice(0, 1000)}" --write-media "${outputPath}"`;
    
    exec(fallbackCommand, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Fallback TTS also failed: ${error.message}`));
        return;
      }
      
      console.log(`[${jobId}] Fallback TTS completed`);
      resolve(outputPath);
    });
  });
};

const createSilence = async (outputPath, duration) => {
  return new Promise((resolve, reject) => {
    const silenceCommand = `ffmpeg -f lavfi -i "anullsrc=r=16000:cl=mono" -t ${duration} -y "${outputPath}"`;
    
    exec(silenceCommand, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(outputPath);
      }
    });
  });
};

const concatenateAudioFiles = async (audioFiles, outputPath, jobId) => {
  return new Promise((resolve, reject) => {
    if (audioFiles.length === 1) {
      fs.copyFileSync(audioFiles[0], outputPath);
      resolve(outputPath);
      return;
    }

    const fileListPath = `./uploads/temp_${jobId}_filelist.txt`;
    const fileListContent = audioFiles.map(file => `file '${path.resolve(file)}'`).join('\n');
    
    fs.writeFileSync(fileListPath, fileListContent);

    const concatCommand = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy -y "${outputPath}"`;

    exec(concatCommand, { timeout: 120000 }, (error, stdout, stderr) => {
      try {
        if (fs.existsSync(fileListPath)) fs.unlinkSync(fileListPath);
      } catch (cleanupError) {}

      if (error) {
        reject(error);
      } else {
        resolve(outputPath);
      }
    });
  });
};

const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    const ffprobeCommand = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`;
    
    exec(ffprobeCommand, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 0 : duration);
      }
    });
  });
};

export { 
  generatePhonemeControlledTTS, 
  generateSegmentedPhoneTTS, 
  adjustToExactDuration 
};
