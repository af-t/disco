import ChatBot from 'chatbot';
import path from 'node:path';
import fs from 'node:fs';

const chatbot = new ChatBot(process.env.GEMINI_API_KEY);
const users = new Map();

//Helper function to create Id
const gen = (channel_id, user_id) => `${channel_id}:${user_id}`;

//Helper function to check channel lock status
const islocked = (id) => {
  const list = chatbot.listChannels();
  return list.some(i => i === id);
};

//Helper function to send typing indicator to discord
const startTyping = async(c, m, notify) => {
  while (notify?.()) {
    await c.sendTyping(m.channel_id).catch(_ => _);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
};

const execute = async (c, m, _, a) => {
  if (!a) return;
  const keyId = gen(m.channel_id, m.author.id);
  const parts = [];
  if (!users.has(keyId)) {
    const channelId = chatbot.newChannel();
    users.set(keyId, channelId);
  }

  const channelId = users.get(keyId);
  let unlockKey;
  if (chatbot.channel !== channelId) do {
    unlockKey = chatbot.moveChannel(channelId, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (!unlockKey && islocked(channelId));

  if (m.attachments) for (const att of m.attachments) try {
    const fileData = await (await fetch(att.url)).arrayBuffer();
    const tempDir = process.env.TEMP || process.env.TMP || process.env.TMPDIR || (fs.existsSync('/tmp') ? '/tmp' : '.');
    const localFilePath = path.join(tempDir, att.filename);
    await fs.promises.writeFile(localFilePath, Buffer.from(fileData));
    parts.push(localFilePath);
  } catch (err) {
    console.warn(err);
  }

  let typing = true;
  startTyping(c, m, () => typing);

  try {
    parts.push(a);
    const response = await chatbot.sendMessage(parts);
    if (response.length > 2000) {
      const temp = path.join(process.env.TEMP || process.env.TMP || process.env.TMPDIR || (fs.existsSync('/tmp') ? '/tmp' : '.'), Math.random().toString(36).slice(2), 'message.txt');
      await fs.promises.mkdir(path.dirname(temp), { recursive: true });
      await fs.promises.writeFile(temp, response);
      await c.reply(m, '', false, { files: [temp] });
      fs.promises.rm(path.dirname(temp), { recursive: true });
    } else {
      await c.reply(m, response);
    }
  } catch (err) {
    console.warn(err);
  } finally {
    typing = false;
    unlockKey?.();
    parts.forEach(p => fs.existsSync(p) && fs.rmSync(p));
  }
};

export default {
  execute,
  data: {
    name: 'gemini',
    aliases: ['ai'],
    usage: 'gemini {prompt}'
  }
};
