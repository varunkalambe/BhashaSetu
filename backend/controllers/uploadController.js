// controllers/uploadController.js - ENHANCED UPLOAD CONTROLLER WITH FIXED LANGUAGE EXTRACTION
console.log('🔥 uploadController.js loaded successfully');

import Upload from "../models/uploadModel.js";
import { processVideo } from "../controllers/processController.js";
import fs from 'fs';
import path from 'path';

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

// ===== VALIDATE SUPPORTED LANGUAGES =====
const validateLanguage = (languageCode, type = 'language') => {
  const supportedLanguages = [
    'hi', 'bn', 'ta', 'te', 'mr', 'gu', 
    'kn', 'ml', 'pa', 'ur', 'en'
  ];
  
  return supportedLanguages.includes(languageCode);
};

// ===== MAIN UPLOAD FUNCTION - FIXED LANGUAGE EXTRACTION =====
export const uploadVideo = async (req, res) => {
  try {
    const file = req.file;
    
    // ✅ ENHANCED: Extract language parameters with multiple fallback keys
    const fromLang = req.body.fromLang || 
                     req.body.sourceLang || 
                     req.body.sourceLanguage || 
                     req.body.source_language ||
                     'hi'; // Default to Hindi as source
                     
    const toLang = req.body.toLang || 
                   req.body.targetLang || 
                   req.body.targetLanguage ||
                   req.body.target_language ||
                   null; // No default for target language
    
    console.log(`[UPLOAD] Raw request body language parameters:`, {
      fromLang: req.body.fromLang,
      toLang: req.body.toLang,
      sourceLang: req.body.sourceLang,
      targetLang: req.body.targetLang,
      sourceLanguage: req.body.sourceLanguage,
      targetLanguage: req.body.targetLanguage
    });
    
    // ===== VALIDATE FILE UPLOAD =====
    if (!file) {
      return res.status(400).json({ 
        error: "No video file uploaded",
        message: "Please select a video file to upload"
      });
    }
    
    // ✅ CRITICAL: Strict validation for target language
    if (!toLang) {
      return res.status(400).json({ 
        error: 'Target language is required',
        message: 'Please select a target language for translation',
        availableLanguages: {
          'hi': 'हिंदी (Hindi)',
          'bn': 'বাংলা (Bengali)', 
          'ta': 'தமிழ் (Tamil)',
          'te': 'తెలుగు (Telugu)',
          'mr': 'मराठी (Marathi)',
          'gu': 'ગુજરાતી (Gujarati)',
          'kn': 'ಕನ್ನಡ (Kannada)',
          'ml': 'മലയാளം (Malayalam)',
          'pa': 'ਪੰਜਾਬੀ (Punjabi)',
          'ur': 'اردو (Urdu)',
          'en': 'English'
        }
      });
    }
    
    // ✅ VALIDATE LANGUAGE SUPPORT
    if (!validateLanguage(fromLang, 'source')) {
      return res.status(400).json({
        error: 'Unsupported source language',
        message: `Source language '${fromLang}' is not supported`,
        received: fromLang,
        supported: ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur', 'en']
      });
    }
    
    if (!validateLanguage(toLang, 'target')) {
      return res.status(400).json({
        error: 'Unsupported target language',
        message: `Target language '${toLang}' is not supported`,
        received: toLang,
        supported: ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur', 'en']
      });
    }
    
    // ✅ ENHANCED LOGGING
    console.log(`[UPLOAD] ✅ Language Selection Received and Validated:`);
    console.log(`  From: ${fromLang} → ${getLanguageName(fromLang)}`);
    console.log(`  To: ${toLang} → ${getLanguageName(toLang)}`);
    console.log(`  File: ${file.originalname} (${Math.round(file.size / 1024)}KB)`);
    
    // ===== CONSTRUCT FILE PATH =====
    const filePath = file.path;

console.log(`[UPLOAD] 📂 File saved to: ${filePath}`);
console.log(`[UPLOAD] 📂 File details:`, {
  filename: file.filename,
  originalname: file.originalname,
  size: file.size,
  path: file.path,
  destination: file.destination
});
    
// ✅ VERIFY FILE EXISTS
if (!fs.existsSync(filePath)) {
  console.error(`[UPLOAD] ❌ File not found at: ${filePath}`);
  console.error(`[UPLOAD] ❌ Working directory: ${process.cwd()}`);
  console.error(`[UPLOAD] ❌ Platform: ${process.platform}`);
  
  return res.status(500).json({
    error: 'File upload failed',
    message: 'Uploaded file could not be found on server',
    debug: process.env.NODE_ENV !== 'production' ? {
      expectedPath: filePath,
      workingDir: process.cwd(),
      platform: process.platform,
      fileObject: {
        filename: file.filename,
        originalname: file.originalname,
        path: file.path,
        destination: file.destination
      }
    } : undefined
  });
}

console.log(`[UPLOAD] ✅ File verified at: ${filePath}`);

    // ===== CREATE UPLOAD RECORD WITH COMPREHENSIVE LANGUAGE FIELDS =====
    console.log(`[UPLOAD] Creating database record with explicit language fields...`);
    
    const upload = new Upload({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      file_path: file.path,
      
      // ✅ MULTIPLE LANGUAGE FIELD FORMATS FOR COMPATIBILITY
      source_language: fromLang,    // Original format
      target_language: toLang,      // Original format
      sourceLanguage: fromLang,     // Camel case format
      targetLanguage: toLang,       // Camel case format
      sourceLang: fromLang,         // Short format
      targetLang: toLang,           // Short format
      fromLang: fromLang,           // Frontend format
      toLang: toLang,               // Frontend format
      
      // ✅ LANGUAGE METADATA
      sourceLanguageName: getLanguageName(fromLang),
      targetLanguageName: getLanguageName(toLang),
      
      // ✅ PROCESSING STATUS
      processing_status: "uploaded",
      processingstatus: "uploaded",  // Alternative format
      
      // ✅ TIMESTAMPS
      uploadedAt: new Date(),
      createdAt: new Date()
    });
    
    const savedUpload = await upload.save();
    
    console.log(`[UPLOAD] ✅ Database record created successfully:`);
    console.log(`  Job ID: ${savedUpload._id.toString()}`);
    console.log(`  Source: ${fromLang} (${getLanguageName(fromLang)})`);
    console.log(`  Target: ${toLang} (${getLanguageName(toLang)})`);
    console.log(`  File Path: ${filePath}`);
    
    // ===== SAVE LANGUAGE CONFIG TO FILESYSTEM =====
    try {
      const configDir = './uploads/jobs';
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      const languageConfig = {
        jobId: savedUpload._id.toString(),
        sourceLanguage: fromLang,
        targetLanguage: toLang,
        sourceLang: fromLang,
        targetLang: toLang,
        fromLang: fromLang,
        toLang: toLang,
        sourceLanguageName: getLanguageName(fromLang),
        targetLanguageName: getLanguageName(toLang),
        timestamp: new Date().toISOString(),
        originalFilename: file.originalname,
        uploadedFilename: file.filename
      };
      
      const configPath = path.join(configDir, `${savedUpload._id.toString()}_config.json`);
      fs.writeFileSync(configPath, JSON.stringify(languageConfig, null, 2));
      
      console.log(`[UPLOAD] ✅ Language configuration saved: ${configPath}`);
    } catch (configError) {
      console.warn(`[UPLOAD] ⚠️ Failed to save language config:`, configError.message);
      // Don't fail the upload for this
    }
    
    // ✅ CRITICAL: Start processing with explicit language parameters
    console.log(`[UPLOAD] 🚀 Starting video processing with explicit languages...`);
    
processVideo(savedUpload._id.toString(), {
  sourceLanguage: fromLang,
  targetLanguage: toLang,
  sourceLanguageName: getLanguageName(fromLang),
  targetLanguageName: getLanguageName(toLang),
  originalFilename: file.originalname,
  uploadedFilename: file.filename,
  filePath: file.path,  // ✅ Use file.path
  jobId: savedUpload._id.toString(),
  fileSize: file.size,
  uploadTimestamp: new Date()
}).then(() => {
  console.log(`[${savedUpload._id.toString()}] ✅ Auto-processing started`);
}).catch(async (error) => {
  console.error(`[UPLOAD] ❌ Processing error for job ${savedUpload._id.toString()}:`, error.message);
  console.error(`[UPLOAD] Error stack:`, error.stack);
  
  try {
    await Upload.findByIdAndUpdate(savedUpload._id, {
      processing_status: 'failed',
      processingstatus: 'failed',
      errorMessage: error.message,
      error_message: error.message,
      errorTimestamp: new Date(),
      failed_at: new Date()
    });
  } catch (updateError) {
    console.error(`Failed to update error status:`, updateError.message);
  }
});



    
    // ✅ UNIVERSAL: Construct relative URL for download
const downloadUrl = `${req.protocol}://${req.get('host')}/uploads/originals/${file.filename}`;

    
    const response = {
      success: true,
      downloadUrl,
      jobId: savedUpload._id.toString(),
      status: "uploaded",
      message: "Upload successful, processing started",
      
      // ✅ INCLUDE LANGUAGE CONFIRMATION IN RESPONSE
      languages: {
        source: {
          code: fromLang,
          name: getLanguageName(fromLang)
        },
        target: {
          code: toLang,
          name: getLanguageName(toLang)
        }
      },
      
      file: {
        originalName: file.originalname,
        filename: file.filename,
        size: file.size,
        sizeFormatted: `${Math.round(file.size / 1024)}KB`
      },
      
      processing: {
        started: true,
        estimatedTime: "2-5 minutes",
        steps: [
          "Audio extraction",
          "Speech transcription", 
          `Translation to ${getLanguageName(toLang)}`,
          "Text-to-speech generation",
          "Video synchronization",
          "Caption generation"
        ]
      }
    };
    
    console.log(`[UPLOAD] ✅ Upload completed successfully for job ${savedUpload._id.toString()}`);
    console.log(`[UPLOAD] 🎯 Languages confirmed: ${fromLang} → ${toLang}`);
    
    res.status(200).json(response);
    
  } catch (error) {
    console.error("[UPLOAD] ❌ Upload error:", error.message);
    console.error("[UPLOAD] Error stack:", error.stack);
    
    res.status(500).json({ 
      error: "Server error during upload",
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// ===== GET UPLOAD STATUS =====
export const getUploadStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const upload = await Upload.findById(jobId);
    
    if (!upload) {
      return res.status(404).json({ 
        error: 'Job not found',
        jobId: jobId
      });
    }
    
    // ✅ RETURN COMPREHENSIVE STATUS INCLUDING LANGUAGES
    const response = {
      jobId: upload._id.toString(),
      status: upload.processing_status || upload.processingstatus || 'unknown',
      
      languages: {
        source: {
          code: upload.sourceLanguage || upload.source_language || upload.fromLang,
          name: getLanguageName(upload.sourceLanguage || upload.source_language || upload.fromLang)
        },
        target: {
          code: upload.targetLanguage || upload.target_language || upload.toLang,
          name: getLanguageName(upload.targetLanguage || upload.target_language || upload.toLang)
        }
      },
      
      file: {
        originalName: upload.originalName,
        filename: upload.filename,
        size: upload.size
      },
      
      timestamps: {
        uploaded: upload.uploadedAt || upload.createdAt,
        updated: upload.updatedAt
      }
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: error.message
    });
  }
};

// ===== GET SUPPORTED LANGUAGES =====
export const getSupportedLanguages = async (req, res) => {
  try {
    const languages = {
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
    
    const response = {
      supported: languages,
      count: Object.keys(languages).length,
      codes: Object.keys(languages),
      defaultSource: 'hi',
      popular: ['hi', 'bn', 'ta', 'te', 'en']
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Get languages error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: error.message
    });
  }
};

// ===== EXPORT ALL FUNCTIONS =====
export default {
  uploadVideo,
  getUploadStatus,
  getSupportedLanguages
};
