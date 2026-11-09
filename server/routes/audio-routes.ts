'use strict';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { authenticateHybrid } from '../middleware/hybrid-auth';
import { strictRateLimiter } from '../middleware/rateLimiter';
import {
  AUDIO_OWNERS_DIR,
  recordAudioOwner,
  readAudioOwner,
  removeAudioOwner,
  canDeleteAudio,
} from '../services/audio-ownership.mjs';
import { logger } from '../utils/logger';

const router = Router();

// Ensure audio directory exists
const AUDIO_DIR = path.join(process.cwd(), 'public', 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// Configure multer for audio uploads
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, AUDIO_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uuid = randomUUID();
    cb(null, `${uuid}${ext}`);
  },
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/wave', 'audio/x-wav'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only MP3 and WAV files are allowed'));
  }
};

const upload = multer({
  storage: audioStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// POST /api/audio/upload - Upload audio file
router.post('/upload', authenticateHybrid as any, upload.single('audio'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const url = `/audio/${req.file.filename}`;
    try {
      recordAudioOwner(AUDIO_OWNERS_DIR, req.file.filename, (req as any).userId);
    } catch (ownerError) {
      // Without an owner record nobody but an admin could delete the file, so do not keep it.
      fs.unlinkSync(req.file.path);
      throw ownerError;
    }
    logger.info(`[AudioUpload] User ${(req as any).userId} uploaded: ${req.file.originalname} -> ${url}`);

    res.json({
      url,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  } catch (error) {
    logger.error('[AudioUpload] Error:', error);
    res.status(500).json({ error: 'Failed to upload audio file' });
  }
});

// DELETE /api/audio/:filename - Delete audio file (owner or admin only)
router.delete('/:filename', authenticateHybrid as any, strictRateLimiter, (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(AUDIO_DIR, filename);

    // Security: ensure filename doesn't contain path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const requesterId = (req as any).userId as string | undefined;
    const requesterRole = (req as any).userRole as string | undefined;
    const ownerId = readAudioOwner(AUDIO_OWNERS_DIR, filename);
    if (!canDeleteAudio({ ownerId, requesterId, requesterRole })) {
      return res.status(403).json({ error: 'You do not have permission to delete this audio file' });
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removeAudioOwner(AUDIO_OWNERS_DIR, filename);
      logger.info(`[AudioUpload] Deleted: ${filename} by ${requesterId}`);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[AudioUpload] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete audio file' });
  }
});

export default router;
