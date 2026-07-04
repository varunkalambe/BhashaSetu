import fs from 'fs';
import path from 'path';

// Import the functions we need to re-run from your services
import { assembleVideoWithCaptions } from './services/videoService.js';
import { alignTranslatedAudio } from './services/audioService.js';

/**
 * Resumes a failed job from the translated alignment or video assembly step.
 * @param {string} jobId The ID of the job to resume.
 */
const resumeJob = async (jobId) => {
  console.log(`▶️  Attempting to resume job from alignment step: ${jobId}`);

  try {
    // --- Step 1: Load the Translation Data ---
    const translationPath = path.join('uploads', 'translations', `${jobId}_translation.json`);
    console.log(`   Loading translation data from: ${translationPath}`);
    if (!fs.existsSync(translationPath)) {
      throw new Error(`Translation file not found. Cannot resume.`);
    }
    const translation = JSON.parse(fs.readFileSync(translationPath, 'utf8'));
    console.log(`   ✅ Translation data loaded successfully.`);
    
    // --- Step 2: Find the Translated Audio File ---
    const translatedAudioPath = path.join('uploads', 'translated_audio', `${jobId}_translated.wav`);
    console.log(`   Finding translated audio at: ${translatedAudioPath}`);
     if (!fs.existsSync(translatedAudioPath)) {
      throw new Error(`Translated audio file not found. Make sure TTS completed successfully.`);
    }
    console.log(`   ✅ Translated audio found.`);

    // --- Step 3: Run the Missing Alignment Step ---
    console.log(`\n🚀 Performing alignment on translated audio...`);
    const translatedAlignmentData = await alignTranslatedAudio(translatedAudioPath, jobId, translation.language);

    // --- Step 4: Call the Final Assembly Function ---
    console.log(`\n🚀 Calling 'assembleVideoWithCaptions' with all required data...`);
    const finalVideoResult = await assembleVideoWithCaptions(
      jobId,
      translatedAlignmentData,
      translation,
      null // lipSyncData
    );

    console.log(`\n🎉 Job resumed and completed successfully!`);
    console.log(`   Final video path: ${finalVideoResult.outputPath}`);

  } catch (error) {
    console.error(`\n❌ Failed to resume job ${jobId}.`);
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack Trace: ${error.stack}`);
  }
};

// --- Script Execution ---
const jobId = process.argv[2]; 

if (!jobId) {
  console.error('Error: Please provide a Job ID to resume.');
  console.error('Usage: node resumeJob.js <YOUR_JOB_ID>');
  process.exit(1);
}

resumeJob(jobId);



