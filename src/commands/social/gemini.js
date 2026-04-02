import ChatBot from 'chatbot';
import path from 'node:path';
import fs from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';

const chatbot = new ChatBot(process.env.GEMINI_API_KEY);
const users = new Map();

const gen = (channel_id, user_id) => `${channel_id}:${user_id}`;

const exists = async(pth) => {
  try {
    await fs.access(pth);
    return true;
  } catch {
    return false;
  }
};

const startTyping = async (c, m, notify) => {
  while (notify?.()) {
    await c.sendTyping(m.channel_id).catch(_ => _);
    await setTimeout(5000);
  }
};

const execute = async (c, m, _, a) => {
  if (!a) return;

  const keyId = gen(m.channel_id, m.author.id);
  let channelId;

  if (!users.has(keyId)) {
    channelId = chatbot.create();
    users.set(keyId, channelId);
  } else {
    channelId = users.get(keyId);
  }

  const parts = [];

  if (m.attachments) {
    for (const att of m.attachments) {
      try {
        const fileData = await (await fetch(att.url)).arrayBuffer();
        const tempDir = process.env.TEMP || process.env.TMP || process.env.TMPDIR || (fs.existsSync('/tmp') ? '/tmp' : '.');
        const localFilePath = path.join(tempDir, `${Date.now()}-${att.filename}`);
        await fs.writeFile(localFilePath, Buffer.from(fileData));
        parts.push(localFilePath);
      } catch (err) {
        console.error('Error processing attachment:', err);
      }
    }
  }

  let typing = true;
  startTyping(c, m, () => typing);

  try {
    parts.push(a);
    const response = await chatbot.sendMessage(channelId, parts);

    if (response.length > 2000) {
      const tempDir = process.env.TEMP || process.env.TMP || process.env.TMPDIR || (fs.existsSync('/tmp') ? '/tmp' : '.');
      const tempFileName = 'message.txt';
      const tempFilePath = path.join(tempDir, tempFileName);

      await fs.mkdir(path.dirname(tempFilePath), { recursive: true });
      await fs.writeFile(tempFilePath, response);

      await c.reply(m, '', false, {files: [tempFilePath]});
      await fs.rm(tempFilePath);
    } else {
      await c.reply(m, response);
    }
  } catch (err) {
    console.error('Error sending message to Gemini:', err);
    await c.reply(m, 'Sorry, I encountered an error. Please try again later.');
  } finally {
    typing = false;
    parts.forEach(async (p) => {
      try {
        if (await exists(p)) await fs.rm(p);
      } catch (rmErr) {
        console.error(`Error removing file ${p}:`, rmErr);
      }
    });
  }
};

export default {
  execute,
  data: {
    name: 'gemini',
    aliases: ['ai'],
    usage: 'gemini {prompt}',
  }
};
