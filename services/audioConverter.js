const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const path = require('path');
const fs = require('fs-extra');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const getAudioInfo = (filepath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) {
        return reject(err);
      }
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      resolve({
        duration: metadata.format.duration || 0,
        codec: audioStream ? audioStream.codec_name : null,
        bitrate: metadata.format.bit_rate ? Math.round(parseInt(metadata.format.bit_rate) / 1000) : null,
        sampleRate: audioStream ? audioStream.sample_rate : null,
        channels: audioStream ? audioStream.channels : null,
        fileSize: metadata.format.size || 0
      });
    });
  });
};

const TARGET_SAMPLE_RATE = 44100;
const TARGET_CHANNELS = 2;

const isNormalized = async (filepath) => {
  const info = await getAudioInfo(filepath);
  const ext = path.extname(filepath).toLowerCase();
  return (
    info.codec === 'aac' &&
    ext === '.m4a' &&
    parseInt(info.sampleRate) === TARGET_SAMPLE_RATE &&
    info.channels === TARGET_CHANNELS
  );
};

const convertToAac = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('aac')
      .audioBitrate('128k')
      .audioFrequency(TARGET_SAMPLE_RATE)
      .audioChannels(TARGET_CHANNELS)
      .outputOptions(['-vn'])
      .toFormat('ipod')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(err);
      })
      .save(outputPath);
  });
};

const processAudioFile = async (inputPath, originalFilename) => {
  const alreadyNormalized = await isNormalized(inputPath);

  if (alreadyNormalized) {
    return {
      filepath: inputPath,
      converted: false
    };
  }

  const basename = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(path.dirname(inputPath), `${basename}.m4a`);

  await convertToAac(inputPath, outputPath);

  if (inputPath !== outputPath && fs.existsSync(inputPath)) {
    await fs.remove(inputPath);
  }

  return {
    filepath: outputPath,
    converted: true
  };
};

const generateAudioThumbnail = (outputPath) => {
  return new Promise((resolve) => {
    const defaultThumb = '/images/audio-thumbnail.svg';
    resolve(defaultThumb);
  });
};

module.exports = {
  getAudioInfo,
  convertToAac,
  processAudioFile,
  generateAudioThumbnail
};
