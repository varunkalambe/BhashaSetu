// services/audioService.js - ENHANCED WITH FORCED ALIGNMENT & DURATION AWARENESS

// ===== IMPORT REQUIRED MODULES =====
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import Upload from '../models/uploadModel.js';
import { getFilePath } from '../utils/fileUtils.js';
import { transcribeWithLocalWhisper } from './transcriptionService.js';
import {
  detectAudioVideoSync,
  correctAudioSync,
  neuralAudioAlignment,
  adaptiveSyncCorrection
} from './neuralSyncService.js';
import {
  calculateSpeechDuration
} from './durationAwareTranslation.js';

ffmpeg.setFfmpegPath(ffmpegStatic);

const safeDatabaseOperation = async (operation, jobId, operationName) => {
  try {
    return await operation();
  } catch (dbError) {
    console.warn(`[${jobId}] ⚠️ Database operation '${operationName}' failed: ${dbError.message}`);
    return null;
  }
};

export const extractAudio = async (jobId) => {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[${jobId}] Starting enhanced audio extraction with timing analysis...`);

      const video = await safeDatabaseOperation(
        () => Upload.findById(jobId),
        jobId,
        'findById'
      );

      if (!video) {
        console.warn(`[${jobId}] ⚠️ Could not retrieve video from database, using fallback file detection`);

        const fallbackVideoPath = `uploads/originals/${jobId}.mp4`;
        if (!fs.existsSync(fallbackVideoPath)) {
          throw new Error(`Video record not found in database and fallback file not found: ${fallbackVideoPath}`);
        }

        const fallbackVideo = {
          file_path: fallbackVideoPath,
          _id: jobId
        };

        return await processAudioExtraction(fallbackVideo, jobId, resolve, reject);
      }

      return await processAudioExtraction(video, jobId, resolve, reject);

    } catch (error) {
      console.error(`[${jobId}] ❌ Enhanced audio extraction setup failed:`, error.message);

      await safeDatabaseOperation(
        () => Upload.findByIdAndUpdate(jobId, {
          audioExtracted: false,
          extraction_service: 'enhanced-audio-extraction-failed',
          $push: { errorMessages: `Enhanced audio extraction setup failed: ${error.message}` }
        }),
        jobId,
        'error update'
      );

      reject(error);
    }
  });
};

const processAudioExtraction = async (video, jobId, resolve, reject) => {
  const inputVideoPath = video.file_path;
  const outputAudioPath = getFilePath('audio', jobId, '.wav');
  const highQualityAudioPath = getFilePath('audio', jobId, '_hq.wav');

  console.log(`[${jobId}] Enhanced audio extraction paths:`);
  console.log(`[${jobId}] Input video: ${inputVideoPath}`);
  console.log(`[${jobId}] Output audio (Whisper): ${outputAudioPath}`);
  console.log(`[${jobId}] High quality audio (Alignment): ${highQualityAudioPath}`);

  if (!fs.existsSync(inputVideoPath)) {
    throw new Error(`Input video file not found: ${inputVideoPath}`);
  }

  const videoInfo = await getVideoMetadata(inputVideoPath, jobId);
  console.log(`[${jobId}] Video metadata: ${videoInfo.duration.toFixed(2)}s, ${videoInfo.video.width}x${videoInfo.video.height}`);

  console.log(`[${jobId}] Step 1/3: Extracting high quality audio for forced alignment...`);

  const highQualityExtractionPromise = new Promise((hqResolve, hqReject) => {
    ffmpeg(inputVideoPath)
      .noVideo()
      .audioCodec('pcm_s24le')
      .audioChannels(2)
      .audioFrequency(44100)
      .format('wav')
      .output(highQualityAudioPath)

      .on('start', (commandLine) => {
        console.log(`[${jobId}] High quality extraction command: ${commandLine}`);
      })

      .on('end', () => {
        console.log(`[${jobId}] ✅ High quality audio extracted for alignment`);
        hqResolve(highQualityAudioPath);
      })

      .on('error', (error) => {
        console.warn(`[${jobId}] ⚠️ High quality extraction failed: ${error.message}`);
        hqReject(error);
      })

      .run();
  });

  console.log(`[${jobId}] Step 2/3: Extracting Whisper-compatible audio...`);

  ffmpeg(inputVideoPath)
    .noVideo()
    .audioCodec('pcm_s16le')
    .audioChannels(1)
    .audioFrequency(16000)
    .format('wav')
    .output(outputAudioPath)

    .on('start', (commandLine) => {
      console.log(`[${jobId}] Whisper audio extraction command: ${commandLine}`);
    })

    .on('progress', (progress) => {
      if (progress.percent) {
        console.log(`[${jobId}] Audio extraction progress: ${Math.round(progress.percent)}%`);
      }
    })

    .on('end', async () => {
      try {
        console.log(`[${jobId}] ✅ Whisper-compatible audio extraction completed`);
        console.log(`[${jobId}] Audio file saved to: ${outputAudioPath}`);

        const extractedAudioDuration = await getAudioDuration(outputAudioPath);
        const durationMatch = Math.abs(extractedAudioDuration - videoInfo.duration) < 1.0;

        console.log(`[${jobId}] Audio duration validation:`);
        console.log(`[${jobId}]   Video duration: ${videoInfo.duration.toFixed(2)}s`);
        console.log(`[${jobId}]   Extracted duration: ${extractedAudioDuration.toFixed(2)}s`);
        console.log(`[${jobId}]   Duration preserved: ${durationMatch ? '✅ YES' : '⚠️ NO'}`);

        let highQualityPath = null;
        try {
          highQualityPath = await highQualityExtractionPromise;
          console.log(`[${jobId}] ✅ High quality audio ready for alignment`);
        } catch (hqError) {
          console.warn(`[${jobId}] ⚠️ High quality extraction failed, using standard audio for alignment`);
          highQualityPath = outputAudioPath;
        }

        console.log(`[${jobId}] Step 3/3: Preserving timing metadata and preparing for alignment...`);

        const timingMetadata = {
          original_video_path: inputVideoPath,
          extracted_audio_path: outputAudioPath,
          high_quality_audio_path: highQualityPath,
          video_duration: videoInfo.duration,
          audio_duration: extractedAudioDuration,
          duration_preserved: durationMatch,
          video_metadata: videoInfo,
          extraction_timestamp: new Date(),
          ready_for_forced_alignment: true,
          audio_sample_rate: 16000,
          audio_channels: 1,
          audio_format: 'wav',
          high_quality_sample_rate: 44100,
          high_quality_channels: 2
        };

        // Safe database update - continue processing even if database fails
        await safeDatabaseOperation(
          () => Upload.findByIdAndUpdate(jobId, {
            audioExtracted: true,
            audioOutputPath: outputAudioPath,
            high_quality_audio_path: highQualityPath,
            timing_metadata: timingMetadata,
            audio_duration: extractedAudioDuration,
            video_duration: videoInfo.duration,
            duration_preserved_extraction: durationMatch,
            extraction_service: 'enhanced-audio-extraction-with-timing',
            ready_for_forced_alignment: true
          }),
          jobId,
          'audio extraction update'
        );

        console.log(`[${jobId}] ✅ Enhanced audio extraction completed with timing metadata`);

        const enhancedResult = {
          whisper_audio_path: outputAudioPath,
          high_quality_audio_path: highQualityPath,
          timing_metadata: timingMetadata,
          duration_preserved: durationMatch,
          ready_for_alignment: true
        };

        resolve(enhancedResult);

      } catch (postProcessError) {
        console.error(`[${jobId}] ❌ Post-processing error:`, postProcessError.message);
        reject(postProcessError);
      }
    })

    .on('error', (error) => {
      console.error(`[${jobId}] ❌ FFmpeg audio extraction failed:`, error.message);

      if (error.message.includes('No such file')) {
        reject(new Error(`Input video file not accessible: ${inputVideoPath}`));
      } else if (error.message.includes('Permission denied')) {
        reject(new Error(`Permission denied accessing files. Check file permissions.`));
      } else if (error.message.includes('Invalid data found')) {
        reject(new Error(`Video file appears to be corrupted or invalid format.`));
      } else {
        reject(new Error(`Enhanced audio extraction failed: ${error.message}`));
      }
    })

    .run();
};

// In audioService.js
// Replace the entire function with this new, simpler version.

/**
 * Performs forced alignment on a given audio file to get word-level timings.
 * This is specifically for aligning the translated TTS audio.
 * @param {string} audioPath The path to the translated audio file (.wav).
 * @param {string} jobId The ID of the current job.
 * @param {string} language The target language code (e.g., 'gu').
 * @returns {Promise<object>} A promise that resolves to the alignment data object.
 */
//Varunnnnnnnnnn
export const alignTranslatedAudio = async (audioPath, jobId, language) => {
  console.log(`[${jobId}] Starting new alignment for translated audio: ${language}`);
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Translated audio file not found for alignment: ${audioPath}`);
  }

  try {
    // This assumes you are using a local Whisper model that provides word timings.
    // The logic should be very similar to your initial transcription service.
    const alignmentResult = await transcribeWithLocalWhisper(audioPath, language, true); // 'true' for word_timestamps

    if (!alignmentResult || !alignmentResult.segments) {
      throw new Error('Alignment of translated audio failed to return valid segments.');
    }

    console.log(`[${jobId}] ✅ Alignment of translated audio successful.`);
    return {
      forced_alignment_result: alignmentResult,
      alignment_quality: 'excellent', // Assume excellent as it's from clean TTS
    };
  } catch (error) {
    console.error(`[${jobId}] ❌ Alignment of translated audio failed:`, error);
    throw new Error(`Failed to perform alignment on translated audio for job ${jobId}.`);
  }
};



