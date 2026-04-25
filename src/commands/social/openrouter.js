import createAgent from 'openrouter';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';

const genSessionKey = (guild_id, user_id) => `session:openrouter:${guild_id}:${user_id}`;
let currentTask = Promise.resolve();

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

  const sessionKey = genSessionKey(m.guild_id, m.author.id);
  let session = await c.store.get(sessionKey);

  if (!session) {
    const id = crypto.randomBytes(3).toString('hex');
    session = {
      id,
      path: path.join(process.cwd(), 'workspaces', id),
      guildId: m.guild_id,
      userId: m.author.id
    };
  }

  // Ensure workspace directory exists
  if (!(await exists(session.path))) {
    await fs.mkdir(session.path, { recursive: true });
  }

  // Update session in store with 2h TTL (sliding window)
  await c.store.set(sessionKey, session, { ttl: 7200000 });

  const attachments = [];
  if (m.attachments) {
    for (const att of m.attachments) {
      try {
        const fileData = await (await fetch(att.url)).arrayBuffer();
        const localFilePath = path.join(session.path, att.filename);
        await fs.writeFile(localFilePath, Buffer.from(fileData));
        attachments.push({
          type: 'image_url',
          image_url: { url: `data:${att.content_type};base64,${Buffer.from(fileData).toString('base64')}` }
        });
      } catch (err) {
        console.error('Error processing attachment:', err);
      }
    }
  }

  // Queue starts here to prevent race conditions on process.chdir()
  const myTurn = currentTask.then(async () => {
    let typing = true;
    startTyping(c, m, () => typing);

    let thinkingMsg = await c.reply(m, '*Thinking...*');
    let lastThinking = '';
    let lastEditTime = Date.now();

    const updateThinking = async (blocks) => {
      const thinking = blocks
        .filter(b => b.type === 'thinking')
        .map(b => b.text)
        .join('\n');

      if (thinking && thinking !== lastThinking) {
        lastThinking = thinking;
        const now = Date.now();
        // Throttled update to avoid Discord rate limits (2.5s)
        if (now - lastEditTime > 2500) {
          lastEditTime = now;
          const display = `*Thinking...*\n\`\`\`\n${thinking.length > 1800 ? '...' + thinking.slice(-1800) : thinking}\n\`\`\``;
          await c.editMessage(thinkingMsg, display).catch(() => {});
        }
      }
    };

    const originalCwd = process.cwd();
    try {
      // Set workspace as CWD for the agent
      process.chdir(session.path);

      const agent = await createAgent();
      const prompt = attachments.length > 0
        ? [{ type: 'text', text: a }, ...attachments]
        : a;

      const responseContent = await agent.run(prompt, updateThinking);

      let response = '';
      if (Array.isArray(responseContent)) {
        response = responseContent
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
      } else {
        response = String(responseContent);
      }

      if (response.length > 2000) {
        const tempFileName = 'message.txt';
        const tempFilePath = path.join(session.path, tempFileName);
        await fs.writeFile(tempFilePath, response);

        // Reply with file and delete the thinking message
        await c.reply(m, '', false, {files: [tempFilePath]});
        await c.deleteMessage(thinkingMsg.channel_id, thinkingMsg.id).catch(() => {});
        await fs.rm(tempFilePath);
      } else if (response.length > 0) {
        await c.editMessage(thinkingMsg, response);
      } else {
        await c.editMessage(thinkingMsg, '*Agent finished without text response.*');
      }
    } catch (err) {
      console.error('Error in OpenRouter agent:', err);
      await c.editMessage(thinkingMsg, 'Sorry, I encountered an error. Please try again later.');
    } finally {
      typing = false;
      process.chdir(originalCwd);
    }
  }).catch(err => {
    console.error('Queue error:', err);
  });

  currentTask = myTurn;
  await myTurn;
};

export default {
  execute,
  data: {
    name: 'openrouter',
    description: 'Chat with OpenRouter AI Agent (multimodal & workspace support)',
    aliases: ['ai', 'gemini'],
    usage: 'openrouter {prompt}',
    slash: false
  }
};
