const fs = require('node:fs');
const path = require('node:path');

const config = require('./config.ts');
const { ensureDir, makeId, nowIso, safeFileName } = require('./utils.ts');

type UploadRecord = {
  id: string;
  kind: string;
  fileId: string;
  fileName: string;
  mimeType: string | null;
  localPath: string;
  size: number | null;
  addedAt: string;
};

async function telegramApi(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

async function getTelegramFilePath(fileId: string): Promise<string> {
  const data = await telegramApi('getFile', { file_id: fileId });
  const filePath = data?.result?.file_path;
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`Telegram did not return a file path for ${fileId}`);
  }
  return filePath;
}

async function downloadFile(filePath: string): Promise<Buffer> {
  const response = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${filePath}`);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file ${filePath}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function fileExtension(filePath: string, mimeType: string | null, fallback: string): string {
  const fromPath = path.extname(filePath || '').toLowerCase();
  if (fromPath) return fromPath;
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'audio/ogg') return '.ogg';
  return fallback;
}

async function saveUpload(candidate: {
  chatId: string | number;
  fileId: string;
  kind: string;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
}): Promise<UploadRecord> {
  const filePath = await getTelegramFilePath(candidate.fileId);
  const content = await downloadFile(filePath);
  const ext = fileExtension(filePath, candidate.mimeType, candidate.kind === 'photo' ? '.jpg' : '.bin');
  const baseName = safeFileName(candidate.fileName || path.basename(filePath, path.extname(filePath)) || candidate.kind, candidate.kind);
  const dir = path.join(config.UPLOAD_DIR, String(candidate.chatId));
  ensureDir(dir);
  const localPath = path.join(dir, `${Date.now()}-${baseName}${ext}`);
  fs.writeFileSync(localPath, content);
  return {
    id: makeId('upload'),
    kind: candidate.kind,
    fileId: candidate.fileId,
    fileName: `${baseName}${ext}`,
    mimeType: candidate.mimeType,
    localPath,
    size: candidate.size,
    addedAt: nowIso(),
  };
}

async function extractMessageUploads(message: Record<string, unknown>): Promise<UploadRecord[]> {
  const candidates: Array<{
    chatId: string | number;
    fileId: string;
    kind: string;
    fileName: string | null;
    mimeType: string | null;
    size: number | null;
  }> = [];
  const chatId = String(message?.chat?.id || '');
  if (!chatId) return [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    candidates.push({
      chatId,
      fileId: String(photo.file_id),
      kind: 'photo',
      fileName: 'photo',
      mimeType: 'image/jpeg',
      size: Number(photo.file_size) || null,
    });
  }

  if (message.document?.file_id) {
    candidates.push({
      chatId,
      fileId: String(message.document.file_id),
      kind: 'document',
      fileName: typeof message.document.file_name === 'string' ? message.document.file_name : 'document',
      mimeType: typeof message.document.mime_type === 'string' ? message.document.mime_type : null,
      size: Number(message.document.file_size) || null,
    });
  }

  if (message.video?.file_id) {
    candidates.push({
      chatId,
      fileId: String(message.video.file_id),
      kind: 'video',
      fileName: 'video',
      mimeType: typeof message.video.mime_type === 'string' ? message.video.mime_type : 'video/mp4',
      size: Number(message.video.file_size) || null,
    });
  }

  if (message.audio?.file_id) {
    candidates.push({
      chatId,
      fileId: String(message.audio.file_id),
      kind: 'audio',
      fileName: typeof message.audio.file_name === 'string' ? message.audio.file_name : 'audio',
      mimeType: typeof message.audio.mime_type === 'string' ? message.audio.mime_type : null,
      size: Number(message.audio.file_size) || null,
    });
  }

  if (message.voice?.file_id) {
    candidates.push({
      chatId,
      fileId: String(message.voice.file_id),
      kind: 'voice',
      fileName: 'voice',
      mimeType: typeof message.voice.mime_type === 'string' ? message.voice.mime_type : 'audio/ogg',
      size: Number(message.voice.file_size) || null,
    });
  }

  const uploads: UploadRecord[] = [];
  for (const candidate of candidates) {
    uploads.push(await saveUpload(candidate));
  }
  return uploads;
}

function uploadsPromptBlock(uploads: UploadRecord[], rootDir: string): string {
  if (!uploads.length) return 'None.';
  return uploads
    .map((upload) => {
      const relativePath = upload.localPath.startsWith(rootDir)
        ? path.relative(rootDir, upload.localPath)
        : upload.localPath;
      return `- ${upload.kind}: ${upload.fileName} at ${relativePath}${upload.mimeType ? ` (${upload.mimeType})` : ''}`;
    })
    .join('\n');
}

module.exports = {
  extractMessageUploads,
  uploadsPromptBlock,
};
