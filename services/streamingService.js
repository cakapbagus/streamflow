const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');
const Video = require('../models/Video');
const { getOverlaySettings } = require('../models/overlayModel');

let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
} else {
  ffmpegPath = ffmpegInstaller.path;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const manuallyStoppingStreams = new Set();

const MAX_LOG_LINES = 50;
const MAX_RETRY_ATTEMPTS = 15;
const BASE_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;
const HEALTH_CHECK_INTERVAL = 30000;
const SYNC_INTERVAL = 60000;

let schedulerService = null;
let syncIntervalId = null;
let healthCheckIntervalId = null;
let initialized = false;

function setSchedulerService(service) {
  schedulerService = service;

  if (!initialized) {
    initialized = true;
    syncIntervalId = setInterval(syncStreamStatuses, SYNC_INTERVAL);
    healthCheckIntervalId = setInterval(healthCheckStreams, HEALTH_CHECK_INTERVAL);
  }
}

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({ timestamp: new Date().toISOString(), message });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
  // Also log to console for playlist transition debugging in development
  if (process.env.NODE_ENV?.toLowerCase() === 'development' && (message.includes('Playing') || message.includes('frame=') || message.includes('bitrate='))) {
    console.log(`[Stream ${streamId}] ${message}`);
  }
}

function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

function cleanupStreamData(streamId) {
  streamRetryCount.delete(streamId);
  manuallyStoppingStreams.delete(streamId);
}

function getRetryDelay(retryCount) {
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(1.5, retryCount), MAX_RETRY_DELAY);
  return delay + Math.random() * 1000;
}

function buildOverlayFilter(overlay) {
  if (!overlay || !overlay.enabled || !overlay.image_path) return null;

  const opacity = Math.min(1, Math.max(0, overlay.opacity ?? 1));
  const x = overlay.position_x ?? 10;
  const y = overlay.position_y ?? 10;
  const w = overlay.width ?? 150;
  const h = overlay.height ?? 150;

  // FFmpeg overlay filter: scale logo → atur opacity → overlay ke posisi
  return `movie='${overlay.image_path.replace(/\\/g, '/')}',scale=${w}:${h},format=rgba,colorchannelmixer=aa=${opacity}[logo];[in][logo]overlay=${x}:${y}[out]`;
}

