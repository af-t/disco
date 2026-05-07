import createAgent from 'openrouter';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const genSessionKey = (guild_id, user_id) => `session:openrouter:${guild_id}:${user_id}`;
const agent = await createAgent();
const workspaces = new Map();
let currentTask = Promise.resolve();

const exists = async(path) => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const sendTyping = async(client, message, notify) => {
  while (notify?.()) {
    await client.sendTyping(message.channel_id).catch(_ => _);
    await setTimeout(5000);
  }
};

const processAttachments = async(msg, sessionPath) => {
  const attachments = [];
  if (!msg.attachments) return attachments;

  for (const att of msg.attachments) {
    if (att.content_type.startsWith('image')) {
      attachments.push({
        type: 'image_url',
        image_url: {
          url: att.url
        }
      });
      attachments.push({ type: 'text', text: `<filename>${att.filename}</filename>` });
      continue;
    }

    if (att.content_type.includes('pdf')) {
      attachments.push({
        type: 'file',
        file: {
          filename: att.filename,
          file_data: att.url
        }
      });
      attachments.push({ type: 'text', text: `<filename>${att.filename}</filename>` });
      continue;
    }

    if (att.content_type.startsWith('text')) {
      const fileData = await (await fetch(att.url)).arrayBuffer();
      const filePath = path.join(sessionPath, att.filename);
      await fs.writeFile(filePath, Buffer.from(fileData));
      attachments.push({ type: 'text', text: `<filename>${att.filename}</filename>` });
      continue;
    }
  }
  return attachments;
};

const execute = async(client, message, _, args) => {
  if (!args) return;
  if (!client.agent) client.agent = agent; // for debugging

  const sessionKey = genSessionKey(message.guild_id, message.author.id);
  let session = await client.store.get(sessionKey);

  if (!session) {
    const id = crypto.randomBytes(3).toString('hex');
    session = {
      messages: [],
      path: path.join(process.cwd(), 'workspaces', id)
    };
  }

  if (!(await exists(session.path))) {
    await fs.mkdir(session.path, { recursive: true });
  }

  if (!client.store.onDelete) {
    client.store.onDelete = async(k, m) => {
      const path = workspaces.get(k);
      workspaces.delete(k);
      await fs.rm(path, { recursive: true, force: true });
    };
  }

  const attachments = await processAttachments(message, session.path);

  if (message.message_reference) {
    try {
      const refMessage = await client.getMessage(message.message_reference.channel_id, message.message_reference.message_id);
      if (refMessage) {
        const refAttachments = await processAttachments(refMessage, session.path);
        attachments.push(...refAttachments);
      }
    } catch (err) {
      console.error('Error fetching referenced message:', err);
    }
  }

  const myTurn = currentTask.then(async() => {
    let typing = true;
    sendTyping(client, message, () => typing);

    const originalCwd = process.cwd();

    try {
      // Set workspace as CWD for the agent
      process.chdir(session.path);

      const prompt = [...attachments, { type: 'text', text: args }];
      agent.messages = [...session.messages];

      const response = await agent.run(prompt);
      let responseText = typeof response === 'string' ? response : '';

      if (responseText.length > 2000) {
        const tempFilePath = path.join(session.path, 'message.txt');
        await fs.writeFile(tempFilePath, responseText);
        await client.reply(message, '', false, { files: [tempFilePath] });
        await fs.rm(tempFilePath);
      } else {
        await client.reply(message, responseText);
      }

      session.messages = agent.messages;
    } catch (err) {
      console.error('Error in OpenRouter agent:', err);
      await client.reply(message, 'Sorry, I encountered an error. Please try again later.').catch(_ => _);
    } finally {
      typing = false;
      await client.store.set(sessionKey, session, { ttl: 7_200_000 });
      process.chdir(originalCwd);
      workspaces.set(sessionKey, session.path);
    }
  });
};

export default {
  execute,
  data: {
    name: 'openrouter',
    description: 'Chat with OpenRouter AI Agent (multimodal & workspace support)',
    aliases: ['ai', 'chat'],
    usage: 'openrouter {prompt}',
    slash: false
  }
};
