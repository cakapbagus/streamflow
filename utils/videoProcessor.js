const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { getVideoDurationInSeconds } = require('get-video-duration');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { paths } = require('./storage');
ffmpeg.setFfmpegPath(ffmpegPath);
const getVideoInfo = async (filepath) => {
  try {
    const duration = await getVideoDurationInSeconds(filepath);
    const stats = fs.statSync(filepath);
    const fileSizeInBytes = stats.size;
    return {
      duration,
      fileSize: fileSizeInBytes
    };
  } catch (error) {
    console.error('Error getting video info:', error);
    throw error;
  }
};
const generateThumbnail = (videoPath, thumbnailName) => {
  return new Promise((resolve, reject) => {
    const thumbnailPath = path.join(paths.thumbnails, thumbnailName);
    ffmpeg(videoPath)
      .screenshots({
        count: 1,
        folder: paths.thumbnails,
        filename: thumbnailName,
        size: '320x180'
      })
      .on('end', () => {
        resolve(thumbnailPath);
      })
      .on('error', (err) => {
        console.error('Error generating thumbnail:', err);
        reject(err);
      });
  });
};

const generateImageThumbnail = (imagePath, thumbnailName) => {
  return new Promise((resolve, reject) => {
    const thumbnailPath = path.join(paths.thumbnails, thumbnailName);
    ffmpeg(imagePath)
      .outputOptions([
        '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2'
      ])
      .output(thumbnailPath)
      .on('end', () => {
        resolve(thumbnailPath);
      })
      .on('error', (err) => {
        console.error('Error generating image thumbnail:', err);
        reject(err);
      })
      .run();
  });
};

const AUDIO_TARGET = { codec: 'aac', sampleRate: 44100, channels: 2, bitrate: '128k' };

/**
 * Probe audio stream dari video. Kembalikan objek stream atau null jika tidak ada audio nyata.
 */
function probeAudioStream(videoPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-select_streams', 'a',
      '-show_entries', 'stream=codec_name,sample_rate,channels,nb_frames,duration',
      videoPath
    ];
    const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.once('exit', () => {
      try {
        const info = JSON.parse(output);
        const stream = info.streams && info.streams[0];
        if (!stream || !stream.codec_name || stream.codec_name === 'none') {
          return resolve(null);
        }
        const nbFrames = parseInt(stream.nb_frames);
        const duration = parseFloat(stream.duration);
        const hasRealFrames = isNaN(nbFrames) || nbFrames > 0;
        const hasRealDuration = isNaN(duration) || duration > 0;
        resolve((hasRealFrames && hasRealDuration) ? stream : null);
      } catch {
        resolve(null);
      }
    });
    proc.once('error', () => resolve(null));
  });
}

/**
 * Normalisasi audio track video ke AAC 44.1kHz stereo 128kbps.
 * - Jika tidak ada audio → tambah silent track ternormalisasi.
 * - Jika ada audio tapi belum ternormalisasi → re-encode audio saja (-c:v copy).
 * - Jika sudah ternormalisasi → skip.
 * File asli diganti di tempat (in-place replace).
 */
async function ensureAudioTrack(videoPath) {
  const audioStream = await probeAudioStream(videoPath);

  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const tmpPath = path.join(dir, `${base}_audiofix${ext}`);

  let args;

  if (!audioStream) {
    // Tidak ada audio → tambah silent AAC ternormalisasi
    console.log(`[ensureAudioTrack] No audio, adding silent track: ${path.basename(videoPath)}`);
    args = [
      '-i', videoPath,
      '-f', 'lavfi', '-i', `anullsrc=r=${AUDIO_TARGET.sampleRate}:cl=stereo`,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', String(AUDIO_TARGET.sampleRate),
      '-ac', String(AUDIO_TARGET.channels),
      '-b:a', AUDIO_TARGET.bitrate,
      '-shortest',
      '-movflags', '+faststart',
      '-y',
      tmpPath
    ];
  } else {
    // Cek apakah sudah ternormalisasi
    const isNormalized =
      audioStream.codec_name === AUDIO_TARGET.codec &&
      parseInt(audioStream.sample_rate) === AUDIO_TARGET.sampleRate &&
      audioStream.channels === AUDIO_TARGET.channels;

    if (isNormalized) return;

    // Ada audio tapi perlu re-encode
    console.log(`[ensureAudioTrack] Normalizing audio: ${path.basename(videoPath)}`);
    args = [
      '-i', videoPath,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', String(AUDIO_TARGET.sampleRate),
      '-ac', String(AUDIO_TARGET.channels),
      '-b:a', AUDIO_TARGET.bitrate,
      '-movflags', '+faststart',
      '-y',
      tmpPath
    ];
  }

  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.once('exit', (code) => {
      if (code === 0) {
        console.log(`[ensureAudioTrack] Done: ${path.basename(videoPath)}`);
        resolve();
      } else {
        fs.unlink(tmpPath, () => {});
        reject(new Error(`ensureAudioTrack FFmpeg failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
    proc.once('error', (err) => {
      fs.unlink(tmpPath, () => {});
      reject(err);
    });
  });

  fs.unlinkSync(videoPath);
  fs.renameSync(tmpPath, videoPath);
}

module.exports = {
  getVideoInfo,
  generateThumbnail,
  generateImageThumbnail,
  ensureAudioTrack
};