async function buildFFmpegArgsForPlaylist(stream, playlist) {
  if (!playlist.videos || playlist.videos.length === 0) {
    throw new Error('Playlist is empty');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const tempDir = path.join(projectRoot, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const videos = playlist.is_shuffle ? shuffleArray(playlist.videos) : playlist.videos;
  const hasAudioBg = playlist.audios && playlist.audios.length > 0;

  const resolution = stream.use_advanced_settings ? (stream.resolution || '1280x720') : '1280x720';
  const bitrate = stream.use_advanced_settings ? (stream.bitrate || 2500) : 2500;
  const fps = stream.use_advanced_settings ? (stream.fps || 30) : 30;

  // ─── SEQUENTIAL MODE (tanpa background audio) ────────────────────────────
  // Setiap video di-treat seperti single file (buildFFmpegArgs satuan),
  // dijalankan satu per satu dalam loop di startStream.
  // Ini menghindari masalah resolusi/audio-track mismatch pada ffmpeg concat.
  if (!hasAudioBg) {
    let videoPaths = [];
    for (const video of videos) {
      const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
      const fullPath = path.join(projectRoot, 'public', relPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Video file not found: ${fullPath}`);
      }
      videoPaths.push(fullPath);
    }

    // Return sequential descriptor — ditangani oleh startStream bukan spawn langsung
    return {
      __sequentialPlaylist: true,
      videoPaths,
      loop: !!stream.loop_video,
      rtmpUrl,
      resolution,
      bitrate,
      fps,
    };
  }

  // WITH BACKGROUND AUDIO
  // Build video concat file (hanya dipakai untuk mode hasAudioBg)
  let videoPaths = [];
  for (const video of videos) {
    const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Video file not found: ${fullPath}`);
    }
    videoPaths.push(fullPath);
  }

  const concatFile = path.join(tempDir, `playlist_${stream.id}.txt`);
  const loopCount = stream.loop_video ? 10000 : 1;
  let content = '';
  for (let i = 0; i < loopCount; i++) {
    for (const vp of videoPaths) {
      content += `file '${vp.replace(/\\/g, '/')}'\n`;
    }
  }
  try {
    fs.writeFileSync(concatFile, content);
  } catch (err) {
    if (err.code === 'ENOSPC') throw new Error('ENOSPC: Server disk is full. Cannot write playlist file.');
    throw err;
  }

  let audioPaths = [];
  const audios = playlist.is_shuffle ? shuffleArray(playlist.audios) : playlist.audios;

  for (const audio of audios) {
    const relPath = audio.filepath.startsWith('/') ? audio.filepath.substring(1) : audio.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audio file not found: ${fullPath}`);
    }
    audioPaths.push(fullPath);
  }

  const audioConcatFile = path.join(tempDir, `playlist_audio_${stream.id}.txt`);
  let audioContent = '';
  for (let i = 0; i < 10000; i++) {
    for (const ap of audioPaths) {
      audioContent += `file '${ap.replace(/\\/g, '/')}'\n`;
    }
  }
  try {
    fs.writeFileSync(audioConcatFile, audioContent);
  } catch (err) {
    if (err.code === 'ENOSPC') throw new Error('ENOSPC: Server disk is full. Cannot write audio playlist file.');
    throw err;
  }

  const overlay = getOverlaySettings(stream.user_id);
  const overlayFilter = buildOverlayFilter(overlay);

  const [width, height] = resolution.split('x');
  const vfFilter = overlayFilter
    ? `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,${overlayFilter}`  // scale dulu, baru overlay
    : `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-vsync', 'cfr',          // ← tambahkan ini: paksa constant frame rate
    '-async', '1',            // ← sinkronisasi audio ke video
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-f', 'concat',
    '-safe', '0',
    '-i', audioConcatFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps * 2),
    '-sc_threshold', '0',
    '-vf', vfFilter,
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
    '-shortest',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}

/**
 * Build FFmpeg args untuk satu video dalam sequential playlist.
 * Tidak pakai -stream_loop karena loop dihandle di level sequencer.
 * Video di-normalize ke resolusi/fps/bitrate target agar output stream konsisten.
 */
function buildFFmpegArgsForSingleVideoInPlaylist(stream, videoPath, { rtmpUrl, resolution, bitrate, fps }) {
  const overlay = getOverlaySettings(stream.user_id);
  const overlayFilter = buildOverlayFilter(overlay);

  const [width, height] = resolution.split('x');

  // Gunakan scale+pad agar video dengan rasio berbeda tetap fit tanpa crop
  const vfFilter = overlayFilter
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,${overlayFilter}`  // scale dulu, baru overlay
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-vf', vfFilter,
    '-r', String(fps),
    // Audio: gunakan stream audio jika ada, fallback generate silence jika tidak ada
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}

async function buildFFmpegArgs(stream) {
  const streamWithVideo = await Stream.getStreamWithVideo(stream.id);

  if (streamWithVideo && streamWithVideo.video_type === 'playlist') {
    const playlist = await Playlist.findByIdWithVideos(stream.video_id);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    return await buildFFmpegArgsForPlaylist(stream, playlist);
  }

  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error('Video not found');
  }

  const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relPath);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const loopValue = stream.loop_video ? '-1' : '0';

  const overlay = getOverlaySettings(stream.user_id);
  const overlayFilter = buildOverlayFilter(overlay);

  const resolution = stream.use_advanced_settings ? (stream.resolution || '1280x720') : '1280x720';
  const bitrate = stream.use_advanced_settings ? (stream.bitrate || 2500) : 2500;
  const fps = stream.use_advanced_settings ? (stream.fps || 30) : 30;

  const [width, height] = resolution.split('x');
  const vfFilter = overlayFilter
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,${overlayFilter}`  // scale dulu, baru overlay
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-stream_loop', loopValue,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps * 2),
    '-sc_threshold', '0',
    '-vf', vfFilter,
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}

async function killFFmpegProcess(streamId, streamData) {
  return new Promise((resolve) => {
    if (!streamData || !streamData.process) {
      resolve(true);
      return;
    }

    const proc = streamData.process;

    if (proc.exitCode !== null) {
      resolve(true);
      return;
    }

    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
    };

    proc.once('exit', cleanup);
    proc.once('error', cleanup);

    try {
      proc.kill('SIGTERM');
    } catch (e) { }

    setTimeout(() => {
      if (!resolved) {
        try {
          if (proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        } catch (e) { }
      }
    }, 3000);

    setTimeout(cleanup, 5000);
  });
}

/**
 * Sequential playlist runner — digunakan ketika playlist tidak punya background audio.
 * Setiap video dijalankan seperti single file (bukan ffmpeg concat), satu per satu.
 * Loop seluruh playlist didukung via `config.loop` (10000 iterasi = effectively infinite).
 *
 * Lifecycle: fungsi ini langsung return { success: true } setelah video pertama mulai.
 * Transisi antar video dihandle secara async di dalam runner itu sendiri.
 * activeStreams selalu diisi dengan proses ffmpeg yang sedang berjalan saat ini.
 */
async function startSequentialPlaylist(streamId, stream, config, { isRetry, originalStartTime, originalEndTime, baseUrl }) {
  const { videoPaths, loop, rtmpUrl, resolution, bitrate, fps } = config;
  const totalVideos = videoPaths.length;
  const maxRounds = loop ? 10000 : 1;

  let startTimeIso;
  if (isRetry && originalStartTime) {
    startTimeIso = originalStartTime;
  } else {
    startTimeIso = new Date().toISOString();
  }

  if (!isRetry) {
    await Stream.updateStatus(streamId, 'live', stream.user_id, { startTimeOverride: startTimeIso });
  }

  // Spawn video pertama terlebih dulu secara sinkron agar activeStreams terisi
  // sebelum return, baru sisanya jalan async
  const firstArgs = buildFFmpegArgsForSingleVideoInPlaylist(stream, videoPaths[0], { rtmpUrl, resolution, bitrate, fps });
  addStreamLog(streamId, `[Seq 1/${totalVideos} R1] Playing: ${path.basename(videoPaths[0])}`);

  const firstProc = spawn(ffmpegPath, firstArgs, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  activeStreams.set(streamId, {
    process: firstProc,
    userId: stream.user_id,
    startTime: startTimeIso,
    endTime: originalEndTime,
    pid: firstProc.pid,
    lastActivity: Date.now()
  });

  firstProc.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) { addStreamLog(streamId, `[OUT] ${msg}`); updateStreamActivity(streamId); }
  });
  firstProc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      updateStreamActivity(streamId);
      if (msg.includes('bitrate=') || msg.includes('duplicate_frames')) {
        addStreamLog(streamId, `[Seq 1/${totalVideos} R1] [Metrics] ${msg}`);
      } else if (!(msg.includes('frame=') || msg.includes('speed=') || msg.includes('time='))) {
        addStreamLog(streamId, `[Seq 1/${totalVideos} R1] [FFmpeg] ${msg}`);
      }
    }
  });

  // Setelah video pertama selesai, lanjut via runSequence mulai dari video ke-2
  firstProc.once('exit', async (code, signal) => {
    if (manuallyStoppingStreams.has(streamId)) {
      activeStreams.delete(streamId);
      manuallyStoppingStreams.delete(streamId);
      cleanupStreamData(streamId);
      return;
    }
    // Lanjutkan dari video index 1 (atau round berikutnya jika hanya 1 video)
    const nextIdx = totalVideos > 1 ? 1 : 0;
    const startRound = totalVideos > 1 ? 0 : 1;

    // Reset retry sementara untuk lanjut dari titik ini
    const isError = signal === 'SIGSEGV' || signal === 'SIGKILL' || signal === 'SIGPIPE' ||
      (code !== 0 && code !== null) || (code === null && signal === null);
    if (!isError) streamRetryCount.set(streamId, 0);

    // Jalankan sisa sequence async
    const runRemainder = async () => {
      for (let round = startRound; round < maxRounds; round++) {
        const startIndex = (round === startRound && totalVideos > 1) ? nextIdx : 0;
        for (let idx = startIndex; idx < totalVideos; idx++) {
          if (manuallyStoppingStreams.has(streamId)) {
            addStreamLog(streamId, `[Seq] Stopped before video ${idx + 1}/${totalVideos}`);
            activeStreams.delete(streamId);
            manuallyStoppingStreams.delete(streamId);
            cleanupStreamData(streamId);
            return;
          }

          const videoPath = videoPaths[idx];
          const label = `[Seq ${idx + 1}/${totalVideos} R${round + 1}]`;
          addStreamLog(streamId, `${label} Playing: ${path.basename(videoPath)}`);

          const args = buildFFmpegArgsForSingleVideoInPlaylist(stream, videoPath, { rtmpUrl, resolution, bitrate, fps });
          const proc = spawn(ffmpegPath, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });

          activeStreams.set(streamId, {
            process: proc,
            userId: stream.user_id,
            startTime: startTimeIso,
            endTime: originalEndTime,
            pid: proc.pid,
            lastActivity: Date.now()
          });

          proc.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) { addStreamLog(streamId, `[OUT] ${msg}`); updateStreamActivity(streamId); }
          });
          proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
              updateStreamActivity(streamId);
              if (msg.includes('bitrate=') || msg.includes('duplicate_frames')) {
                addStreamLog(streamId, `${label} [Metrics] ${msg}`);
              } else if (!(msg.includes('frame=') || msg.includes('speed=') || msg.includes('time='))) {
                addStreamLog(streamId, `${label} [FFmpeg] ${msg}`);
              }
            }
          });

          const exitResult = await new Promise((resolve) => {
            proc.once('exit', (c, s) => resolve({ code: c, signal: s }));
            proc.once('error', (err) => {
              addStreamLog(streamId, `${label} Process error: ${err.message}`);
              resolve({ code: 1, signal: null });
            });
          });

          if (manuallyStoppingStreams.has(streamId)) {
            activeStreams.delete(streamId);
            manuallyStoppingStreams.delete(streamId);
            cleanupStreamData(streamId);
            return;
          }

          const cs = await Stream.findById(streamId);
          if (cs && cs.end_time) {
            const et = new Date(cs.end_time);
            if (et.getTime() <= Date.now()) {
              addStreamLog(streamId, `${label} Scheduled end time reached.`);
              activeStreams.delete(streamId);
              await Stream.updateStatus(streamId, 'offline', cs.user_id);
              if (schedulerService) schedulerService.handleStreamStopped(streamId);
              cleanupStreamData(streamId);
              return;
            }
          }

          const errored = exitResult.signal === 'SIGSEGV' || exitResult.signal === 'SIGKILL' ||
            exitResult.signal === 'SIGPIPE' ||
            (exitResult.code !== 0 && exitResult.code !== null) ||
            (exitResult.code === null && exitResult.signal === null);

          if (errored) {
            addStreamLog(streamId, `${label} Error: code=${exitResult.code}, signal=${exitResult.signal}`);
            const rc = streamRetryCount.get(streamId) || 0;
            streamRetryCount.set(streamId, rc + 1);
            if (rc + 1 >= MAX_RETRY_ATTEMPTS) {
              addStreamLog(streamId, `[Seq] Max retries reached, stopping.`);
              activeStreams.delete(streamId);
              if (cs) {
                await Stream.updateStatus(streamId, 'offline', cs.user_id);
                if (schedulerService) schedulerService.handleStreamStopped(streamId);
              }
              cleanupStreamData(streamId);
              return;
            }
          } else {
            streamRetryCount.set(streamId, 0);
            addStreamLog(streamId, `${label} Finished normally.`);
          }
        }
      }

      addStreamLog(streamId, `[Seq] Playlist completed.`);
      activeStreams.delete(streamId);
      const finalStream = await Stream.findById(streamId);
      if (finalStream) {
        await Stream.updateStatus(streamId, 'offline', finalStream.user_id);
        if (schedulerService) schedulerService.handleStreamStopped(streamId);
      }
      cleanupStreamData(streamId);
    };

    runRemainder().catch((err) => {
      addStreamLog(streamId, `[Seq] Unhandled error in sequence: ${err.message}`);
    });
  });

  firstProc.once('error', async (err) => {
    addStreamLog(streamId, `[Seq 1] Process error: ${err.message}`);
    activeStreams.delete(streamId);
    const s = await Stream.findById(streamId);
    if (s) await Stream.updateStatus(streamId, 'offline', s.user_id);
    cleanupStreamData(streamId);
  });

  if (schedulerService && originalEndTime) {
    if (typeof schedulerService.scheduleStreamTerminationByEndTime === 'function') {
      schedulerService.scheduleStreamTerminationByEndTime(streamId, originalEndTime, stream.user_id);
    }
  }

  return {
    success: true,
    message: 'Sequential playlist stream started',
    isAdvancedMode: stream.use_advanced_settings
  };
}

