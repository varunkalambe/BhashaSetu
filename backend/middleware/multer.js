import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ✅ UNIVERSAL PATH: Works on Windows, Linux, Docker
const uploadPath = process.platform === 'linux' && fs.existsSync('/app')
    ? "/app/uploads/originals"  // Docker/HF Spaces
    : path.join(process.cwd(), 'uploads', 'originals');  // Local development

console.log(`📁 Upload path configured: ${uploadPath}`);
console.log(`📁 Platform: ${process.platform}, Environment: ${process.env.NODE_ENV || 'development'}`);

// Ensure directory exists
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true, mode: 0o777 });
  console.log(`📁 Created directory: ${uploadPath}`);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    console.log(`📤 Saving file to: ${uploadPath}`);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const filename = Date.now() + path.extname(file.originalname);
    console.log(`📝 Generated filename: ${filename}`);
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ["video/mp4", "video/avi", "video/quicktime", "video/x-ms-wmv"];
  const isAllowed = allowedTypes.includes(file.mimetype);
  console.log(`🔍 File type: ${file.mimetype}, Allowed: ${isAllowed}`);
  cb(null, isAllowed);
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

export default upload;
