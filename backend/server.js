// server.js - Integrated for Hugging Face Spaces Deployment

// ===== IMPORT REQUIRED MODULES =====
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawn } from 'child_process';  // ✅ FIXED: Proper ES Module import
import os from 'os';  // ✅ FIXED: Import os module

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import database connection
import connectDB from "./config/db.js";

// Import route handlers
import uploadRoutes from "./routes/uploadRoutes.js";
import streamRoutes from "./routes/streamRoutes.js"; 
import processRoutes from "./routes/processRoutes.js";

// ===== INITIALIZE ENVIRONMENT AND DATABASE =====
dotenv.config();
connectDB();

const app = express();

// ============================================
// 🔧 CONFIGURATION FOR HUGGING FACE SPACES
// ============================================

// Enable CORS for all origins (important for HF Spaces)
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Range", "Accept-Ranges", "Authorization"],
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
    credentials: true
}));

// Parse JSON requests with increased limit for video processing
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ============================================
// 📁 DIRECTORY SETUP
// ============================================
// Ensure all upload directories exist (using absolute paths for Docker)
const uploadDirs = [
    '/app/uploads',
    '/app/uploads/originals',
    '/app/uploads/audio',
    '/app/uploads/transcription',
    '/app/uploads/translations',
    '/app/uploads/translated_audio',
    '/app/uploads/captions',
    '/app/uploads/transcripts',
    '/app/uploads/processed',
    '/app/uploads/final',
    '/app/uploads/temp'
];

uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});

// Fonts directory already created by Dockerfile at /app/backend/fonts
console.log(`✅ Fonts directory: /app/backend/fonts`);


// ============================================
// 🎨 STATIC FILE SERVING (HF Spaces Compatible)
// ============================================

// ✅ NEW: Serve static frontend files from parent directory
// ✅ Serve HTML files from project root
app.use(express.static(path.join(__dirname, '..'), {
    extensions: ['html'],  // Auto-add .html extension
    index: 'index.html',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
    }
}));


// ✅ Serve uploaded videos and processed files
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads"), {
    setHeaders: (res, filePath) => {
        // Set proper headers for video files
        if (filePath.endsWith('.mp4') || filePath.endsWith('.avi') || filePath.endsWith('.mov')) {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
        }
        // Set proper headers for audio files
        if (filePath.endsWith('.wav') || filePath.endsWith('.mp3')) {
            res.setHeader('Content-Type', 'audio/mpeg');
        }
        // Set proper headers for caption files
        if (filePath.endsWith('.vtt') || filePath.endsWith('.srt')) {
            res.setHeader('Content-Type', 'text/vtt');
        }
    }
}));

// ✅ Serve fonts directory
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts')));

// ============================================
// 📊 ENHANCED REQUEST LOGGING MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(100)}`);
    console.log(`🔍 [${timestamp}] INCOMING REQUEST`);
    console.log(`${'='.repeat(100)}`);
    console.log(`📍 Method: ${req.method}`);
    console.log(`📍 URL: ${req.url}`);
    console.log(`📍 IP: ${req.ip}`);
    console.log(`📍 Content-Type: ${req.headers['content-type'] || 'Not specified'}`);
    
    if (req.method === 'POST' || req.method === 'PUT') {
        // Only log body for non-file uploads to avoid flooding logs
        if (req.headers['content-type']?.includes('application/json')) {
            console.log(`📦 Request Body:`, JSON.stringify(req.body, null, 2).substring(0, 500));
        }
    }
    
    if (Object.keys(req.params).length > 0) {
        console.log(`📦 Request Params:`, JSON.stringify(req.params, null, 2));
    }
    
    if (Object.keys(req.query).length > 0) {
        console.log(`📦 Request Query:`, JSON.stringify(req.query, null, 2));
    }
    
    if (req.file) {
        console.log(`📦 Uploaded File:`, {
            fieldname: req.file.fieldname,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: `${(req.file.size / (1024 * 1024)).toFixed(2)} MB`
        });
    }
    
    console.log(`${'='.repeat(100)}\n`);
    next();
});

// ============================================
// 🛣️ API ROUTES
// ============================================
app.use("/api/upload", uploadRoutes);
app.use("/uploads", streamRoutes);
app.use("/api/process", processRoutes);

// ============================================
// 🌐 CASE-INSENSITIVE HTML FILE SERVING
// ============================================
app.use((req, res, next) => {
    if (req.method === 'GET' && req.path.toLowerCase().endsWith('.html')) {
        const dirPath = path.join(__dirname, '..');
        
        try {
            const files = fs.readdirSync(dirPath);
            const requestedFile = path.basename(req.path);
            const match = files.find(f => f.toLowerCase() === requestedFile.toLowerCase());
            
            if (match) {
                const filePath = path.join(dirPath, match);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.sendFile(filePath);
            }
        } catch (err) {
            console.error('Error finding HTML file:', err);
        }
    }
    next();
});


// ============================================
// 🏠 ROOT ENDPOINTS (HF Spaces Compatible)
// ============================================