async function startStream(streamId, isRetry = false, baseUrl = null) {
  try {
    if (!isRetry) {
      streamRetryCount.set(streamId, 0);
    }

    if (activeStreams.has(streamId)) {
      const existing = activeStreams.get(streamId);
      if (existing.process && existing.process.exitCode === null) {
        if (!isRetry) {
          return { success: false, error: 'Stream is already active' };
        }
        addStreamLog(streamId, 'Killing existing FFmpeg process before restart...');
        manuallyStoppingStreams.add(streamId);
        await killFFmpegProcess(streamId, existing);
        manuallyStoppingStreams.delete(streamId);
      }
      activeStreams.delete(streamId);
    }

    let stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    const originalStartTime = stream.start_time;
    const originalEndTime = stream.end_time;

    if (stream.is_youtube_api) {
      const youtubeService = require('./youtubeService');
      const effectiveBaseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:7575';

      addStreamLog(streamId, 'Creating YouTube broadcast...');

      try {
        const ytResult = await youtubeService.createYouTubeBroadcast(streamId, effectiveBaseUrl);
        if (!ytResult.success) {
          addStreamLog(streamId, `YouTube broadcast failed: ${ytResult.error}`);
          return { success: false, error: ytResult.error || 'Failed to create YouTube broadcast' };
        }
        stream = await Stream.findById(streamId);
        addStreamLog(streamId, `YouTube broadcast created: ${ytResult.broadcastId}`);
      } catch (ytError) {
        addStreamLog(streamId, `YouTube API error: ${ytError.message}`);
        return { success: false, error: `YouTube API error: ${ytError.message}` };
      }
    }

    if (!stream.rtmp_url || !stream.stream_key) {
      return { success: false, error: 'Missing RTMP URL or stream key' };
    }

    const ffmpegArgs = await buildFFmpegArgs(stream);

    // ─── SEQUENTIAL PLAYLIST MODE ────────────────────────────────────────────
    // Ketika playlist tidak punya background audio, setiap video dijalankan
    // satu per satu seperti single file (bukan ffmpeg concat).
    if (ffmpegArgs && ffmpegArgs.__sequentialPlaylist) {
      return await startSequentialPlaylist(streamId, stream, ffmpegArgs, {
        isRetry,
        originalStartTime,
        originalEndTime,
        baseUrl,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    addStreamLog(streamId, `Starting FFmpeg process`);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let startTimeIso;
    if (isRetry && originalStartTime) {
      startTimeIso = originalStartTime;
    } else {
      startTimeIso = new Date().toISOString();
    }

    activeStreams.set(streamId, {
      process: ffmpegProcess,
      userId: stream.user_id,
      startTime: startTimeIso,
      endTime: originalEndTime,
      pid: ffmpegProcess.pid,
      lastActivity: Date.now()
    });

    if (!isRetry) {
      await Stream.updateStatus(streamId, 'live', stream.user_id, { startTimeOverride: startTimeIso });
    }

    ffmpegProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        addStreamLog(streamId, `[OUT] ${msg}`);
        updateStreamActivity(streamId);
      }
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        updateStreamActivity(streamId);
        // Log important metrics including bitrate for transition monitoring
        if (msg.includes('bitrate=') || msg.includes('duplicate_frames') || msg.includes('concat:')) {
          addStreamLog(streamId, `[Metrics] ${msg}`);
        } else if (!(msg.includes('frame=') || msg.includes('speed=') || msg.includes('time='))) {
          addStreamLog(streamId, `[FFmpeg] ${msg}`);
        }
      }
    });

    ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `FFmpeg exited: code=${code}, signal=${signal}`);

      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);

      if (isManualStop) {
        manuallyStoppingStreams.delete(streamId);
        cleanupStreamData(streamId);
        return;
      }

      const currentStream = await Stream.findById(streamId);

      if (currentStream && currentStream.end_time) {
        const endTime = new Date(currentStream.end_time);
        const now = new Date();
        if (endTime.getTime() <= now.getTime()) {
          addStreamLog(streamId, 'Stream ended - scheduled end time reached');
          if (wasActive) {
            try {
              await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
              if (schedulerService) {
                schedulerService.handleStreamStopped(streamId);
              }
            } catch (e) { }
          }
          cleanupStreamData(streamId);
          return;
        }
      }

      const shouldRetry = signal === 'SIGSEGV' || signal === 'SIGKILL' || signal === 'SIGPIPE' ||
        (code !== 0 && code !== null) || (code === null && signal === null);

      if (shouldRetry && currentStream && currentStream.status !== 'offline') {
        const retryCount = streamRetryCount.get(streamId) || 0;

        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          const delay = getRetryDelay(retryCount);

          addStreamLog(streamId, `Retry #${retryCount + 1} in ${Math.round(delay / 1000)}s`);

          setTimeout(async () => {
            try {
              const latestStream = await Stream.findById(streamId);
              if (latestStream && latestStream.status !== 'offline') {
                if (latestStream.end_time) {
                  const endTime = new Date(latestStream.end_time);
                  const now = new Date();
                  if (endTime.getTime() <= now.getTime()) {
                    await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                    cleanupStreamData(streamId);
                    return;
                  }
                }
                const result = await startStream(streamId, true, baseUrl);
                if (!result.success) {
                  await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                  cleanupStreamData(streamId);
                }
              } else {
                cleanupStreamData(streamId);
              }
            } catch (e) {
              cleanupStreamData(streamId);
            }
          }, delay);
          return;
        } else {
          addStreamLog(streamId, `Max retries (${MAX_RETRY_ATTEMPTS}) reached`);
        }
      }

      if (wasActive && currentStream) {
        try {
          await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
          if (schedulerService) {
            schedulerService.handleStreamStopped(streamId);
          }
        } catch (e) { }
        cleanupStreamData(streamId);
      }
    });

    ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Process error: ${err.message}`);
      activeStreams.delete(streamId);
      try {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      } catch (e) { }
      cleanupStreamData(streamId);
    });

    if (schedulerService && originalEndTime) {
      if (typeof schedulerService.scheduleStreamTerminationByEndTime === 'function') {
        schedulerService.scheduleStreamTerminationByEndTime(streamId, originalEndTime, stream.user_id);
      }
    }

    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings
    };
  } catch (error) {
    addStreamLog(streamId, `Start failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function updateStreamActivity(streamId) {
  const streamData = activeStreams.get(streamId);
  if (streamData) {
    streamData.lastActivity = Date.now();
  }
}

