import createAgent from 'openrouter';

const execute = async (client, message, args, _rawArgs) => {
  const agent = await createAgent();
  let limit = 50;
  if (args && args[0] && !isNaN(args[0])) {
    limit = parseInt(args[0]);
    if (limit > 100) limit = 100;
    if (limit < 10) limit = 10;
  }

  // slash interactions auto-defer past Discord's 3s deadline
  let typing = true;
  const sendTyping = async () => {
    while (typing) {
      await client
        .sendTyping(message.channel_id)
        .catch((err) => client.logger?.warn?.('Typing indicator failed:', err));
      await new Promise((r) => setTimeout(r, 5000).unref());
    }
  };

  if (!message.isInteraction) {
    sendTyping();
  }

  try {
    const messages = await client.getMessages(message.channel_id, { limit });

    if (!messages || messages.length === 0) {
      typing = false;
      return await client.reply(message, 'There are no messages to summarize.');
    }

    // Messages are fetched newest first, we need chronological order for AI
    const reversed = [...messages].reverse();

    const totalImagesInChat = reversed.reduce((acc, m) => {
      const imgs = m.attachments?.filter((a) => a.content_type?.startsWith('image/'))?.length || 0;
      return acc + imgs;
    }, 0);

    const getPrompt = (maxImages) => {
      const prompt = [
        {
          type: 'text',
          text: 'Please provide a clear and concise summary of the following conversation. Highlight the key points discussed and refer to any shared images or files if they are important.',
        },
      ];

      let imageCount = 0;
      let accumulatedImageSize = 0;
      const MAX_ACCUMULATED_SIZE = 15 * 1024 * 1024; // 15MB

      for (const m of reversed) {
        let text = `[${m.author.username}]:${m.content ? ` ${m.content}` : ''}`;

        if (m.embeds && m.embeds.length > 0) {
          const embedTexts = [];
          for (const embed of m.embeds) {
            const embedParts = [];
            if (embed.title) embedParts.push(`Title: ${embed.title}`);
            if (embed.description) embedParts.push(`Description: ${embed.description}`);
            if (embed.fields && embed.fields.length > 0) {
              const fieldsText = embed.fields.map((f) => `- ${f.name}: ${f.value}`).join('\n');
              embedParts.push(`Fields:\n${fieldsText}`);
            }
            if (embed.footer?.text) embedParts.push(`Footer: ${embed.footer.text}`);
            if (embedParts.length > 0) {
              embedTexts.push(`[Embed]\n${embedParts.join('\n')}`);
            }
          }
          if (embedTexts.length > 0) {
            text += (text.endsWith(']:') ? ' ' : '\n') + embedTexts.join('\n');
          }
        }

        if (m.attachments && m.attachments.length > 0) {
          const metadata = m.attachments
            .map((a) => `${a.filename} (${a.content_type || 'unknown'}, ${(a.size / 1024).toFixed(1)} KB)`)
            .join(', ');
          text += `\n[Attachments: ${metadata}]`;
        }
        prompt.push({ type: 'text', text });

        if (m.attachments && m.attachments.length > 0) {
          for (const a of m.attachments) {
            if (a.content_type?.startsWith('image/') && a.url) {
              const size = a.size || 0;
              if (imageCount < maxImages && accumulatedImageSize + size <= MAX_ACCUMULATED_SIZE) {
                prompt.push({ type: 'image_url', image_url: { url: a.url } });
                imageCount++;
                accumulatedImageSize += size;
              } else if (maxImages > 0) {
                client.logger?.warn?.(
                  `Skipping image_url for ${a.filename} to avoid payload limit (current size: ${accumulatedImageSize} bytes, count: ${imageCount})`,
                );
              }
            }
          }
        }
      }
      return { prompt, imageCount };
    };

    let response = null;
    let finalImageCount = 0;
    const stages = [4, 1, 0]; // Try 4 images, then 1 image, then text-only
    let lastError = null;

    for (const imgCount of stages) {
      try {
        client.logger?.info?.(`Attempting summary with up to ${imgCount} images...`);
        const { prompt, imageCount } = getPrompt(imgCount);

        agent.messages = [];
        response = await agent.run(prompt);

        finalImageCount = imageCount;
        client.logger?.info?.(`Summary successfully generated using ${imageCount} images.`);
        break;
      } catch (err) {
        lastError = err;
        client.logger?.warn?.(
          `Summary attempt with ${imgCount} images failed: ${err.message || err}. Falling back to next stage...`,
        );
      }
    }

    if (!response) {
      throw lastError || new Error('All summary fallback stages failed.');
    }

    let responseText = typeof response === 'string' ? response : '';

    const modeInfo =
      finalImageCount > 0
        ? ` (with ${finalImageCount} image(s))`
        : totalImagesInChat > 0
          ? ' (text-only fallback)'
          : '';
    const header = `**Summary of the last ${messages.length} messages${modeInfo}:**\n\n`;

    // Discord message content has a strict 2000 character limit
    const maxTextLen = 2000 - header.length - 10; // 10 characters safety margin
    if (responseText.length > maxTextLen) {
      responseText = responseText.substring(0, maxTextLen - 3) + '...';
    }

    await client.reply(message, `${header}${responseText}`);
  } catch (err) {
    client.logger?.error?.('Error summarizing messages:', err);
    await client
      .reply(message, 'Sorry, an error occurred while trying to summarize the messages.')
      .catch((err) => client.logger?.warn?.('Failed to send summarize error reply:', err));
  } finally {
    typing = false;
  }
};

export default {
  execute,
  data: {
    name: 'summarize',
    description: 'Summarizes the recent messages in this channel.',
    aliases: ['summary', 'recap'],
    usage: 'summarize [count]',
    permissions: ['READ_MESSAGE_HISTORY'],
    slash: true,
    options: [
      {
        name: 'count',
        description: 'Number of messages to summarize (10-100)',
        type: 4, // INTEGER
        required: false,
        min_value: 10,
        max_value: 100,
      },
    ],
  },
};