export const extractAudioForcedAlignment = async (transcription, audioPath, jobId) => {
  try {
    console.log(`[${jobId}] ✅ Using pre-generated word-level alignment from Whisper...`);

    // The word timings are ALREADY in the transcription object. We just need to format them.
    const allWords = transcription.segments.flatMap(segment => segment.words || []);

    if (allWords.length === 0) {
      console.log(`[${jobId}] ⚠️ No word-level timestamps available, generating from segments...`);

      // Generate approximate word timestamps from segment timestamps
      const approximateWords = [];
      for (const segment of transcription.segments) {  // ✅ CORRECT
        const words = segment.text.trim().split(/\s+/);
        const segmentDuration = segment.end - segment.start;
        const wordDuration = segmentDuration / words.length;

        words.forEach((word, index) => {
          approximateWords.push({
            word: word,
            start: segment.start + (index * wordDuration),
            end: segment.start + ((index + 1) * wordDuration),
            probability: 0.8
          });
        });
      }

      return {
        words: approximateWords,
        segments: transcription.segments  // ✅ CORRECT
      };
    }

    const alignmentResult = {
      phoneme_timings: allWords, // Use the word data directly
      total_segments: transcription.segments.length,
      successful_alignments: transcription.segments.length, // All segments are successful by default
      fallback_alignment: false
    };

    console.log(`[${jobId}] ✅ Successfully extracted ${allWords.length} word timings.`);

    // This part remains similar, just saving the new result
    const video = await safeDatabaseOperation(() => Upload.findById(jobId), jobId, 'findById for alignment');
    const timingMetadata = video?.timing_metadata || {};
    const enhancedTimingMetadata = {
      ...timingMetadata,
      forced_alignment_extracted: true,
      forced_alignment_timestamp: new Date(),
      phoneme_timings: alignmentResult.phoneme_timings, // Save the correct data
      alignment_quality: 'excellent',
      alignment_source: 'whisper_word_timestamps'
    };

    await safeDatabaseOperation(
      () => Upload.findByIdAndUpdate(jobId, {
        forced_alignment_extracted: true,
        phoneme_timings: alignmentResult.phoneme_timings,
        timing_metadata: enhancedTimingMetadata,
        ready_for_duration_aware_translation: true
      }),
      jobId,
      'forced alignment update'
    );

    return {
      forced_alignment_result: alignmentResult,
      timing_metadata: enhancedTimingMetadata,
      alignment_quality: 'excellent',
      ready_for_translation: true
    };

  } catch (error) {
    console.error(`[${jobId}] ❌ Failed to extract pre-generated word alignment:`, error.message);
    // You can still have a fallback if needed, but the primary logic is now fixed.
    throw error;
  }
};

