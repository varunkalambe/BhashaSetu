// models/uploadModel.js

import mongoose from "mongoose";

const uploadSchema = new mongoose.Schema({
  // ===== BASIC FILE INFORMATION =====
  filename: String,
  originalName: String,
  size: Number,
  status: { type: String, default: "uploaded" },
  
  // ===== PROCESSING FIELDS FOR AUDIO PIPELINE =====
  file_path: String,  // Full path to uploaded file
  target_language: String,  // Language to translate to
  source_language: String,  // Original video language
  detected_language: String,  // Language detected by Whisper
  
  // ===== PROCESSING STATUS TRACKING =====
  processing_status: { type: String, default: "uploaded" }, // uploaded, processing, completed, failed, cancelled
  processing_step: { type: String, default: "pending" }, // audio_extraction, transcription, translation, etc.
  processing_started_at: Date,
  completed_at: Date,
  failed_at: Date,
  processing_duration_ms: Number,
  
  // ===== DETAILED PROCESSING TIMESTAMPS =====
  transcription_completed_at: Date,
  translation_completed_at: Date,
  tts_completed_at: Date,
  captions_completed_at: Date,
  video_assembly_completed_at: Date,
  
  // ===== FILE PATHS FOR PROCESSED CONTENT =====
  processed_file_path: String,  // Final translated video
  caption_file_path: String,    // WebVTT captions
  transcript_file_path: String, // Text transcript
  audioOutputPath: String,      // Extracted audio file path
  tts_audio_path: String,       // Generated TTS audio path
  
  // ===== PROCESSING CONTENT =====
  transcriptionText: String,    // Original transcribed text
  translatedText: String,       // Translated text
  tts_text_length: Number,      // Length of TTS text
  
  // ===== AUDIO PROCESSING FIELDS =====
  audioExtracted: { type: Boolean, default: false },
  
  // ===== VIDEO/AUDIO TECHNICAL INFO =====
  processed_file_size: Number,
  video_codec: String,
  audio_codec: String,
  video_resolution: String,
  has_embedded_captions: Boolean,
  
  // ===== SERVICE TRACKING =====
  processing_service: String,   // Which service processed (ffmpeg, whisper, etc.)
  
  // ===== ERROR HANDLING =====
  error_message: String,
  error_details: String,
  errorMessages: [String],
  video_assembly_error: String,
  video_assembly_failed_at: Date,
  
  // ===== CANCELLATION SUPPORT =====
  cancelled_at: Date,
  cancellation_reason: String,
  
  // ===== METADATA =====
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ===== MIDDLEWARE TO UPDATE 'updatedAt' ON SAVE =====
uploadSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

uploadSchema.pre(['updateOne', 'findOneAndUpdate', 'findByIdAndUpdate'], function(next) {
  this.set({ updatedAt: new Date() });
  next();
});

// ===== VIRTUAL FIELDS =====

// Get processing progress percentage
uploadSchema.virtual('progressPercentage').get(function() {
  const steps = ['pending', 'audio_extraction', 'transcription', 'translation', 'tts_generation', 'caption_generation', 'video_assembly', 'completed'];
  const currentStepIndex = steps.indexOf(this.processing_step);
  return currentStepIndex >= 0 ? Math.round((currentStepIndex / (steps.length - 1)) * 100) : 0;
});

// Check if processing is active
uploadSchema.virtual('isProcessing').get(function() {
  return this.processing_status === 'processing';
});

// Check if processing is complete
uploadSchema.virtual('isCompleted').get(function() {
  return this.processing_status === 'completed';
});

// Check if processing failed
uploadSchema.virtual('isFailed').get(function() {
  return this.processing_status === 'failed';
});

// Get human-readable processing duration
uploadSchema.virtual('processingDurationFormatted').get(function() {
  if (!this.processing_duration_ms) return null;
  
  const seconds = Math.floor(this.processing_duration_ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
});

// ===== INSTANCE METHODS =====

// Method to add error message
uploadSchema.methods.addError = function(errorMessage) {
  if (!this.errorMessages) {
    this.errorMessages = [];
  }
  this.errorMessages.push(`[${new Date().toISOString()}] ${errorMessage}`);
  return this.save();
};

// Method to update processing step with timestamp
uploadSchema.methods.updateStep = function(step, additionalData = {}) {
  this.processing_step = step;
  this.updatedAt = new Date();
  
  // Add step-specific timestamps
  const stepTimestamps = {
    'transcription': 'transcription_completed_at',
    'translation': 'translation_completed_at', 
    'tts_generation': 'tts_completed_at',
    'caption_generation': 'captions_completed_at',
    'video_assembly': 'video_assembly_completed_at',
    'completed': 'completed_at',
    'failed': 'failed_at'
  };
  
  if (stepTimestamps[step]) {
    this[stepTimestamps[step]] = new Date();
  }
  
  // Apply additional data
  Object.assign(this, additionalData);
  
  return this.save();
};

// Method to mark as failed
uploadSchema.methods.markFailed = function(errorMessage, errorDetails = null) {
  this.processing_status = 'failed';
  this.processing_step = 'failed';
  this.failed_at = new Date();
  this.error_message = errorMessage;
  if (errorDetails) {
    this.error_details = errorDetails;
  }
  this.addError(errorMessage);
  return this.save();
};

// Method to mark as completed
uploadSchema.methods.markCompleted = function(finalVideoPath = null) {
  this.processing_status = 'completed';
  this.processing_step = 'completed';
  this.completed_at = new Date();
  
  if (this.processing_started_at) {
    this.processing_duration_ms = new Date() - this.processing_started_at;
  }
  
  if (finalVideoPath) {
    this.processed_file_path = finalVideoPath;
  }
  
  return this.save();
};

// ===== STATIC METHODS =====

// Get processing statistics
uploadSchema.statics.getProcessingStats = function() {
  return this.aggregate([
    {
      $group: {
        _id: '$processing_status',
        count: { $sum: 1 },
        avgDuration: { $avg: '$processing_duration_ms' }
      }
    }
  ]);
};

// Cleanup old failed jobs
uploadSchema.statics.cleanupFailedJobs = function(daysOld = 7) {
  const cutoffDate = new Date(Date.now() - (daysOld * 24 * 60 * 60 * 1000));
  return this.deleteMany({
    processing_status: 'failed',
    failed_at: { $lt: cutoffDate }
  });
};

// Find jobs by status
uploadSchema.statics.findByStatus = function(status, limit = 50) {
  return this.find({ processing_status: status })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// ===== INDEXES FOR PERFORMANCE =====
uploadSchema.index({ processing_status: 1 });
uploadSchema.index({ createdAt: -1 });
uploadSchema.index({ processing_started_at: 1 });
uploadSchema.index({ target_language: 1 });

// ===== EXPORT MODEL - FIXED TO PREVENT OVERWRITE ERROR =====
export default mongoose.models.Upload || mongoose.model("Upload", uploadSchema);
