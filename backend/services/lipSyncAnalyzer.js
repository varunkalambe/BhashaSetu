// services/lipSyncAnalyzer.js - FIXED PATH ESCAPING & VIDEO OPENING

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ===== MAIN LIP MOVEMENT ANALYSIS FUNCTION - FIXED PATHS =====
export const analyzeLipMovements = async (videoPath, jobId, options = {}) => {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[${jobId}] Starting comprehensive lip movement analysis with fixed paths...`);
      
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
      
      const tempDir = `./uploads/lip_analysis/${jobId}`;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const analysisFile = path.join(tempDir, 'lip_movement_analysis.json');
      const timelineFile = path.join(tempDir, 'lip_sync_timeline.json');
      const landmarksFile = path.join(tempDir, 'lip_landmarks.json');

      // ===== FIXED PYTHON SCRIPT WITH PROPER PATH ESCAPING =====
      const pythonScript = `
import cv2
import numpy as np
import json
import os
import sys
from pathlib import Path

# FIXED: Proper path handling for Windows
def analyze_lip_movements_comprehensive(video_path, output_files):
    """Comprehensive lip movement analysis with timeline generation"""
    print("Initializing lip movement analysis...")
    
    # FIXED: Convert paths to Path objects for proper handling
    video_path = Path(video_path)
    output_analysis, output_timeline, output_landmarks = output_files
    
    if not video_path.exists():
        raise Exception(f"Video file not found: {video_path}")
    
    try:
        # Try to import MediaPipe
        import mediapipe as mp
        mp_face_mesh = mp.solutions.face_mesh
        mp_drawing = mp.solutions.drawing_utils
        
        # Initialize Face Mesh with high precision settings
        face_mesh = mp_face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.8,
            min_tracking_confidence=0.7
        )
        
        print("MediaPipe Face Mesh initialized successfully")
        
    except ImportError:
        print("MediaPipe not available, using fallback analysis")
        return create_fallback_analysis(video_path, output_files)
    
    # Lip landmark indices for detailed analysis
    UPPER_LIP_OUTER = [61, 84, 17, 314, 405, 320, 307, 375, 321, 308, 324, 318]
    LOWER_LIP_OUTER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 324]
    MOUTH_CORNERS = [61, 291]
    LIP_CENTER_POINTS = [13, 14, 17, 18]
    
    # FIXED: Open video with proper path conversion
    print(f"Opening video: {video_path}")
    cap = cv2.VideoCapture(str(video_path))  # Convert Path to string
    
    if not cap.isOpened():
        raise Exception(f"Failed to open video file: {video_path}")
    
    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    print(f"Video properties: {total_frames} frames, {fps:.2f} fps, {duration:.2f}s, {width}x{height}")
    
    # Initialize analysis arrays
    frame_analysis = []
    lip_movement_timeline = []
    
    frame_count = 0
    prev_lip_landmarks = None
    
    # Movement detection parameters
    movement_threshold = 0.01
    speech_activity_threshold = 0.02
    
    print("Processing video frames...")
    
    while cap.isOpened() and frame_count < total_frames:
        ret, frame = cap.read()
        if not ret:
            break
        
        timestamp = frame_count / fps if fps > 0 else frame_count * 0.033
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Process frame with MediaPipe
        results = face_mesh.process(rgb_frame)
        
        frame_data = {
            'frame_index': frame_count,
            'timestamp': float(timestamp),
            'has_face': False,
            'lip_landmarks': {},
            'movement_metrics': {},
            'speech_indicators': {}
        }
        
        if results.multi_face_landmarks:
            for face_landmarks in results.multi_face_landmarks:
                landmarks = face_landmarks.landmark
                h, w, c = frame.shape
                
                # Extract lip coordinates
                upper_lip_outer = [(landmarks[i].x, landmarks[i].y) for i in UPPER_LIP_OUTER]
                lower_lip_outer = [(landmarks[i].x, landmarks[i].y) for i in LOWER_LIP_OUTER]
                mouth_corners = [(landmarks[i].x, landmarks[i].y) for i in MOUTH_CORNERS]
                
                # Convert to pixel coordinates
                upper_lip_px = [(x * w, y * h) for x, y in upper_lip_outer]
                lower_lip_px = [(x * w, y * h) for x, y in lower_lip_outer]
                corners_px = [(x * w, y * h) for x, y in mouth_corners]
                
                # Calculate measurements
                upper_center = np.mean(upper_lip_px, axis=0)
                lower_center = np.mean(lower_lip_px, axis=0)
                mouth_height = abs(upper_center[1] - lower_center[1])
                mouth_width = np.linalg.norm(np.array(corners_px[1]) - np.array(corners_px[0]))
                lip_aspect_ratio = mouth_height / (mouth_width + 1e-6)
                
                # Movement analysis
                movement_velocity = 0.0
                movement_direction = 'none'
                
                if prev_lip_landmarks is not None:
                    prev_upper = np.array(prev_lip_landmarks['upper_center'])
                    curr_upper = np.array(upper_center)
                    movement_velocity = np.linalg.norm(curr_upper - prev_upper)
                    
                    vertical_change = curr_upper[1] - prev_upper[1]
                    if abs(vertical_change) > movement_threshold:
                        movement_direction = 'closing' if vertical_change > 0 else 'opening'
                
                # Speech activity detection
                speech_activity_score = min(1.0, mouth_height / 20.0 * 0.4 + movement_velocity * 100 * 0.4 + lip_aspect_ratio * 5.0 * 0.2)
                is_speaking = speech_activity_score > speech_activity_threshold
                
                # Store data
                frame_data.update({
                    'has_face': True,
                    'lip_landmarks': {
                        'upper_lip_outer': upper_lip_outer,
                        'lower_lip_outer': lower_lip_outer,
                        'mouth_corners': mouth_corners,
                        'upper_center': upper_center.tolist(),
                        'lower_center': lower_center.tolist()
                    },
                    'movement_metrics': {
                        'mouth_height': float(mouth_height),
                        'mouth_width': float(mouth_width),
                        'lip_aspect_ratio': float(lip_aspect_ratio),
                        'movement_velocity': float(movement_velocity),
                        'movement_direction': movement_direction
                    },
                    'speech_indicators': {
                        'speech_activity_score': float(speech_activity_score),
                        'is_speaking': bool(is_speaking)
                    }
                })
                
                prev_lip_landmarks = {
                    'upper_center': upper_center,
                    'lower_center': lower_center,
                    'timestamp': timestamp
                }
                
                break  # Process only the first face
        
        frame_analysis.append(frame_data)
        frame_count += 1
        
        # Progress reporting
        if frame_count % 30 == 0:
            progress = (frame_count / total_frames) * 100
            print(f"Progress: {progress:.1f}% ({frame_count}/{total_frames} frames)")
    
    cap.release()
    print("Frame analysis completed")
    
    # Generate movement timeline
    lip_movement_timeline = generate_movement_timeline(frame_analysis, fps)
    
    # Calculate statistics
    speaking_frames = sum(1 for frame in frame_analysis if frame['speech_indicators'].get('is_speaking', False))
    speaking_percentage = (speaking_frames / len(frame_analysis)) * 100 if frame_analysis else 0
    
    # Prepare output data
    analysis_results = {
        'video_info': {
            'fps': float(fps),
            'total_frames': int(total_frames),
            'duration': float(duration),
            'width': int(width),
            'height': int(height)
        },
        'analysis_summary': {
            'frames_with_face': sum(1 for f in frame_analysis if f['has_face']),
            'speaking_frames': int(speaking_frames),
            'speaking_percentage': float(speaking_percentage),
            'total_movement_events': len(lip_movement_timeline)
        }
    }
    
    # FIXED: Save results with proper path handling
    with open(output_analysis, 'w', encoding='utf-8') as f:
        json.dump({
            **analysis_results,
            'frame_analysis': frame_analysis[:50]  # First 50 frames
        }, f, indent=2, ensure_ascii=False)
    
    with open(output_timeline, 'w', encoding='utf-8') as f:
        json.dump({
            'lip_movement_timeline': lip_movement_timeline,
            'timeline_resolution': 0.1,
            'total_duration': duration
        }, f, indent=2, ensure_ascii=False)
    
    # Sample frames for landmarks
    sample_frames = frame_analysis[::max(1, len(frame_analysis) // 20)]
    with open(output_landmarks, 'w', encoding='utf-8') as f:
        json.dump({
            'sample_frames': sample_frames,
            'sampling_rate': len(frame_analysis) / 20
        }, f, indent=2, ensure_ascii=False)
    
    print(f"Analysis completed: {speaking_percentage:.1f}% speaking")
    return analysis_results

def generate_movement_timeline(frame_analysis, fps):
    """Generate timeline of significant lip movements"""
    timeline = []
    current_event = None
    
    for i, frame in enumerate(frame_analysis):
        if not frame['has_face']:
            continue
        
        movement = frame['movement_metrics']
        velocity = movement.get('movement_velocity', 0)
        is_speaking = frame['speech_indicators'].get('is_speaking', False)
        
        if velocity > 0.02 or is_speaking:  # Significant movement or speech
            if current_event is None:
                current_event = {
                    'start_time': frame['timestamp'],
                    'start_frame': frame['frame_index'],
                    'type': 'speech' if is_speaking else 'movement',
                    'max_velocity': velocity,
                    'frames': []
                }
            
            current_event['frames'].append(frame['frame_index'])
            current_event['max_velocity'] = max(current_event['max_velocity'], velocity)
            current_event['end_time'] = frame['timestamp']
            current_event['end_frame'] = frame['frame_index']
        else:
            if current_event is not None:
                current_event['duration'] = current_event['end_time'] - current_event['start_time']
                current_event['frame_count'] = len(current_event['frames'])
                timeline.append(current_event)
                current_event = None
    
    # Close final event
    if current_event is not None:
        current_event['duration'] = current_event['end_time'] - current_event['start_time']
        current_event['frame_count'] = len(current_event['frames'])
        timeline.append(current_event)
    
    return timeline

def create_fallback_analysis(video_path, output_files):
    """Create fallback analysis when MediaPipe is not available"""
    print("Creating fallback lip movement analysis...")
    
    try:
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise Exception(f"Cannot open video: {video_path}")
        
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps
        cap.release()
        
        # Create basic fallback data
        fallback_timeline = []
        segment_duration = 2.0
        num_segments = max(1, int(duration / segment_duration))
        
        for i in range(num_segments):
            start_time = i * segment_duration
            end_time = min(start_time + segment_duration, duration)
            
            fallback_timeline.append({
                'start_time': start_time,
                'end_time': end_time,
                'duration': end_time - start_time,
                'type': 'estimated_speech',
                'confidence': 0.3,
                'fallback': True
            })
        
        results = {
            'video_info': {
                'fps': fps,
                'total_frames': total_frames,
                'duration': duration,
                'analysis_method': 'fallback'
            },
            'analysis_summary': {
                'fallback_used': True,
                'estimated_speaking_segments': len(fallback_timeline)
            }
        }
        
        # Save fallback results
        output_analysis, output_timeline, output_landmarks = output_files
        
        with open(output_analysis, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        
        with open(output_timeline, 'w', encoding='utf-8') as f:
            json.dump({
                'lip_movement_timeline': fallback_timeline,
                'fallback_used': True,
                'total_duration': duration
            }, f, indent=2, ensure_ascii=False)
        
        with open(output_landmarks, 'w', encoding='utf-8') as f:
            json.dump({
                'fallback_used': True,
                'message': 'MediaPipe not available'
            }, f, indent=2, ensure_ascii=False)
        
        print("Fallback analysis completed")
        return results
        
    except Exception as e:
        raise Exception(f"Fallback analysis failed: {str(e)}")

if __name__ == "__main__":
    try:
        # FIXED: Proper argument handling with raw strings
        video_path = r"${path.resolve(videoPath).replace(/\\\\/g, '\\\\\\\\')}"
        output_files = [
            r"${path.resolve(analysisFile).replace(/\\\\/g, '\\\\\\\\')}",
            r"${path.resolve(timelineFile).replace(/\\\\/g, '\\\\\\\\')}",
            r"${path.resolve(landmarksFile).replace(/\\\\/g, '\\\\\\\\')}"
        ]
        
        result = analyze_lip_movements_comprehensive(video_path, output_files)
        print("SUCCESS")
        
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)
`;

      // ===== EXECUTE PYTHON SCRIPT =====
      const tempScriptPath = path.join(tempDir, 'lip_movement_analyzer.py');
      fs.writeFileSync(tempScriptPath, pythonScript, 'utf8');

      console.log(`[${jobId}] Executing comprehensive lip movement analysis...`);
      
      const { stdout, stderr } = await execAsync(`python "${tempScriptPath}"`, {
        timeout: 120000, // 2 minutes
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });

      // Clean up script
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (cleanupError) {
        console.warn(`[${jobId}] Failed to cleanup script:`, cleanupError.message);
      }

      if (stderr && !stderr.includes('WARNING')) {
        console.warn(`[${jobId}] Python warnings:`, stderr);
      }

      if (stdout.includes('ERROR:')) {
        throw new Error(`Python execution error: ${stdout}`);
      }

      // ===== LOAD RESULTS =====
      let analysisResults;
      
      if (fs.existsSync(analysisFile)) {
        const analysisData = fs.readFileSync(analysisFile, 'utf8');
        analysisResults = JSON.parse(analysisData);
      } else {
        throw new Error('Analysis file not created');
      }

      console.log(`[${jobId}] ✅ Lip movement analysis completed successfully`);
      console.log(`[${jobId}] Analysis quality: ${analysisResults.analysis_summary?.fallback_used ? 'fallback' : 'full'}`);
      
      resolve(analysisResults);

    } catch (error) {
      console.error(`[${jobId}] Lip movement analysis failed:`, error.message);
      
      // ===== CREATE FALLBACK ANALYSIS =====
      try {
        console.log(`[${jobId}] Creating fallback lip movement analysis...`);
        const fallbackAnalysis = await createFallbackLipMovementAnalysis(videoPath, jobId);
        console.log(`[${jobId}] ✅ Fallback analysis created`);
        resolve(fallbackAnalysis);
      } catch (fallbackError) {
        console.error(`[${jobId}] Fallback analysis also failed:`, fallbackError.message);
        reject(error);
      }
    }
  });
};

// ===== EXTRACT LIP SYNC REFERENCE =====
export const extractLipSyncReference = async (lipAnalysisResults, jobId) => {
  console.log(`[${jobId}] Extracting lip sync reference data...`);
  
  try {
    const duration = lipAnalysisResults.video_info?.duration || 30;
    const fps = lipAnalysisResults.video_info?.fps || 25;
    
    // Generate sync points based on analysis
    const syncPoints = [];
    const speechSegments = [];
    
    if (lipAnalysisResults.analysis_summary?.fallback_used) {
      // Create basic sync points for fallback
      const segmentDuration = 2.0;
      const numSegments = Math.ceil(duration / segmentDuration);
      
      for (let i = 0; i < numSegments; i++) {
        const timestamp = i * segmentDuration;
        syncPoints.push({
          timestamp: Math.min(timestamp, duration),
          type: 'estimated_speech',
          intensity: 0.5 + Math.random() * 0.3,
          confidence: 0.3
        });
        
        speechSegments.push({
          start: timestamp,
          end: Math.min(timestamp + segmentDuration, duration),
          type: 'estimated_speech',
          confidence: 0.3
        });
      }
    } else {
      // Extract from actual analysis
      const timeline = lipAnalysisResults.lip_movement_timeline || [];
      
      timeline.forEach(event => {
        syncPoints.push({
          timestamp: event.start_time,
          type: event.type,
          intensity: Math.min(1.0, event.max_velocity * 10),
          confidence: 0.7
        });
        
        speechSegments.push({
          start: event.start_time,
          end: event.end_time,
          type: event.type,
          confidence: 0.7
        });
      });
    }
    
    const lipSyncReference = {
      sync_points: syncPoints,
      speech_segments: speechSegments,
      total_points: syncPoints.length,
      total_duration: duration,
      confidence_level: syncPoints.length > 10 ? 'medium' : 'low',
      method: lipAnalysisResults.analysis_summary?.fallback_used ? 'fallback_estimate' : 'mediapipe_analysis'
    };
    
    console.log(`[${jobId}] ✅ Lip sync reference extracted:`);
    console.log(`[${jobId}]   Sync points: ${syncPoints.length}`);
    console.log(`[${jobId}]   Speech segments: ${speechSegments.length}`);
    console.log(`[${jobId}]   Movement events: ${lipAnalysisResults.analysis_summary?.total_movement_events || 0}`);
    console.log(`[${jobId}]   Confidence: ${lipSyncReference.confidence_level}`);
    
    return lipSyncReference;
    
  } catch (error) {
    console.error(`[${jobId}] Failed to extract lip sync reference:`, error.message);
    
    // Return minimal reference
    return {
      sync_points: [],
      speech_segments: [],
      total_points: 0,
      total_duration: 30,
      confidence_level: 'none',
      method: 'error_fallback',
      error: error.message
    };
  }
};

// ===== VALIDATE ANALYSIS QUALITY =====
export const validateAnalysisQuality = (analysisResults, jobId) => {
  console.log(`[${jobId}] Validating lip movement analysis quality...`);
  
  try {
    let qualityScore = 0;
    let qualityLevel = 'poor';
    
    if (analysisResults.analysis_summary?.fallback_used) {
      qualityScore = 30;
      qualityLevel = 'fallback';
    } else {
      const framesWithFace = analysisResults.analysis_summary?.frames_with_face || 0;
      const totalFrames = analysisResults.video_info?.total_frames || 1;
      const faceDetectionRate = (framesWithFace / totalFrames) * 100;
      
      const speakingFrames = analysisResults.analysis_summary?.speaking_frames || 0;
      const speakingPercentage = analysisResults.analysis_summary?.speaking_percentage || 0;
      
      qualityScore += Math.min(40, faceDetectionRate * 0.4); // Max 40 points
      qualityScore += Math.min(30, speakingPercentage * 0.3); // Max 30 points
      qualityScore += Math.min(30, (analysisResults.analysis_summary?.total_movement_events || 0) * 3); // Max 30 points
      
      if (qualityScore >= 80) qualityLevel = 'excellent';
      else if (qualityScore >= 60) qualityLevel = 'good';
      else if (qualityScore >= 40) qualityLevel = 'fair';
      else qualityLevel = 'poor';
    }
    
    const validation = {
      overall_quality: qualityLevel,
      quality_score: Math.round(qualityScore),
      face_detection_rate: analysisResults.analysis_summary?.frames_with_face || 0,
      speech_detection_rate: analysisResults.analysis_summary?.speaking_percentage || 0,
      movement_events: analysisResults.analysis_summary?.total_movement_events || 0,
      fallback_used: analysisResults.analysis_summary?.fallback_used || false
    };
    
    console.log(`[${jobId}] Analysis quality: ${qualityLevel} (${qualityScore}/100)`);
    
    return validation;
    
  } catch (error) {
    console.error(`[${jobId}] Quality validation failed:`, error.message);
    
    return {
      overall_quality: 'unknown',
      quality_score: 0,
      face_detection_rate: 0,
      speech_detection_rate: 0,
      movement_events: 0,
      fallback_used: true,
      error: error.message
    };
  }
};

// ===== CREATE FALLBACK LIP MOVEMENT ANALYSIS =====
const createFallbackLipMovementAnalysis = async (videoPath, jobId) => {
  console.log(`[${jobId}] Creating fallback lip movement analysis...`);
  
  try {
    // Get basic video info using ffprobe
    const ffprobeCommand = `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`;
    const { stdout } = await execAsync(ffprobeCommand);
    const videoInfo = JSON.parse(stdout);
    
    const duration = parseFloat(videoInfo.format.duration) || 30;
    const videoStream = videoInfo.streams.find(s => s.codec_type === 'video');
    const fps = videoStream ? eval(videoStream.r_frame_rate) : 25;
    
    // Create estimated sync points
    const syncPoints = [];
    const speechSegments = [];
    const segmentDuration = 2.0;
    const numSegments = Math.ceil(duration / segmentDuration);
    
    for (let i = 0; i < numSegments; i++) {
      const startTime = i * segmentDuration;
      const endTime = Math.min(startTime + segmentDuration, duration);
      const intensity = 0.4 + Math.random() * 0.4; // Random between 0.4-0.8
      
      syncPoints.push({
        timestamp: startTime,
        type: 'estimated_speech',
        intensity: intensity,
        confidence: 0.3
      });
      
      speechSegments.push({
        start: startTime,
        end: endTime,
        duration: endTime - startTime,
        type: 'estimated_speech',
        confidence: 0.3
      });
    }
    
    const fallbackAnalysis = {
      video_info: {
        fps: fps,
        total_frames: Math.floor(duration * fps),
        duration: duration,
        fallback: true
      },
      analysis_summary: {
        fallback_used: true,
        estimated_speech_segments: speechSegments.length,
        sync_points_generated: syncPoints.length,
        method: 'duration_based_estimation'
      },
      lip_movement_timeline: speechSegments,
      sync_points: syncPoints
    };
    
    console.log(`[${jobId}] Fallback analysis created: ${speechSegments.length} segments, ${syncPoints.length} sync points`);
    
    return fallbackAnalysis;
    
  } catch (error) {
    console.error(`[${jobId}] Fallback analysis creation failed:`, error.message);
    
    // Ultra-minimal fallback
    return {
      video_info: {
        fps: 25,
        total_frames: 750,
        duration: 30,
        fallback: true
      },
      analysis_summary: {
        fallback_used: true,
        estimated_speech_segments: 0,
        sync_points_generated: 0,
        method: 'minimal_fallback'
      },
      lip_movement_timeline: [],
      sync_points: []
    };
  }
};

// ===== ANALYZE LIP MOVEMENTS WITH ENHANCED OPTIONS =====
export const analyzeLipMovementsEnhanced = async (videoPath, jobId, options = {}) => {
  const enhancedOptions = {
    highPrecision: options.highPrecision || false,
    frameLevelAccuracy: options.frameLevelAccuracy || true,
    speechDetection: options.speechDetection || true,
    realTimeProcessing: options.realTimeProcessing || false,
    maxFrames: options.maxFrames || null,
    ...options
  };
  
  console.log(`[${jobId}] Starting enhanced lip movement analysis with options:`, enhancedOptions);
  
  return analyzeLipMovements(videoPath, jobId, enhancedOptions);
};

// ===== GET LIP SYNC METRICS =====
export const getLipSyncMetrics = async (lipAnalysisResults, jobId) => {
  console.log(`[${jobId}] Calculating lip sync metrics...`);
  
  try {
    const videoInfo = lipAnalysisResults.video_info || {};
    const analysisSummary = lipAnalysisResults.analysis_summary || {};
    
    const metrics = {
      overall_quality: analysisSummary.fallback_used ? 'fallback' : 'full',
      face_detection_success_rate: 0,
      speech_activity_percentage: analysisSummary.speaking_percentage || 0,
      movement_events_count: analysisSummary.total_movement_events || 0,
      analysis_duration: videoInfo.duration || 0,
      frames_analyzed: videoInfo.total_frames || 0,
      fps: videoInfo.fps || 25,
      confidence_score: 0,
      sync_quality_rating: 'unknown'
    };
    
    // Calculate face detection success rate
    if (videoInfo.total_frames && analysisSummary.frames_with_face) {
      metrics.face_detection_success_rate = (analysisSummary.frames_with_face / videoInfo.total_frames) * 100;
    }
    
    // Calculate confidence score
    let confidenceScore = 0;
    if (!analysisSummary.fallback_used) {
      confidenceScore += Math.min(40, metrics.face_detection_success_rate * 0.4);
      confidenceScore += Math.min(30, metrics.speech_activity_percentage * 0.3);
      confidenceScore += Math.min(30, metrics.movement_events_count * 3);
    } else {
      confidenceScore = 30; // Base score for fallback
    }
    
    metrics.confidence_score = Math.round(confidenceScore);
    
    // Determine sync quality rating
    if (metrics.confidence_score >= 80) {
      metrics.sync_quality_rating = 'excellent';
    } else if (metrics.confidence_score >= 60) {
      metrics.sync_quality_rating = 'good';
    } else if (metrics.confidence_score >= 40) {
      metrics.sync_quality_rating = 'fair';
    } else {
      metrics.sync_quality_rating = 'poor';
    }
    
    console.log(`[${jobId}] Lip sync metrics calculated:`);
    console.log(`[${jobId}]   Quality: ${metrics.sync_quality_rating} (${metrics.confidence_score}/100)`);
    console.log(`[${jobId}]   Face detection: ${metrics.face_detection_success_rate.toFixed(1)}%`);
    console.log(`[${jobId}]   Speech activity: ${metrics.speech_activity_percentage.toFixed(1)}%`);
    
    return metrics;
    
  } catch (error) {
    console.error(`[${jobId}] Failed to calculate lip sync metrics:`, error.message);
    
    return {
      overall_quality: 'error',
      face_detection_success_rate: 0,
      speech_activity_percentage: 0,
      movement_events_count: 0,
      analysis_duration: 0,
      frames_analyzed: 0,
      fps: 25,
      confidence_score: 0,
      sync_quality_rating: 'unknown',
      error: error.message
    };
  }
};

// ===== EXPORT ALL FUNCTIONS =====
export default {
  analyzeLipMovements,
  analyzeLipMovementsEnhanced,
  extractLipSyncReference,
  validateAnalysisQuality,
  getLipSyncMetrics
};