async function stopStream(streamId) {
  try {
    const streamData = activeStreams.get(streamId);
    const stream = await Stream.findById(streamId);

    if (!streamData) {
      if (stream && stream.status === 'live') {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        if (schedulerService) {
          schedulerService.handleStreamStopped(streamId);
        }
        cleanupStreamData(streamId);
        return { success: true, message: 'Stream status fixed' };
      }
      return { success: false, error: 'Stream is not active' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    manuallyStoppingStreams.add(streamId);

    await killFFmpegProcess(streamId, streamData);

    activeStreams.delete(streamId);
    cleanupTempFiles(streamId);

    if (stream) {
      if (stream.is_youtube_api && stream.youtube_broadcast_id) {
        try {
          const youtubeService = require('./youtubeService');
          await youtubeService.deleteYouTubeBroadcast(streamId);
        } catch (e) { }
      }

      await saveStreamHistory(stream);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
    }

    if (schedulerService) {
      schedulerService.handleStreamStopped(streamId);
    }

    cleanupStreamData(streamId);
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    return { success: false, error: error.message };
  }
}

function cleanupTempFiles(streamId) {
  const tempDir = path.join(__dirname, '..', 'temp');
  const files = [
    path.join(tempDir, `playlist_${streamId}.txt`),
    path.join(tempDir, `playlist_audio_${streamId}.txt`)
  ];

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) { }
  }
}