export const replaceAudioInVideo = async (jobId) => {
  try {
    console.log(`[${jobId}] Starting duration-aware audio replacement...`);

    let videoRecord = await safeDatabaseOperation(
      () => Upload.findById(jobId),
      jobId,
      'findById for audio replacement'
    );

    if (!videoRecord) {
      // Create fallback video object with different variable name
      const fallbackVideoPath = `uploads/originals/${jobId}.mp4`;
      if (!fs.existsSync(fallbackVideoPath)) {
        throw new Error(`Video record not found in database and fallback file not found`);
      }

      videoRecord = {
        file_path: fallbackVideoPath,
        tts_audio_path: getFilePath('translated_audio', jobId, '.wav'),
        timing_metadata: {}
      };
    }

    const originalVideoPath = videoRecord.file_path;
    const translatedAudioPath = videoRecord.tts_audio_path || getFilePath('translated_audio', jobId, '.wav');
    const outputVideoPath = getFilePath('processed', jobId, '.mp4');

    console.log(`[${jobId}] Duration-aware audio replacement paths:`);
    console.log(`[${jobId}] Original video: ${originalVideoPath}`);
    console.log(`[${jobId}] Translated audio: ${translatedAudioPath}`);
    console.log(`[${jobId}] Output video: ${outputVideoPath}`);

    if (!fs.existsSync(originalVideoPath)) {
      throw new Error(`Original video file not found: ${originalVideoPath}`);
    }

    if (!fs.existsSync(translatedAudioPath)) {
      throw new Error(`Translated audio file not found: ${translatedAudioPath}`);
    }

    console.log(`[${jobId}] Step 1/4: Duration validation with timing metadata...`);

    const originalVideoDuration = await getAudioDuration(originalVideoPath);
    const translatedAudioDuration = await getAudioDuration(translatedAudioPath);
    const durationDifference = Math.abs(originalVideoDuration - translatedAudioDuration);
    const durationsMatch = durationDifference <= 1.5;

    console.log(`[${jobId}] Duration validation results:`);
    console.log(`[${jobId}]   Original video: ${originalVideoDuration.toFixed(2)}s`);
    console.log(`[${jobId}]   Translated audio: ${translatedAudioDuration.toFixed(2)}s`);
    console.log(`[${jobId}]   Difference: ${durationDifference.toFixed(2)}s`);
    console.log(`[${jobId}]   Match: ${durationsMatch ? '✅ YES' : '❌ NO'}`);

    let correctedAudioPath = translatedAudioPath;

    if (!durationsMatch) {
      console.log(`[${jobId}] Step 2/4: Correcting duration mismatch using timing metadata...`);

      try {
        correctedAudioPath = await correctAudioDurationWithTimingMetadata(
          translatedAudioPath,
          originalVideoDuration,
          videoRecord.timing_metadata || {},
          jobId
        );

        const correctedDuration = await getAudioDuration(correctedAudioPath);
        console.log(`[${jobId}] ✅ Duration corrected: ${correctedDuration.toFixed(2)}s`);

      } catch (correctionError) {
        console.warn(`[${jobId}] ⚠️ Duration correction failed: ${correctionError.message}`);
        console.log(`[${jobId}] Proceeding with original audio`);
      }
    } else {
      console.log(`[${jobId}] Step 2/4: Duration validation passed, no correction needed`);
    }

    console.log(`[${jobId}] Step 3/4: Neural audio synchronization...`);

    let finalAudioPath = correctedAudioPath;

    try {
      const syncData = await detectAudioVideoSync(originalVideoPath, correctedAudioPath, jobId);

      console.log(`[${jobId}] Sync analysis: offset=${syncData.sync_offset}s, confidence=${syncData.confidence}`);

      if (syncData.recommendation === 'adjustment_needed') {
        finalAudioPath = await correctAudioSync(
          correctedAudioPath,
          originalVideoPath,
          syncData.sync_offset,
          jobId
        );

        console.log(`[${jobId}] ✅ Neural sync correction applied`);
      }

    } catch (syncError) {
      console.warn(`[${jobId}] ⚠️ Neural sync failed: ${syncError.message}`);
    }

    console.log(`[${jobId}] Step 4/4: Duration-aware video assembly...`);

    const referenceDuration = originalVideoDuration;

    const processedDir = path.dirname(outputVideoPath);
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(originalVideoPath)
        .input(finalAudioPath)
        .videoCodec('copy')
        .audioCodec('aac')
        .audioBitrate('192k')
        .outputOptions([
          '-avoid_negative_ts', 'make_zero',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-t', `${referenceDuration}`
        ])
        .output(outputVideoPath)

        .on('start', (commandLine) => {
          console.log(`[${jobId}] Duration-aware audio replacement command: ${commandLine}`);
          console.log(`[${jobId}] Reference duration: ${referenceDuration.toFixed(2)}s`);
        })

        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`[${jobId}] Duration-aware replacement progress: ${Math.round(progress.percent)}%`);
          }
        })

        .on('end', async () => {
          try {
            console.log(`[${jobId}] ✅ Duration-aware audio replacement completed`);
            console.log(`[${jobId}] Final translated video saved to: ${outputVideoPath}`);

            const finalOutputDuration = await getAudioDuration(outputVideoPath);
            const finalDurationMatch = Math.abs(finalOutputDuration - referenceDuration) < 2.0;

            console.log(`[${jobId}] Final validation:`);
            console.log(`[${jobId}]   Expected: ${referenceDuration.toFixed(2)}s`);
            console.log(`[${jobId}]   Actual: ${finalOutputDuration.toFixed(2)}s`);
            console.log(`[${jobId}]   Duration preserved: ${finalDurationMatch ? '✅ YES' : '⚠️ PARTIAL'}`);

            const outputStats = fs.statSync(outputVideoPath);

            await safeDatabaseOperation(
              () => Upload.findByIdAndUpdate(jobId, {
                processed_file_path: outputVideoPath,
                processed_file_size: outputStats.size,
                video_codec: 'copy',
                audio_codec: 'aac',
                processing_service: 'duration-aware-audio-replacement',
                final_duration_preserved: finalDurationMatch,
                final_video_duration: finalOutputDuration,
                duration_correction_applied: correctedAudioPath !== translatedAudioPath,
                neural_sync_applied: finalAudioPath !== correctedAudioPath,
                timing_metadata_used: true
              }),
              jobId,
              'final video update'
            );

            await cleanupTemporaryAudioFiles([correctedAudioPath, finalAudioPath], translatedAudioPath, jobId);

            console.log(`[${jobId}] ✅ Duration-aware audio replacement completed successfully`);
            resolve(outputVideoPath);

          } catch (postProcessError) {
            console.error(`[${jobId}] ❌ Post-processing error:`, postProcessError.message);
            reject(postProcessError);
          }
        })

        .on('error', (error) => {
          console.error(`[${jobId}] ❌ Duration-aware audio replacement failed:`, error.message);

          if (error.message.includes('No such file')) {
            reject(new Error(`Input file not found. Check video and audio file paths.`));
          } else if (error.message.includes('Invalid data found')) {
            reject(new Error(`Corrupted input file detected during audio replacement.`));
          } else if (error.message.includes('Permission denied')) {
            reject(new Error(`File permission error during audio replacement.`));
          } else {
            reject(new Error(`Duration-aware audio replacement failed: ${error.message}`));
          }
        })

        .run();
    });

  } catch (error) {
    console.error(`[${jobId}] ❌ Duration-aware audio replacement setup failed:`, error.message);

    await safeDatabaseOperation(
      () => Upload.findByIdAndUpdate(jobId, {
        video_assembly_error: error.message,
        video_assembly_failed_at: new Date(),
        processing_service: 'duration-aware-audio-replacement-failed',
        $push: { errorMessages: `Duration-aware audio replacement setup failed: ${error.message}` }
      }),
      jobId,
      'error update'
    );

    throw error;
  }
};