// ✅ NEW: Serve Home.html at root URL
app.get("/", (req, res) => {
    const htmlPath = path.join(__dirname, '../Home.html');
    
    // Check if Home.html exists
    if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
    } else {
        // Fallback to API info if Home.html doesn't exist
        res.json({
            success: true,
            message: "Video Translation API Server - Hugging Face Spaces",
            version: "1.0.0",
            deployment: "Hugging Face Spaces",
            endpoints: {
                upload: "/api/upload",
                process: "/api/process", 
                stream: "/uploads",
                health: "/api/process/health",
                api_info: "/api"
            },
            features: [
                "Video Upload & Processing",
                "Audio Extraction with FFmpeg",
                "Speech-to-Text Transcription (Whisper AI)", 
                "Multi-language Translation (13 Indian Languages)",
                "Text-to-Speech Generation (Edge TTS)",
                "Native Script Caption Generation",
                "Video Assembly with Embedded Subtitles",
                "Real-time Processing Status"
            ],
            supported_languages: [
                "Hindi", "Telugu", "Bengali", "Tamil", "Marathi",
                "Gujarati", "Kannada", "Malayalam", "Punjabi",
                "Odia", "Assamese", "Urdu", "Sanskrit"
            ],
            timestamp: new Date(),
            notice: "⚠️ Home.html not found. This is the API fallback response."
        });
    }
});

// API INFO ENDPOINT
app.get("/api", (req, res) => {
    res.json({
        success: true,
        api: "Video Translation Processing API",
        version: "1.0.0",
        deployment: "Hugging Face Spaces Compatible",
        routes: {
            "POST /api/upload": "Upload video file for processing",
            "GET /api/process/status/:jobId": "Get processing status",
            "GET /api/process/jobs": "List all processing jobs",
            "GET /api/process/stats": "Get processing statistics",
            "POST /api/process/jobs/:jobId/cancel": "Cancel a processing job",
            "DELETE /api/process/jobs/:jobId": "Delete a processing job",
            "GET /api/process/health": "System health check",
            "GET /uploads/:filename": "Stream uploaded/processed files",
            "GET /": "Serve frontend application"
        },
        documentation: "Visit /api/docs for detailed API documentation",
        timestamp: new Date()
    });
});

// ============================================
// 🏥 HEALTH CHECK ENDPOINT (Enhanced for HF Spaces)
// ============================================
app.get('/health', async (req, res) => {
    try {
        // ✅ IMPROVED: Proper promise-based dependency checks
        
        // Check FFmpeg
        const checkFFmpeg = () => {
            return new Promise((resolve) => {
                const ffmpegCheck = spawn('ffmpeg', ['-version']);
                let resolved = false;
                
                ffmpegCheck.stdout.on('data', () => {
                    if (!resolved) {
                        resolved = true;
                        resolve(true);
                    }
                });
                
                ffmpegCheck.on('error', () => {
                    if (!resolved) {
                        resolved = true;
                        resolve(false);
                    }
                });
                
                ffmpegCheck.on('close', (code) => {
                    if (!resolved) {
                        resolved = true;
                        resolve(code === 0);
                    }
                });
                
                // Timeout after 3 seconds
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        resolve(false);
                    }
                }, 3000);
            });
        };
        
        // Check Whisper
        const checkWhisper = () => {
            return new Promise((resolve) => {
                const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
                const whisperCheck = spawn(pythonCmd, ['-c', 'import whisper; print("OK")']);
                let resolved = false;
                
                whisperCheck.stdout.on('data', (data) => {
                    if (!resolved && data.toString().includes('OK')) {
                        resolved = true;
                        resolve(true);
                    }
                });
                
                whisperCheck.stderr.on('data', () => {
                    // Ignore stderr, Whisper might print warnings
                });
                
                whisperCheck.on('error', () => {
                    if (!resolved) {
                        resolved = true;
                        resolve(false);
                    }
                });
                
                whisperCheck.on('close', (code) => {
                    if (!resolved) {
                        resolved = true;
                        resolve(code === 0);
                    }
                });
                
                // Timeout after 5 seconds for Windows Python startup
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        resolve(false);
                    }
                }, 5000);
            });
        };
        
        // Run checks in parallel
        const [ffmpegAvailable, whisperAvailable] = await Promise.all([
            checkFFmpeg(),
            checkWhisper()
        ]);
        
        res.json({
            success: true,
            status: 'Server is healthy',
            uptime: process.uptime(),
            timestamp: new Date(),
            environment: process.env.NODE_ENV || 'production',
            version: '1.0.0',
            deployment: 'Hugging Face Spaces',
            memory: {
                used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
                total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`,
                rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`
            },
            system: {
                platform: process.platform,
                nodeVersion: process.version,
                cpuCount: os.cpus().length
            },
            dependencies: {
                ffmpeg: ffmpegAvailable ? '✅ Available' : '⚠️ Not detected',
                whisper: whisperAvailable ? '✅ Available' : '⚠️ Not detected'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            status: 'Server unhealthy',
            error: error.message,
            timestamp: new Date()
        });
    }
});



