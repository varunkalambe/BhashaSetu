// routes/processRoutes.js

// ===== IMPORT REQUIRED MODULES =====
import express from 'express';
import { getProcessingStatus } from '../controllers/processController.js';
import Upload from '../models/uploadModel.js';


const router = express.Router();

// ===== MAIN STATUS ENDPOINT =====
/**
 * GET /api/process/status/:jobId
 * Get current processing status for a specific job
 * Called by frontend to check processing progress
 * Returns detailed status information including current step, timestamps, and file paths
 */
router.get('/status/:jobId', getProcessingStatus);


/**
 * POST /api/process/start/:jobId
 * Manually start/trigger processing for an uploaded video
 */
router.post('/start/:jobId', async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const { sourceLanguage, targetLanguage, fromLang, toLang } = req.body;
    
    console.log(`🚀 [${jobId}] Manual processing trigger requested`);
    
    const video = await Upload.findById(jobId);
    
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        jobId: jobId
      });
    }
    
    if (video.processing_status === 'processing') {
      return res.status(400).json({
        success: false,
        error: 'Job is already processing',
        jobId: jobId
      });
    }
    
    if (video.processing_status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Job already completed',
        jobId: jobId
      });
    }
    
    const options = {
      sourceLanguage: sourceLanguage || fromLang || video.sourceLanguage || video.source_language || 'hi',
      targetLanguage: targetLanguage || toLang || video.targetLanguage || video.target_language
    };
    
    if (!options.targetLanguage) {
      return res.status(400).json({
        success: false,
        error: 'Target language not specified'
      });
    }
    
    console.log(`🚀 [${jobId}] Starting: ${options.sourceLanguage} → ${options.targetLanguage}`);
    
    const { processVideo } = await import('../controllers/processController.js');
    
    processVideo(jobId, options).catch(error => {
      console.error(`❌ [${jobId}] Processing failed:`, error.message);
    });
    
    res.json({
      success: true,
      jobId: jobId,
      message: 'Processing started',
      status: 'processing',
      languages: options
    });
    
  } catch (error) {
    console.error('❌ Start processing error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to start processing',
      message: error.message
    });
  }
});



// ===== ADDITIONAL PROCESSING ENDPOINTS =====

/**
 * GET /api/process/jobs
 * Get list of all processing jobs (useful for admin dashboard)
 * Optional query parameters: status, limit, offset
 */
router.get('/jobs', async (req, res) => {
  try {
    console.log('📋 Jobs list requested');
    
    const { status, limit = 50, offset = 0 } = req.query;
    
    // Build query filter
    const filter = {};
    if (status) {
      filter.processing_status = status;
    }
    
    // Get jobs with pagination using Mongoose
    const jobs = await Upload.find(filter)
      .sort({ createdAt: -1 })  // Newest first
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .select('_id processing_status processing_step originalName target_language createdAt completed_at processing_started_at processing_duration_ms')
      .lean();
    
    // Get total count for pagination
    const totalCount = await Upload.countDocuments(filter);
    
    console.log(`📋 Found ${jobs.length} jobs (${totalCount} total)`);
    
    res.json({
      success: true,
      jobs: jobs.map(job => ({
        jobId: job._id,
        status: job.processing_status,
        step: job.processing_step || 'queued',
        filename: job.originalName,
        target_language: job.target_language,
        created_at: job.createdAt,
        completed_at: job.completed_at || null,
        processing_duration: job.processing_duration_ms || (
          job.completed_at && job.processing_started_at 
            ? job.completed_at - job.processing_started_at 
            : null
        ),
        // Add progress percentage using virtual field
        progress_percentage: (() => {
          const steps = ['pending', 'audio_extraction', 'transcription', 'translation', 'tts_generation', 'caption_generation', 'video_assembly', 'completed'];
          const currentStepIndex = steps.indexOf(job.processing_step);
          return currentStepIndex >= 0 ? Math.round((currentStepIndex / (steps.length - 1)) * 100) : 0;
        })()
      })),
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + parseInt(limit) < totalCount
      }
    });
    
  } catch (error) {
    console.error('❌ Jobs list error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve jobs list',
      message: error.message
    });
  }
});

/**
 * GET /api/process/status/:jobId/detailed
 * Get detailed processing status with full metadata
 * Includes file paths, processing stats, error details, etc.
 */