function isStreamActive(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return false;

  if (streamData.process && streamData.process.exitCode !== null) {
    activeStreams.delete(streamId);
    return false;
  }

  return true;
}

function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

function getActiveStreamInfo(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return null;

  return {
    streamId,
    userId: streamData.userId,
    startTime: streamData.startTime,
    endTime: streamData.endTime,
    pid: streamData.pid,
    lastActivity: streamData.lastActivity,
    retryCount: streamRetryCount.get(streamId) || 0
  };
}

async function syncStreamStatuses() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      const isActive = activeStreams.has(stream.id);

      if (!isActive) {
        const retryCount = streamRetryCount.get(stream.id);
        if (retryCount !== undefined && retryCount < MAX_RETRY_ATTEMPTS) {
          continue;
        }

        if (stream.end_time) {
          const endTime = new Date(stream.end_time);
          if (endTime.getTime() <= Date.now()) {
            await Stream.updateStatus(stream.id, 'offline', stream.user_id);
            cleanupStreamData(stream.id);
            continue;
          }
        }

        await Stream.updateStatus(stream.id, 'offline', stream.user_id, { preserveEndTime: true });
        cleanupStreamData(stream.id);
      }
    }

    for (const [streamId, streamData] of activeStreams) {
      const stream = await Stream.findById(streamId);

      if (!stream) {
        const proc = streamData.process;
        if (proc && typeof proc.kill === 'function') {
          try {
            proc.kill('SIGTERM');
          } catch (e) { }
        }
        activeStreams.delete(streamId);
        cleanupStreamData(streamId);
        continue;
      }

      if (stream.status !== 'live') {
        await Stream.updateStatus(streamId, 'live', stream.user_id);
      }

      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        cleanupStreamData(streamId);
      }
    }
  } catch (error) { }
}