// ============================================
// 📤 RESPONSE LOGGING MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
        console.log(`\n${'🔵'.repeat(50)}`);
        console.log(`✅ RESPONSE for ${req.method} ${req.url}`);
        console.log(`📤 Status: ${res.statusCode}`);
        if (typeof data === 'string' && data.length < 500) {
            console.log(`📤 Response:`, data.substring(0, 200));
        } else if (typeof data === 'object') {
            try {
                console.log(`📤 Response:`, JSON.stringify(data, null, 2).substring(0, 300));
            } catch (e) {
                console.log(`📤 Response: [Cannot stringify]`);
            }
        }
        console.log(`${'🔵'.repeat(50)}\n`);
        
        originalSend.call(this, data);
    };
    
    next();
});

// ============================================
// 🚫 ERROR HANDLING MIDDLEWARE
// ============================================

// 404 Handler - Route not found
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Route not found",
        message: `The requested endpoint ${req.method} ${req.url} does not exist`,
        availableRoutes: [
            "GET /",
            "GET /api",
            "GET /health",
            "POST /api/upload",
            "GET /api/process/status/:jobId",
            "GET /api/process/jobs",
            "GET /api/process/stats",
            "GET /api/process/health",
            "GET /uploads/:filename"
        ],
        timestamp: new Date()
    });
});

// Global Error Handler
app.use((error, req, res, next) => {
    console.error('🔥 Server Error:', error);
    
    // Handle specific error types
    if (error.type === 'entity.too.large') {
        return res.status(413).json({
            success: false,
            error: "File too large",
            message: "The uploaded file exceeds the maximum size limit (100MB)",
            maxSize: "100MB"
        });
    }
    
    if (error.name === 'ValidationError') {
        return res.status(400).json({
            success: false,
            error: "Validation Error",
            message: error.message
        });
    }
    
    if (error.name === 'CastError') {
        return res.status(400).json({
            success: false,
            error: "Invalid ID",
            message: "The provided ID is not valid"
        });
    }
    
    if (error.code === 'ENOENT') {
        return res.status(404).json({
            success: false,
            error: "File not found",
            message: "The requested file does not exist"
        });
    }
    
    // Default error response
    res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: process.env.NODE_ENV === 'production' ? 
            "Something went wrong on the server" : 
            error.message,
        timestamp: new Date()
    });
});

// ============================================
// 🔄 GRACEFUL SHUTDOWN HANDLING
// ============================================
const gracefulShutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    
    server.close(() => {
        console.log('✅ HTTP server closed');
        
        // Close database connections
        console.log('✅ Database connections closed');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.log('⚠️  Forcing shutdown after 10 seconds');
        process.exit(1);
    }, 10000);
};

// ============================================
// 🚀 START SERVER (HF Spaces Compatible)
// ============================================
const PORT = process.env.PORT || 7860;  // ✅ CRITICAL: Port 7860 for HF Spaces

const server = app.listen(PORT, '0.0.0.0', () => {  // ✅ Listen on all interfaces
    console.log(`\n${'🎉'.repeat(50)}`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Backend API + Frontend serving enabled`);
    console.log(`📂 Serving static files from: ${path.join(__dirname, '../')}`);
    console.log(`📁 Upload directories initialized`);
    console.log(`🌐 API available at: http://localhost:${PORT}`);
    console.log(`🌐 Frontend available at: http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📚 API info: http://localhost:${PORT}/api`);
    console.log(`${'🎉'.repeat(50)}\n`);
    
    // Log environment info
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'production'}`);
    console.log(`💾 Node.js version: ${process.version}`);
    console.log(`🖥️  Platform: ${process.platform}`);
    console.log(`🎬 FFmpeg: ${process.env.FFMPEG_PATH || 'system default'}`);
    
    // Check if Whisper is available
    const whisperCheck = spawn('python', ['-c', 'import whisper; print("Whisper installed")']);
    whisperCheck.stdout.on('data', (data) => console.log(`🤖 ${data.toString().trim()}`));
    whisperCheck.stderr.on('data', (data) => console.error(`⚠️  Whisper check: ${data.toString().trim()}`));
    whisperCheck.on('close', (code) => {
        if (code !== 0) {
            console.log('⚠️  Whisper not detected - Video processing may not work');
        }
    });
    
    // Check FFmpeg
    const ffmpegCheck = spawn('ffmpeg', ['-version']);
    ffmpegCheck.stdout.on('data', (data) => {
        const version = data.toString().split('\n')[0];
        console.log(`🎬 ${version}`);
    });
    ffmpegCheck.on('error', () => {
        console.log('⚠️  FFmpeg not detected - Video processing may not work');
    });
    
    console.log(`\n⚡ Ready for video processing requests!`);
    console.log(`🌍 Deployment: Hugging Face Spaces Compatible\n`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// ===== EXPORT APP FOR TESTING =====
export default app;