router.get('/status/:jobId/detailed', async (req, res) => {
  try {
    const jobId = req.params.jobId;
    console.log(`🔍 [${jobId}] Detailed status requested`);
    
    const video = await Upload.findById(jobId).lean();
    
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        jobId: jobId
      });
    }
    
    // ===== DETAILED STATUS RESPONSE =====
    const detailedStatus = {
      success: true,
      jobId: video._id,
      
      // ===== BASIC STATUS INFO =====
      status: video.processing_status,
      step: video.processing_step || 'queued',
      progress_percentage: (() => {
        const steps = ['pending', 'audio_extraction', 'transcription', 'translation', 'tts_generation', 'caption_generation', 'video_assembly', 'completed'];
        const currentStepIndex = steps.indexOf(video.processing_step);
        return currentStepIndex >= 0 ? Math.round((currentStepIndex / (steps.length - 1)) * 100) : 0;
      })(),
      
      // ===== TIMESTAMPS =====
      timestamps: {
        created_at: video.createdAt,
        processing_started_at: video.processing_started_at || null,
        transcription_completed_at: video.transcription_completed_at || null,
        translation_completed_at: video.translation_completed_at || null,
        tts_completed_at: video.tts_completed_at || null,
        captions_completed_at: video.captions_completed_at || null,
        video_assembly_completed_at: video.video_assembly_completed_at || null,
        completed_at: video.completed_at || null,
        failed_at: video.failed_at || null,
        cancelled_at: video.cancelled_at || null,
        updated_at: video.updatedAt || null
      },
      
      // ===== FILE INFORMATION =====
      files: {
        original_filename: video.originalName,
        original_file_path: video.file_path,
        audio_file_path: video.audioOutputPath || null,
        tts_audio_path: video.tts_audio_path || null,
        caption_file_path: video.caption_file_path || null,
        transcript_file_path: video.transcript_file_path || null,
        processed_file_path: video.processed_file_path || null
      },
      
      // ===== LANGUAGE INFO =====
      languages: {
        target_language: video.target_language,
        detected_language: video.detected_language || null,
        source_language: video.source_language || null
      },
      
      // ===== PROCESSING STATS =====
      stats: {
        file_size: video.size || 0,
        processed_file_size: video.processed_file_size || 0,
        tts_text_length: video.tts_text_length || 0,
        processing_duration_ms: video.processing_duration_ms || 0,
        audio_extracted: video.audioExtracted || false
      },
      
      // ===== SERVICE INFO =====
      services: {
        processing_service: video.processing_service || null,
        video_codec: video.video_codec || null,
        audio_codec: video.audio_codec || null,
        video_resolution: video.video_resolution || null,
        has_embedded_captions: video.has_embedded_captions || false
      },
      
      // ===== ERROR INFORMATION (IF ANY) =====
      errors: {
        error_message: video.error_message || null,
        error_details: video.error_details || null,
        error_messages: video.errorMessages || [],
        video_assembly_error: video.video_assembly_error || null
      },
      
      // ===== CONTENT =====
      content: {
        transcription_text: video.transcriptionText || null,
        translated_text: video.translatedText || null
      }
    };
    
    console.log(`🔍 [${jobId}] Detailed status: ${detailedStatus.status} (${detailedStatus.step})`);
    
    res.json(detailedStatus);
    
  } catch (error) {
    console.error(`❌ Detailed status error:`, error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to get detailed status',
      message: error.message
    });
  }
});

/**
 * GET /api/process/stats
 * Get overall processing statistics
 * Useful for admin dashboard and monitoring
 */
router.get('/stats', async (req, res) => {
  try {
    console.log('📊 Processing stats requested');
    
    // ===== AGGREGATE PROCESSING STATISTICS =====
    const stats = await Promise.all([
      // Total jobs by status using Mongoose aggregation
      Upload.aggregate([
        {
          $group: {
            _id: '$processing_status',
            count: { $sum: 1 }
          }
        }
      ]),
      
      // Jobs by target language
      Upload.aggregate([
        {
          $group: {
            _id: '$target_language',
            count: { $sum: 1 }
          }
        }
      ]),
      
      // Processing time statistics (completed jobs only)
      Upload.aggregate([
        {
          $match: {
            processing_status: 'completed',
            processing_started_at: { $exists: true },
            completed_at: { $exists: true }
          }
        },
        {
          $project: {
            processing_time: {
              $subtract: ['$completed_at', '$processing_started_at']
            }
          }
        },
        {
          $group: {
            _id: null,
            avg_processing_time: { $avg: '$processing_time' },
            min_processing_time: { $min: '$processing_time' },
            max_processing_time: { $max: '$processing_time' },
            total_completed: { $sum: 1 }
          }
        }
      ]),
      
      // Recent activity (last 24 hours)
      Upload.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }),
      
      // Processing steps distribution
      Upload.aggregate([
        {
          $group: {
            _id: '$processing_step',
            count: { $sum: 1 }
          }
        }
      ])
    ]);
    
    // ===== FORMAT STATISTICS RESPONSE =====
    const [statusStats, languageStats, timeStats, recentActivity, stepStats] = stats;
    
    const formattedStats = {
      success: true,
      
      // Status breakdown
      status_distribution: statusStats.reduce((acc, stat) => {
        acc[stat._id || 'unknown'] = stat.count;
        return acc;
      }, {}),
      
      // Language popularity
      language_distribution: languageStats.reduce((acc, stat) => {
        acc[stat._id || 'unknown'] = stat.count;
        return acc;
      }, {}),
      
      // Processing steps distribution
      step_distribution: stepStats.reduce((acc, stat) => {
        acc[stat._id || 'unknown'] = stat.count;
        return acc;
      }, {}),
      
      // Performance metrics
      performance: timeStats[0] ? {
        average_processing_time_ms: Math.round(timeStats[0].avg_processing_time),
        fastest_processing_time_ms: timeStats[0].min_processing_time,
        slowest_processing_time_ms: timeStats[0].max_processing_time,
        total_completed_jobs: timeStats[0].total_completed,
        // Human readable formats
        average_processing_time_formatted: formatDuration(timeStats[0].avg_processing_time),
        fastest_processing_time_formatted: formatDuration(timeStats[0].min_processing_time),
        slowest_processing_time_formatted: formatDuration(timeStats[0].max_processing_time)
      } : null,
      
      // Activity metrics
      activity: {
        jobs_last_24h: recentActivity,
        generated_at: new Date()
      }
    };
    
    console.log(`📊 Stats generated: ${JSON.stringify(formattedStats.status_distribution)}`);
    
    res.json(formattedStats);
    
  } catch (error) {
    console.error('❌ Stats generation error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to generate statistics',
      message: error.message
    });
  }
});

