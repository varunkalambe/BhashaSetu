import express from "express";
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Video streaming route with range request support
router.get('/originals/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(process.cwd(), 'uploads', 'originals', filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Video not found');
    }
    
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
        // Parse Range header
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        
        // Set proper headers for range request
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': getContentType(filename),
        };
        
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        // No range request - serve entire file
        const head = {
            'Content-Length': fileSize,
            'Content-Type': getContentType(filename),
            'Accept-Ranges': 'bytes'
        };
        
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// Helper function for content types
function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
        '.mp4': 'video/mp4',
        '.avi': 'video/avi', 
        '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv',
        '.webm': 'video/webm'
    };
    return contentTypes[ext] || 'application/octet-stream';
}

export default router;