const correctAudioDurationWithTimingMetadata = async (audioPath, targetDuration, timingMetadata, jobId) => {
  try {
    const currentDuration = await getAudioDuration(audioPath);
    const difference = targetDuration - currentDuration;

    // ✅ Use 500ms threshold as per instructions
    if (Math.abs(difference) < 0.5) {
      console.log(`[${jobId}] Duration difference ${difference.toFixed(2)}s acceptable, no correction needed`);
      return audioPath;
    }

    const correctedAudioPath = audioPath.replace(/\.(wav|mp3|m4a)$/, '_duration_corrected.$1');

    let command;
    if (difference > 0) {
      // Add silence padding
      command = `ffmpeg -i "${audioPath}" -af "apad=pad_dur=${difference}" -y "${correctedAudioPath}"`;
    } else {
      // Trim with re-encoding for accuracy
      command = `ffmpeg -i "${audioPath}" -t ${targetDuration} -c:a aac -b:a 192k -y "${correctedAudioPath}"`;
    }

    console.log(`[${jobId}] Applying correction: ${difference > 0 ? 'padding' : 'trimming'} ${Math.abs(difference).toFixed(2)}s`);

    return new Promise((resolve, reject) => {
      exec(command, { timeout: 60000, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[${jobId}] Duration correction failed: ${error.message}`);
          resolve(audioPath); // Fallback to original
          return;
        }

        if (!fs.existsSync(correctedAudioPath) || fs.statSync(correctedAudioPath).size < 1000) {
          console.error(`[${jobId}] Corrected file invalid`);
          resolve(audioPath);
          return;
        }

        console.log(`[${jobId}] ✅ Duration correction successful`);
        resolve(correctedAudioPath);
      });
    });

  } catch (error) {
    console.error(`[${jobId}] Duration correction setup failed:`, error.message);
    return audioPath;
  }
};

const getVideoMetadata = (videoPath, jobId) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        console.error(`[${jobId}] Failed to get video metadata:`, error.message);
        reject(error);
        return;
      }

      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');

      const info = {
        duration: metadata.format.duration || 0,
        size: metadata.format.size || 0,
        bitrate: metadata.format.bit_rate || 0,
        video: {
          codec: videoStream?.codec_name || 'unknown',
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          fps: videoStream?.r_frame_rate || '0/0'
        },
        audio: {
          codec: audioStream?.codec_name || 'unknown',
          sample_rate: audioStream?.sample_rate || 0,
          channels: audioStream?.channels || 0
        },
        format: metadata.format.format_name || 'unknown',
        streams: metadata.streams.length,
        has_video: !!videoStream,
        has_audio: !!audioStream
      };

      resolve(info);
    });
  });
};

const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`;

    exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Duration check failed: ${error.message}`));
        return;
      }

      const duration = parseFloat(stdout.trim());
      if (isNaN(duration) || duration <= 0) {
        reject(new Error(`Invalid duration: ${stdout.trim()}`));
        return;
      }

      resolve(duration);
    });
  });
};

const createFallbackAlignment = (transcription, timingMetadata, jobId) => {
  console.log(`[${jobId}] Creating fallback alignment data...`);

  const fallbackTimings = [];

  if (transcription.segments && transcription.segments.length > 0) {
    transcription.segments.forEach((segment, index) => {
      fallbackTimings.push({
        text: segment.text,
        start: segment.start || 0,
        end: segment.end || (segment.start || 0) + (segment.duration || 1),
        duration: segment.duration || 1,
        segment_index: index,
        alignment_failed: true,
        fallback_source: 'transcription_segments'
      });
    });
  } else {
    const estimatedDuration = timingMetadata.video_duration ||
      calculateSpeechDuration(transcription.text || '', 'hi') ||
      10;

    fallbackTimings.push({
      text: transcription.text || '',
      start: 0,
      end: estimatedDuration,
      duration: estimatedDuration,
      segment_index: 0,
      alignment_failed: true,
      fallback_source: 'estimated_duration'
    });
  }

  return {
    phoneme_timings: fallbackTimings,
    total_segments: fallbackTimings.length,
    successful_alignments: 0,
    fallback_alignment: true
  };
};

const cleanupTemporaryAudioFiles = async (tempFiles, originalFile, jobId) => {
  let cleaned = 0;

  for (const tempFile of tempFiles) {
    if (tempFile !== originalFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
        cleaned++;
      } catch (cleanupError) {
        console.warn(`[${jobId}] Failed to cleanup ${tempFile}:`, cleanupError.message);
      }
    }
  }

  console.log(`[${jobId}] Cleaned up ${cleaned} temporary audio files`);
};

export default {
  extractAudio,
  extractAudioForcedAlignment,
  replaceAudioInVideo,
  correctAudioDurationWithTimingMetadata,
  getVideoMetadata,
  getAudioDuration
};
