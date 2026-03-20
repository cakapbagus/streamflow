const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');
const Video = require('../models/Video');

let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
} else {
  ffmpegPath = ffmpegInstaller.path;
}

let ffprobePath;
if (fs.existsSync('/usr/bin/ffprobe')) {
  ffprobePath = '/usr/bin/ffprobe';
} else {
  ffprobePath = ffprobeInstaller.path;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Build FFmpeg overlay/text filter arguments.
 * Returns null if no overlay/text is configured.
 * Returns { type: 'vf_append', vfAppend } for text-only.
 * Returns { type: 'filter_complex', logoPath, logoFlags, filterComplex } for logo (with optional text).
 *
 * Layout: full-width background bar (drawbox) + scrolling text (drawtext), logo rendered on top.
 * When logo and ticker are on the same side (top/bottom), the logo overlays the ticker bar corner,
 * creating a natural side-by-side appearance [SCROLLING TEXT][LOGO].
 */
function buildOverlayFilters(stream, { vfBase, isPlaylistWithAudio = false, sourceLabel = null, overrideLogoInputIndex = null }) {
  const projectRoot = path.resolve(__dirname, '..');

  let logoFullPath = null;
  if (stream.overlay_logo_path) {
    const relPath = stream.overlay_logo_path.replace(/^\//, '');
    const candidate = path.join(projectRoot, 'public', relPath);
    if (fs.existsSync(candidate)) {
      logoFullPath = candidate;
    }
  }

  const hasLogo = !!logoFullPath;
  const hasText = !!(stream.scrolling_text && stream.scrolling_text.trim());

  if (!hasLogo && !hasText) return null;

  // Font file path for Roboto
  const fontFilePath = path.join(projectRoot, 'public', 'font', 'Roboto-Medium.ttf');
  const fontFileExists = fs.existsSync(fontFilePath);
  const escapedFontPath = fontFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');

  // Build ticker filter chain: drawbox (full-width bg bar) + drawtext (scrolling text)
  // tickerFilters is a filter chain string to be appended after vfBase (starts with ',')
  let tickerFilters = '';
  if (hasText) {
    const rawText = stream.scrolling_text.trim();
    const escapedText = rawText
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/,/g, '\\,')
      .replace(/'/g, '\u2019');

    const speed = Math.max(parseInt(stream.scrolling_text_speed) || 80, 10);
    const colorRaw = (stream.scrolling_text_color || 'ffffff').replace('#', '');
    const color = /^[a-zA-Z0-9]+$/.test(colorRaw) ? colorRaw : 'ffffff';
    const bgColorRaw = (stream.scrolling_text_bg_color || '000000').replace('#', '');
    const bgColor = /^[a-zA-Z0-9]+$/.test(bgColorRaw) ? bgColorRaw : '000000';
    const bgOpacityRaw = parseFloat(stream.scrolling_text_bg_opacity);
    const bgOpacity = isNaN(bgOpacityRaw) ? 0.80 : Math.min(Math.max(bgOpacityRaw / 100, 0), 1);
    const size = Math.min(Math.max(parseInt(stream.scrolling_text_size) || 28, 8), 150);
    const barH = size + 20;
    const textPosition = stream.scrolling_text_position || 'bottom';

    const boxY = textPosition === 'top' ? '0' : `ih-${barH}`;
    const textY = textPosition === 'top' ? '10' : `h-th-10`;

    const fontPart = fontFileExists ? `fontfile='${escapedFontPath}':` : '';

    // drawbox: full-width background bar (skipped when fully transparent)
    const drawboxPart = bgOpacity > 0
      ? `drawbox=x=0:y=${boxY}:w=iw:h=${barH}:color=0x${bgColor}@${bgOpacity.toFixed(2)}:t=fill,`
      : '';

    // drawtext: scrolling text without individual box (background handled by drawbox)
    const drawtextPart = `drawtext=${fontPart}text='${escapedText}':fontsize=${size}:fontcolor=0x${color}:x=w-mod(t*${speed}\\,w+tw):y=${textY}`;

    tickerFilters = `,${drawboxPart}${drawtextPart}`;
  }

  if (hasLogo) {
    const scaleFactor = Math.min(Math.max(parseFloat(stream.overlay_logo_scale) || 0.15, 0.02), 0.5);
    const opacityRaw = parseFloat(stream.overlay_logo_opacity);
    const opacity = isNaN(opacityRaw) ? 1.0 : Math.min(Math.max(opacityRaw, 0), 1);
    const position = stream.overlay_logo_position || 'bottom-right';

    let overlayX, overlayY;
    switch (position) {
      case 'top-left':     overlayX = '10';       overlayY = '10'; break;
      case 'bottom-left':  overlayX = '10';       overlayY = 'H-h-10'; break;
      case 'top-right':    overlayX = 'W-w-10';   overlayY = '10'; break;
      default:             overlayX = 'W-w-10';   overlayY = 'H-h-10'; // bottom-right
    }

    // Logo input index: explicit override > playlist with audio (2) > default single video (1)
    const logoInputIndex = overrideLogoInputIndex !== null ? overrideLogoInputIndex
      : (isPlaylistWithAudio ? 2 : 1);

    let logoChain = `[${logoInputIndex}:v]scale=iw*${scaleFactor}:-1,format=rgba`;
    if (opacity < 0.99) {
      logoChain += `,colorchannelmixer=aa=${opacity.toFixed(2)}`;
    }
    logoChain += `[logo]`;

    const ext = path.extname(logoFullPath).toLowerCase();
    const logoFlags = ext === '.gif' ? ['-stream_loop', '-1'] : ['-loop', '1'];

    // When sourceLabel is provided (concat mode), use it directly instead of [0:v]+vfBase
    const videoSource = sourceLabel || `[0:v]${vfBase}`;

    if (hasText) {
      const filterComplex = `${videoSource}${tickerFilters}[with_text];${logoChain};[with_text][logo]overlay=${overlayX}:${overlayY}[out]`;
      return { type: 'filter_complex', logoPath: logoFullPath, logoFlags, filterComplex };
    } else {
      const filterComplex = `${videoSource}[scaled];${logoChain};[scaled][logo]overlay=${overlayX}:${overlayY}[out]`;
      return { type: 'filter_complex', logoPath: logoFullPath, logoFlags, filterComplex };
    }
  }

  // Text only — append ticker filters to -vf
  return { type: 'vf_append', vfAppend: tickerFilters };
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
  cleanupTempFiles(streamId);
}

function getRetryDelay(retryCount) {
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(1.5, retryCount), MAX_RETRY_DELAY);
  return delay + Math.random() * 1000;
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
  const bitrate = stream.use_advanced_settings ? (stream.bitrate || 3000) : 3000;
  const fps = stream.use_advanced_settings ? (stream.fps || 30) : 30;

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

  const [width, height] = resolution.split('x');
  const vfBase = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  const overlay = buildOverlayFilters(stream, {
    vfBase,
    isPlaylistWithAudio: hasAudioBg,
    sourceLabel: null,
    overrideLogoInputIndex: null,
  });

  const baseInputArgs = [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
  ];

  const encodingArgs = [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps * 2),
    '-sc_threshold', '0',
  ];

  // semua audio sudah di normalisasi jadi tinggal gunakan saja tanpa encoding ulang
  const audioArgs = [
    '-c:a', 'copy',
  ];

  const outputArgs = ['-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrl];

  // ─── CONCAT DEMUXER MODE (tanpa background audio) ───────────────────────
  if (!hasAudioBg) {
    if (!overlay) {
      return [
        ...baseInputArgs,
        '-map', '0:v:0', '-map', '0:a:0',
        ...encodingArgs,
        '-vf', vfBase, '-r', String(fps),
        ...audioArgs,
        ...outputArgs,
      ];
    } else if (overlay.type === 'vf_append') {
      return [
        ...baseInputArgs,
        '-map', '0:v:0', '-map', '0:a:0',
        ...encodingArgs,
        '-vf', vfBase + overlay.vfAppend, '-r', String(fps),
        ...audioArgs,
        ...outputArgs,
      ];
    } else {
      // Logo overlay — logo adalah input [1]
      return [
        ...baseInputArgs,
        ...overlay.logoFlags, '-i', overlay.logoPath,
        ...encodingArgs,
        '-filter_complex', overlay.filterComplex,
        '-map', '[out]', '-map', '0:a:0',
        '-r', String(fps),
        ...audioArgs,
        ...outputArgs,
      ];
    }
  }

  // ─── CONCAT DEMUXER MODE (with background audio) ───────────────────────
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

  // additional input for audio background
  baseInputArgs.push('-re', '-f', 'concat', '-safe', '0', '-i', audioConcatFile);

  if (!overlay) {
    return [
      ...baseInputArgs,
      '-map', '0:v:0', '-map', '1:a:0',
      ...encodingArgs,
      '-vf', vfBase, '-r', String(fps),
      ...audioArgs,
      '-shortest',
      ...outputArgs,
    ];
  } else if (overlay.type === 'vf_append') {
    return [
      ...baseInputArgs,
      '-map', '0:v:0', '-map', '1:a:0',
      ...encodingArgs,
      '-vf', vfBase + overlay.vfAppend, '-r', String(fps),
      ...audioArgs,
      '-shortest',
      ...outputArgs,
    ];
  } else {
    // filter_complex with logo (logo is input [2])
    return [
      ...baseInputArgs,
      ...overlay.logoFlags, '-i', overlay.logoPath,
      ...encodingArgs,
      '-filter_complex', overlay.filterComplex,
      '-map', '[out]', '-map', '1:a:0',
      '-r', String(fps),
      ...audioArgs,
      '-shortest',
      ...outputArgs,
    ];
  }
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

  const resolution = stream.use_advanced_settings ? (stream.resolution || '1280x720') : '1280x720';
  const bitrate = stream.use_advanced_settings ? (stream.bitrate || 3000) : 3000;
  const fps = stream.use_advanced_settings ? (stream.fps || 30) : 30;

  const [width, height] = resolution.split('x');
  const vfBase = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  const overlay = buildOverlayFilters(stream, { vfBase, isPlaylistWithAudio: false });

  const inputArgs = [
    '-nostdin', '-loglevel', 'warning', '-stats', '-re',
    '-fflags', '+genpts+igndts+discardcorrupt', '-avoid_negative_ts', 'make_zero',
    '-stream_loop', loopValue, '-i', videoPath,
  ];

  const encodingArgs = [
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.5)}k`, '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
  ];

  // semua audio sudah di normalisasi jadi tinggal gunakan saja tanpa encoding ulang
  const audioArgs = [
    '-c:a', 'copy',
  ];

  const outputArgs = ['-f', 'flv', '-flvflags', 'no_duration_filesize', rtmpUrl];

  if (!overlay) {
    return [...inputArgs, ...encodingArgs, '-vf', vfBase, '-r', String(fps), ...audioArgs, ...outputArgs];
  } else if (overlay.type === 'vf_append') {
    return [...inputArgs, ...encodingArgs, '-vf', vfBase + overlay.vfAppend, '-r', String(fps), ...audioArgs, ...outputArgs];
  } else {
    return [
      ...inputArgs,
      ...overlay.logoFlags, '-i', overlay.logoPath,
      ...encodingArgs,
      '-filter_complex', overlay.filterComplex,
      '-map', '[out]', '-map', '0:a:0',
      '-r', String(fps),
      ...audioArgs,
      ...outputArgs,
    ];
  }
}

async function killFFmpegProcess(streamData) {
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
        await killFFmpegProcess(existing);
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

      // ── Loop playlist restart ────────────────────────────────────────────────
      // Clean exit (code=0) + loop_video=true → concat file selesai dibaca.
      // Restart untuk melanjutkan loop tak terbatas.
      if (code === 0 && signal === null && currentStream &&
          currentStream.loop_video && currentStream.status !== 'offline') {
        addStreamLog(streamId, '[Loop] Playlist batch complete, restarting...');
        try {
          const result = await startStream(streamId, true, baseUrl);
          if (!result.success) {
            addStreamLog(streamId, `[Loop] Restart failed: ${result.error}`);
            await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
            if (schedulerService) schedulerService.handleStreamStopped(streamId);
            cleanupStreamData(streamId);
          }
        } catch (e) {
          addStreamLog(streamId, `[Loop] Restart error: ${e.message}`);
          try { await Stream.updateStatus(streamId, 'offline', currentStream.user_id); } catch (_) {}
          cleanupStreamData(streamId);
        }
        return;
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

    await killFFmpegProcess(streamData);

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
              await killFFmpegProcess(streamData);
              activeStreams.delete(streamId);
              manuallyStoppingStreams.delete(streamId);
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }

          manuallyStoppingStreams.add(streamId);
          await killFFmpegProcess(streamData);
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
      await killFFmpegProcess(streamData);

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
