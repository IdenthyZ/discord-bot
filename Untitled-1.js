// Configuración de FFmpeg para Windows
const ffmpegBin = 'C:\\ffmpeg\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
const ffprobeBin = 'C:\\ffmpeg\\ffmpeg-8.0.1-essentials_build\\bin\\ffprobe.exe';
process.env.FFMPEG_PATH = ffmpegBin;
process.env.FFPROBE_PATH = ffprobeBin;
process.env.PRISM_MEDIA_FFMPEG_PATH = ffmpegBin;