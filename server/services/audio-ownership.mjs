/**
 * Owner records for uploaded audio files.
 *
 * Audio is served statically from public/audio, so owner records are kept in a
 * separate directory (data/audio-owners) that is never served. One JSON file per
 * audio file, named after it.
 *
 * Files uploaded before this module existed have no record. They can be deleted
 * only by an admin (fail closed).
 *
 * Plain .mjs with no db or config imports, so it can be unit-tested with `node --test`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const AUDIO_OWNERS_DIR = path.join(process.cwd(), 'data', 'audio-owners');

// Upload names are randomUUID() + a lowercase extension. Anything else is refused.
const SAFE_AUDIO_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/;

export function isSafeAudioName(filename) {
  return typeof filename === 'string' && SAFE_AUDIO_NAME.test(filename);
}

function recordPath(ownersDir, filename) {
  if (!isSafeAudioName(filename)) throw new Error('Invalid audio filename');
  return path.join(ownersDir, `${filename}.json`);
}

export function recordAudioOwner(ownersDir, filename, userId) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('An owner id is required to record an audio file');
  }
  fs.mkdirSync(ownersDir, { recursive: true });
  // flag 'wx' refuses to overwrite an existing record.
  fs.writeFileSync(
    recordPath(ownersDir, filename),
    JSON.stringify({ userId, createdAt: new Date().toISOString() }),
    { flag: 'wx' }
  );
}

// Returns the owner id, or null when there is no record or the record is unreadable.
export function readAudioOwner(ownersDir, filename) {
  if (!isSafeAudioName(filename)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(recordPath(ownersDir, filename), 'utf8'));
    return typeof record.userId === 'string' && record.userId.length > 0 ? record.userId : null;
  } catch {
    return null;
  }
}

export function removeAudioOwner(ownersDir, filename) {
  if (!isSafeAudioName(filename)) return;
  try {
    fs.unlinkSync(recordPath(ownersDir, filename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Owner or admin only. A missing owner record allows admins only.
export function canDeleteAudio({ ownerId, requesterId, requesterRole }) {
  if (typeof requesterId !== 'string' || requesterId.length === 0) return false;
  if (requesterRole === 'admin') return true;
  return typeof ownerId === 'string' && ownerId === requesterId;
}
