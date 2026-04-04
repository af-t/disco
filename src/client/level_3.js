import level2 from './level_2.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

class DiscordClient extends level2 {
  constructor(...args) {
    super(...args);
  }

  async sendMessage(channel_id, content, options = {}) {
    const files = options.attachments || options.files;
    if (files) {
      options.attachments = await this.uploadToDiscord(channel_id, files);
      delete options.files;
    }
    return this.makeRequest('POST', `/channels/${channel_id}/messages`, { content, ...options });
  }

  async uploadToDiscord(channel_id, files = []) {
    if (!files.length) throw new Error('files must contain at least 1 item');
    files = (await Promise.allSettled(files.map(x => this._fileInfo(x)))).filter(x => x.status === 'fulfilled').map(x => x.value);
    const cached = [];
    const upload = [];

    for (let i = 0; i < files.length; i++) {
      if (this.store.has(`sum:${files[i].checksum}`)) {
        cached.push({ ...(await this.store.get(`sum:${files[i].checksum}`)), id: i });
        continue;
      }
      upload.push({ ...files[i], id: i });
    }

    const { attachments } = await this.makeRequest(
      'POST',
      `/channels/${channel_id}/attachments`,
      {
        files: upload.map(x => ({ filename: x.filename, file_size: x.file_size }))
      }
    );

    await Promise.all(attachments.map(async(x, i) => {
      const stream = fs.createReadStream(upload[i].filepath);
      await fetch(x.upload_url, {
        method: 'PUT',
        headers: {
          'Content-Length': upload[i].file_size,
          'Content-Type': 'application/octet-stream'
        },
        body: stream
      });
    }));

    attachments.forEach((x, i) => {
      const data = {
        id: upload[i].id,
        uploaded_filename: x.upload_filename,
        filename: upload[i].filename
      };
      this.store.set(`sum:${upload[i].checksum}`, data);
      cached.push(data);
    });

    return cached;
  }

  async _fileInfo(file) {
    if (typeof file !== 'string') return file;
    if (file.startsWith('file://')) file = fileURLToPath(file);
    const result = {
      filename: null,
      file_size: 0,
      checksum: null,
      filepath: null
    };

    if (file.startsWith('http://') || file.startsWith('https://')) {
      if (this._temps.has(file)) {
        Object.assign(result, this._temps.get(file));
      } else {
        const { pathname } = new URL(file);
        const req = await fetch(file);
        result.filename = path.basename(pathname);
        result.filepath = path.join(os.tmpdir(), String(process.pid), result.filename);

        fs.mkdirSync(path.dirname(result.filepath), { recursive: true });
        const stream = fs.createWriteStream(result.filepath);
        await pipeline(req.body, stream);

        result.file_size = fs.statSync(result.filepath).size;
        this._temps.set(file, result);
      }
    } else if (fs.existsSync(file)) {
      result.filename  = path.basename(file);
      result.filepath  = file;
      result.file_size = fs.statSync(file).size;
    } else {
      throw new Error(`file '${file}' cannot be handled`);
    }

    result.checksum = await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(result.filepath);
      const csum = createHash('sha3-256'); // use latest algoritm
      csum.on('error', reject);
      stream.on('data', chunk => csum.update(chunk));
      stream.on('end', () => resolve(Array.from(csum.digest(), x => x.toString(36)).join('')));
    });

    return result;
  }

  async reply(message, content, mention = false, options = {}) {
    if (message.isInteraction && typeof message.reply === 'function') {
      const files = options.attachments || options.files;
      if (files) {
        options.attachments = await this.uploadToDiscord(message.channel_id, files);
        delete options.files;
      }
      await message.reply(content, options);
      return {
        isInteractionResponse: true,
        interactionToken: message.interactionToken,
        channel_id: message.channel_id
      };
    }

    const { channel_id, id } = message;
    return this.sendMessage(
      channel_id,
      content,
      {
        message_reference: { channel_id, message_id: id },
        ...(mention ? {} : { allowed_mentions: {} }),
        ...options
      }
    );
  }

  async destroy() {
    await fs.promises.rm(path.join(os.tmpdir(), String(process.pid)), { recursive: true, force: true });
    return super.destroy();
  }
}

export default DiscordClient;
