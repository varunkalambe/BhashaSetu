// utils/fileUtils.js

import fs from 'fs';
import path from 'path';

/**
 * Generate file path for different processing stages
 * @param {string} type - Type of file (audio, translated_audio, captions, transcripts, processed)
 * @param {string} jobId - Job identifier
 * @param {string} extension - File extension (e.g., '.wav', '.mp3', '.vtt', '.txt', '.mp4')
 * @returns {string} - Complete file path
 */
export const getFilePath = (type, jobId, extension) => {
  const baseDir = 'uploads';
  let subdirectory = '';
  
  switch (type) {
    case 'audio':
      subdirectory = 'audio';
      break;
    case 'translated_audio':
      subdirectory = 'translated_audio';
      break;
    case 'captions':
      subdirectory = 'captions';
      break;
    case 'transcripts':
      subdirectory = 'transcripts';
      break;
    case 'processed':
      subdirectory = 'processed';
      break;
    default:
      throw new Error(`Unknown file type: ${type}`);
  }
  
  const fullDir = path.join(baseDir, subdirectory);
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(fullDir)) {
    fs.mkdirSync(fullDir, { recursive: true });
    console.log(`📁 Created directory: ${fullDir}`);
  }
  
  const filename = `${jobId}_${type}${extension}`;
  return path.join(fullDir, filename);
};

/**
 * Generate timestamped filename
 * @param {string} originalName - Original filename
 * @param {string} suffix - Optional suffix
 * @returns {string} - Timestamped filename
 */
export const generateTimestampedFilename = (originalName, suffix = '') => {
  const timestamp = Date.now();
  const ext = path.extname(originalName);
  const name = path.basename(originalName, ext);
  return `${name}_${timestamp}${suffix}${ext}`;
};

/**
 * Check if file exists and return file info
 * @param {string} filePath - Path to file
 * @returns {Object} - File information
 */
export const getFileInfo = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { exists: false, path: filePath };
    }
    
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      path: filePath,
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      created: stats.birthtime,
      modified: stats.mtime
    };
  } catch (error) {
    return { exists: false, path: filePath, error: error.message };
  }
};

/**
 * Format file size in human readable format
 * @param {number} bytes - File size in bytes
 * @returns {string} - Formatted file size
 */
export const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Ensure directory exists, create if not
 * @param {string} dirPath - Directory path
 * @returns {boolean} - Success status
 */
export const ensureDirectoryExists = (dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`📁 Created directory: ${dirPath}`);
    }
    return true;
  } catch (error) {
    console.error(`❌ Failed to create directory ${dirPath}:`, error.message);
    return false;
  }
};

/**
 * Clean up old files based on age
 * @param {string} directory - Directory to clean
 * @param {number} maxAgeHours - Maximum file age in hours
 * @returns {number} - Number of files deleted
 */
export const cleanupOldFiles = (directory, maxAgeHours = 24) => {
  try {
    if (!fs.existsSync(directory)) {
      return 0;
    }
    
    const files = fs.readdirSync(directory);
    const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    let deletedCount = 0;
    
    files.forEach(file => {
      const filePath = path.join(directory, file);
      const stats = fs.statSync(filePath);
      
      if (stats.mtime.getTime() < cutoffTime) {
        fs.unlinkSync(filePath);
        deletedCount++;
        console.log(`🗑️ Deleted old file: ${filePath}`);
      }
    });
    
    return deletedCount;
  } catch (error) {
    console.error(`❌ Cleanup failed for ${directory}:`, error.message);
    return 0;
  }
};

/**
 * Get storage usage statistics
 * @returns {Object} - Storage usage stats
 */
export const getStorageStats = () => {
  try {
    const uploadDir = 'uploads';
    const subdirs = ['originals', 'audio', 'translated_audio', 'captions', 'transcripts', 'processed'];
    
    const stats = {
      total_size: 0,
      total_files: 0,
      directories: {}
    };
    
    subdirs.forEach(subdir => {
      const dirPath = path.join(uploadDir, subdir);
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        let dirSize = 0;
        
        files.forEach(file => {
          const filePath = path.join(dirPath, file);
          const fileStats = fs.statSync(filePath);
          dirSize += fileStats.size;
        });
        
        stats.directories[subdir] = {
          file_count: files.length,
          size_bytes: dirSize,
          size_formatted: formatFileSize(dirSize)
        };
        
        stats.total_size += dirSize;
        stats.total_files += files.length;
      } else {
        stats.directories[subdir] = {
          file_count: 0,
          size_bytes: 0,
          size_formatted: '0 Bytes'
        };
      }
    });
    
    stats.total_size_formatted = formatFileSize(stats.total_size);
    return stats;
  } catch (error) {
    console.error('❌ Failed to get storage stats:', error.message);
    return null;
  }
};
