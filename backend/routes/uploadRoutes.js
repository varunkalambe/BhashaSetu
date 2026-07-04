import express from "express";
import { uploadVideo } from "../controllers/uploadController.js";
import upload from "../middleware/multer.js";

const router = express.Router();

// Single video upload
router.post("/", upload.single("video"), uploadVideo);

export default router;
