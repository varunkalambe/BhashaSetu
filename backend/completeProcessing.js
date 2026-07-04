// completeProcessing.js - Fixed to work with CommonJS services
import { resumeFromTTSStep } from './services/ttsService.js';
import connectDB from './config/db.js';
import Upload from './models/uploadModel.js';
import dotenv from 'dotenv';
import { createRequire } from 'module';

// Create require for CommonJS modules in ES6 environment
const require = createRequire(import.meta.url);

dotenv.config();

const JOB_ID = '68d403a075ed1a5cf8543db3';

async function completeProcessing() {
  try {
    console.log('🚀 Starting Complete Processing from TTS...');
    console.log(`📋 Target Job ID: ${JOB_ID}`);
    
    // Connect to database using your existing db.js
    await connectDB();
    console.log('✅ MongoDB Connected');
    
    // Step 4: TTS Generation (Fixed with corrected Edge-TTS)
    console.log(`[${JOB_ID}] Step 4/6: Generating speech in target language...`);
    const ttsResult = await resumeFromTTSStep(JOB_ID);
    console.log(`[${JOB_ID}] ✅ Speech generation completed: ${ttsResult.ttsAudioPath}`);
    
    // Get updated job data
    const jobData = await Upload.findById(JOB_ID);
    if (!jobData) {
      throw new Error(`Job ${JOB_ID} not found in database`);
    }
    
    console.log(`[${JOB_ID}] Job data retrieved:`);
    console.log(`[${JOB_ID}]   Original file: ${jobData.original_filename}`);
    console.log(`[${JOB_ID}]   Status: ${jobData.status}`);
    console.log(`[${JOB_ID}]   Translated segments: ${jobData.translated_segments ? jobData.translated_segments.length : 0}`);
    
    // Step 5: Caption Generation - Import CommonJS captionService
    console.log(`[${JOB_ID}] Step 5/6: Creating captions and transcript files...`);
    try {
      const captionService = require('./services/captionService.js');
      // Check what functions are available in captionService
      console.log(`[${JOB_ID}] Available caption functions:`, Object.keys(captionService));
      
      // Try different possible function names
      if (captionService.generateCaptions) {
        await captionService.generateCaptions(jobData, JOB_ID);
      } else if (captionService.createCaptions) {
        await captionService.createCaptions(jobData, JOB_ID);
      } else {
        // Manual caption generation if function not found
        await generateCaptionsManually(jobData, JOB_ID);
      }
    } catch (captionError) {
      console.warn(`[${JOB_ID}] ⚠️ Caption service error: ${captionError.message}`);
      console.log(`[${JOB_ID}] Generating captions manually...`);
      await generateCaptionsManually(jobData, JOB_ID);
    }
    console.log(`[${JOB_ID}] ✅ Caption generation completed`);
    
    // Step 6: Video Assembly - Import CommonJS videoService
    console.log(`[${JOB_ID}] Step 6/6: Assembling final translated video with captions...`);
    try {
      const videoService = require('./services/videoService.js');
      console.log(`[${JOB_ID}] Available video functions:`, Object.keys(videoService));
      
      let finalVideoPath;
      // Use the correct function name from your videoService.js
      if (videoService.assembleVideoWithCaptions) {
        finalVideoPath = await videoService.assembleVideoWithCaptions(JOB_ID);
      } else if (videoService.assembleVideoWithAudioOnly) {
        finalVideoPath = await videoService.assembleVideoWithAudioOnly(JOB_ID);
      } else {
        // Manual video assembly if function not found
        finalVideoPath = await assembleVideoManually(jobData, JOB_ID);
      }
      
      console.log(`[${JOB_ID}] ✅ Video assembly completed: ${finalVideoPath}`);
      
      // Update final status
      await Upload.findByIdAndUpdate(JOB_ID, {
        status: 'completed',
        processed_video_path: finalVideoPath,
        completed_at: new Date()
      });
      
      console.log(`[${JOB_ID}] 🎉 PROCESSING COMPLETED SUCCESSFULLY!`);
      console.log(`[${JOB_ID}] Final video ready: ${finalVideoPath}`);
      
    } catch (videoError) {
      console.error(`[${JOB_ID}] ❌ Video assembly failed:`, videoError.message);
      throw videoError;
    }
    
    // Show final file locations
    const finalJobData = await Upload.findById(JOB_ID);
    console.log(`\n📁 Final Output Files:`);
    console.log(`   🎥 Final Video: ${finalJobData.processed_video_path}`);
    console.log(`   🔊 TTS Audio: ${finalJobData.tts_audio_path}`);
    console.log(`   📝 Captions (WebVTT): ${finalJobData.caption_vtt_path || 'Generated manually'}`);
    console.log(`   📝 Subtitles (SRT): ${finalJobData.caption_srt_path || 'Generated manually'}`);
    console.log(`   📄 Transcript: ${finalJobData.transcript_path || 'Generated manually'}`);
    
    process.exit(0);
    
  } catch (error) {
    console.error(`[${JOB_ID}] ❌ Complete processing failed:`, error.message);
    console.error(`[${JOB_ID}] Full error stack:`, error.stack);
    
    // Update database with error status
    try {
      await Upload.findByIdAndUpdate(JOB_ID, {
        status: 'error',
        $push: { errorMessages: `Complete processing failed: ${error.message}` }
      });
      console.log(`[${JOB_ID}] ✅ Error status saved to database`);
    } catch (dbError) {
      console.error(`[${JOB_ID}] ❌ Failed to update error in database:`, dbError.message);
    }
    
    process.exit(1);
  }
}