async function healthCheckStreams() {
  try {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const [streamId, streamData] of activeStreams) {
      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }
          await Stream.updateStatus(streamId, 'offline', stream.user_id, { preserveEndTime: true });
        }
        cleanupStreamData(streamId);
        continue;
      }

      if (streamData.lastActivity && (now - streamData.lastActivity) > staleThreshold) {
        addStreamLog(streamId, 'Stream appears stale, restarting...');

        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              manuallyStoppingStreams.add(streamId);
              await killFFmpegProcess(streamId, streamData);
              activeStreams.delete(streamId);
              manuallyStoppingStreams.delete(streamId);
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }

          manuallyStoppingStreams.add(streamId);
          await killFFmpegProcess(streamId, streamData);
          activeStreams.delete(streamId);
          manuallyStoppingStreams.delete(streamId);

          setTimeout(async () => {
            try {
              const currentStream = await Stream.findById(streamId);
              if (currentStream && currentStream.status === 'live') {
                await startStream(streamId, true);
              }
            } catch (e) { }
          }, 3000);
        }
      }
    }
  } catch (error) { }
}

async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      return false;
    }

    const startTime = new Date(stream.start_time);
    const endTime = new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);

    if (durationSeconds < 10) {
      return false;
    }

    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;

    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: endTime.toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id
    };

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id
        ],
        function (err) {
          if (err) {
            return reject(err);
          }
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    return false;
  }
}

async function gracefulShutdown() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  const streamIds = Array.from(activeStreams.keys());

  for (const streamId of streamIds) {
    try {
      const streamData = activeStreams.get(streamId);

      manuallyStoppingStreams.add(streamId);
      await killFFmpegProcess(streamId, streamData);

      const stream = await Stream.findById(streamId);
      if (stream) {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      }

      activeStreams.delete(streamId);
      cleanupStreamData(streamId);
    } catch (e) { }
  }
}

process.on('SIGTERM', async () => {
  try {
    await gracefulShutdown();
  } catch (e) {
    console.error('[StreamingService] Error during SIGTERM shutdown:', e);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    await gracefulShutdown();
  } catch (e) {
    console.error('[StreamingService] Error during SIGINT shutdown:', e);
  }
  process.exit(0);
});

module.exports = {
  startStream,
  stopStream,
  isStreamActive,
  getActiveStreams,
  getActiveStreamInfo,
  getStreamLogs,
  syncStreamStatuses,
  healthCheckStreams,
  saveStreamHistory,
  gracefulShutdown,
  setSchedulerService
};