/**
 * POST /api/process/jobs/:jobId/cancel
 * Cancel a processing job (if still in progress)
 * Note: This is a placeholder - actual cancellation would require more complex logic
 */
router.post('/jobs/:jobId/cancel', async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const { reason = 'User requested cancellation' } = req.body;
    console.log(`🚫 [${jobId}] Job cancellation requested`);
    
    const video = await Upload.findById(jobId);
    
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        jobId: jobId
      });
    }
    
    // Check if job can be cancelled
    if (video.processing_status === 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel completed job',
        jobId: jobId,
        status: video.processing_status
      });
    }
    
    if (video.processing_status === 'failed') {
      return res.status(400).json({
        success: false,
        error: 'Job already failed',
        jobId: jobId,
        status: video.processing_status
      });
    }
    
    if (video.processing_status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Job already cancelled',
        jobId: jobId,
        status: video.processing_status
      });
    }
    
    // ===== MARK JOB AS CANCELLED =====
    await Upload.findByIdAndUpdate(jobId, {
      processing_status: 'cancelled',
      processing_step: 'cancelled',
      cancelled_at: new Date(),
      cancellation_reason: reason,
      updatedAt: new Date()
    });
    
    console.log(`🚫 [${jobId}] Job marked as cancelled`);
    
    res.json({
      success: true,
      jobId: jobId,
      status: 'cancelled',
      message: 'Job cancellation requested',
      cancelled_at: new Date(),
      reason: reason
    });
    
  } catch (error) {
    console.error('❌ Job cancellation error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel job',
      message: error.message
    });
  }
});

/**
 * DELETE /api/process/jobs/:jobId
 * Delete a job and its associated files
 * Only works for completed, failed, or cancelled jobs
 */
router.delete('/jobs/:jobId', async (req, res) => {
  try {
    const jobId = req.params.jobId;
    console.log(`🗑️ [${jobId}] Job deletion requested`);
    
    const video = await Upload.findById(jobId);
    
    if (!video) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        jobId: jobId
      });
    }
    
    // Check if job can be deleted
    if (video.processing_status === 'processing') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete job that is currently processing',
        jobId: jobId,
        status: video.processing_status
      });
    }
    
    // Delete the job record
    await Upload.findByIdAndDelete(jobId);
    
    console.log(`🗑️ [${jobId}] Job deleted successfully`);
    
    res.json({
      success: true,
      jobId: jobId,
      message: 'Job deleted successfully',
      deleted_at: new Date()
    });
    
  } catch (error) {
    console.error('❌ Job deletion error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to delete job',
      message: error.message
    });
  }
});

// ===== HEALTH CHECK ENDPOINT =====
/**
 * GET /api/process/health
 * Simple health check for the processing system
 */
router.get('/health', async (req, res) => {
  try {
    // Check database connectivity using Mongoose
    await Upload.findOne({}, { _id: 1 }).limit(1);
    
    // Get basic system stats
    const totalJobs = await Upload.countDocuments();
    const activeJobs = await Upload.countDocuments({ processing_status: 'processing' });
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date(),
      services: {
        database: 'connected',
        processing_pipeline: 'operational'
      },
      stats: {
        total_jobs: totalJobs,
        active_jobs: activeJobs
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      timestamp: new Date(),
      error: error.message
    });
  }
});

// ===== UTILITY FUNCTIONS =====

/**
 * Format duration from milliseconds to human readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - Formatted duration
 */
function formatDuration(ms) {
  if (!ms) return '0s';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// ===== ERROR HANDLING MIDDLEWARE =====
router.use((error, req, res, next) => {
  console.error('🔥 Process route error:', error);
  
  res.status(500).json({
    success: false,
    error: 'Internal server error in processing routes',
    message: error.message,
    timestamp: new Date()
  });
});

// ===== EXPORT ROUTER =====
export default router;