// Manual caption generation function (fallback)
async function generateCaptionsManually(jobData, jobId) {
  const fs = require('fs');
  const path = require('path');
  
  try {
    console.log(`[${jobId}] Generating captions manually...`);
    
    const segments = jobData.translated_segments || [];
    const targetLanguage = jobData.target_language;
    
    const outputDir = './uploads/captions/';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Generate WebVTT captions
    const vttContent = generateVTTFromWordTimings(wordTimings, translatedSegments);
    const vttPath = path.join(outputDir, `${jobId}_captions.vtt`);
    fs.writeFileSync(vttPath, vttContent);
    
    // Generate SRT captions
    const srtContent = generateSRT(segments);
    const srtPath = path.join(outputDir, `${jobId}_captions.srt`);
    fs.writeFileSync(srtPath, srtContent);
    
    // Generate plain text transcript
    const transcriptContent = segments.map(seg => seg.text).join(' ');
    const transcriptPath = path.join(outputDir, `${jobId}_transcript.txt`);
    fs.writeFileSync(transcriptPath, transcriptContent);
    
    // Update database
    await Upload.findByIdAndUpdate(jobId, {
      caption_vtt_path: vttPath,
      caption_srt_path: srtPath,
      transcript_path: transcriptPath,
      captions_completed_at: new Date()
    });
    
    console.log(`[${jobId}] ✅ Manual captions generated:`);
    console.log(`[${jobId}]    WebVTT: ${vttPath}`);
    console.log(`[${jobId}]    SRT: ${srtPath}`);
    console.log(`[${jobId}]    Transcript: ${transcriptPath}`);
    
  } catch (error) {
    console.error(`[${jobId}] Manual caption generation failed:`, error.message);
    throw error;
  }
}

// Manual video assembly function (fallback)
async function assembleVideoManually(jobData, jobId) {
  const { exec } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  
  return new Promise((resolve, reject) => {
    try {
      console.log(`[${jobId}] Assembling video manually...`);
      
      const originalVideo = jobData.original_file_path;
      const translatedAudio = jobData.tts_audio_path;
      const captionFile = `./uploads/captions/${jobId}_captions.vtt`;
      
      const outputDir = './uploads/processed/';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const finalVideoPath = path.join(outputDir, `${jobId}_final.mp4`);
      
      // FFmpeg command to combine video, audio, and captions
      const ffmpegCommand = `ffmpeg -i "${originalVideo}" -i "${translatedAudio}" -i "${captionFile}" -c:v copy -c:a aac -c:s webvtt -map 0:v:0 -map 1:a:0 -map 2:s:0 -shortest -y "${finalVideoPath}"`;
      
      console.log(`[${jobId}] Manual assembly command: ${ffmpegCommand}`);
      
      exec(ffmpegCommand, { 
        maxBuffer: 1024 * 1024 * 200, // 200MB buffer
        timeout: 300000 // 5 minute timeout
      }, (error, stdout, stderr) => {
        
        if (error) {
          console.error(`[${jobId}] Manual video assembly failed:`, error.message);
          reject(error);
          return;
        }
        
        if (stderr) {
          console.log(`[${jobId}] FFmpeg warnings:`, stderr);
        }
        
        // Verify output file exists
        if (!fs.existsSync(finalVideoPath)) {
          reject(new Error(`Final video not created: ${finalVideoPath}`));
          return;
        }
        
        const fileStats = fs.statSync(finalVideoPath);
        console.log(`[${jobId}] Manual assembly completed: ${Math.round(fileStats.size / 1024 / 1024)} MB`);
        
        resolve(finalVideoPath);
      });
      
    } catch (error) {
      console.error(`[${jobId}] Manual video assembly setup failed:`, error.message);
      reject(error);
    }
  });
}

// Helper: Generate WebVTT content
function generateWebVTT(segments, language) {
  let vtt = 'WEBVTT\n\n';
  
  segments.forEach((segment, index) => {
    const startTime = formatTime(segment.start || 0);
    const endTime = formatTime(segment.end || 0);
    vtt += `${startTime} --> ${endTime}\n`;
    vtt += `${segment.text}\n\n`;
  });
  
  return vtt;
}

// Helper: Generate SRT content
function generateSRT(segments) {
  let srt = '';
  
  segments.forEach((segment, index) => {
    const startTime = formatSRTTime(segment.start || 0);
    const endTime = formatSRTTime(segment.end || 0);
    srt += `${index + 1}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${segment.text}\n\n`;
  });
  
  return srt;
}

// Helper: Format time for WebVTT
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

// Helper: Format time for SRT
function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Handle script termination gracefully
process.on('SIGINT', () => {
  console.log('\n⚠️ Processing interrupted by user (Ctrl+C)');
  process.exit(1);
});

console.log('🔧 Complete Processing Script Initialized (CommonJS Compatible)');
console.log('🎯 Target Job ID:', JOB_ID);
console.log('📦 Services: ttsService (ES6), captionService (CommonJS), videoService (CommonJS)');
console.log('⏳ Starting processing...\n');

// Run the complete processing
completeProcessing();
