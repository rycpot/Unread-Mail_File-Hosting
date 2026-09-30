// Video and audio files, by type or name. Shared by the attachment viewer and
// the background download (which leaves large videos until they are opened).

const VIDEO = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', ogv: 'video/ogg' };
const AUDIO = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm',
};

// 'video', 'audio' or null.
export function mediaKind(filename = '', mimeType = '') {
  const type = mimeType.toLowerCase();
  const ext = filename.toLowerCase().split('.').pop();
  if (type.startsWith('video/') || VIDEO[ext]) return 'video';
  if (type.startsWith('audio/') || AUDIO[ext]) return 'audio';
  return null;
}

// The type to hand Chrome's player (mail often says application/octet-stream).
export function mediaType(filename = '', mimeType = '') {
  const type = mimeType.toLowerCase();
  if (type.startsWith('video/') || type.startsWith('audio/')) return type;
  const ext = filename.toLowerCase().split('.').pop();
  return VIDEO[ext] ?? AUDIO[ext] ?? '';
}
