import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import * as send from '../../../src/ai/tools/discord-send.js';
import * as embed from '../../../src/ai/tools/discord-send-embed.js';
import * as sticker from '../../../src/ai/tools/discord-send-sticker.js';
import * as media from '../../../src/ai/tools/discord-send-media.js';
import * as expr from '../../../src/ai/tools/discord-list-expressions.js';

function sendCtx() {
  const calls = [];
  return {
    calls,
    ctx: {
      client: {
        sendMessage: async (channel_id, content, options) => {
          calls.push({ channel_id, content, options });
          return { id: 's1' };
        },
      },
      runtime: { onBotMessage: () => calls.push('notified') },
    },
  };
}

describe('expressive tools', () => {
  it('discord_send_embed builds an embed payload and notifies runtime', async () => {
    const { ctx, calls } = sendCtx();
    const out = JSON.parse(
      await embed.execute(ctx, {
        channel_id: 'c1',
        content: 'look',
        embed: {
          title: 'T',
          description: 'D',
          color: 123,
          fields: [{ name: 'n', value: 'v' }],
          image_url: 'http://i',
          footer_text: 'f',
        },
      }),
    );
    assert.deepEqual(out, { ok: true, message_id: 's1' });
    assert.equal(calls[0].options.embeds[0].title, 'T');
    assert.equal(calls[0].options.embeds[0].image.url, 'http://i');
    assert.equal(calls[0].options.embeds[0].footer.text, 'f');
    assert.equal(calls[1], 'notified');
  });

  it('discord_send_sticker sends sticker_ids', async () => {
    const { ctx, calls } = sendCtx();
    const out = JSON.parse(await sticker.execute(ctx, { channel_id: 'c1', sticker_ids: ['st1'] }));
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0].options.sticker_ids, ['st1']);
  });

  it('discord_send_media uploads the url as a file', async () => {
    const { ctx, calls } = sendCtx();
    const out = JSON.parse(await media.execute(ctx, { channel_id: 'c1', url: 'http://cdn/a.gif' }));
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0].options.files, ['http://cdn/a.gif']);
  });

  it('discord_send rejects channels outside the agent context', async () => {
    const { ctx, calls } = sendCtx();
    ctx.agentContext = { channelId: 'c1', guildId: 'g1' };
    const out = JSON.parse(await send.execute(ctx, { channel_id: 'c2', content: 'nope' }));
    assert.equal(out.ok, false);
    assert.match(out.error, /outside this conversation/);
    assert.equal(calls.length, 0);
  });

  it('discord_send_media rejects local files outside the agent workspace', async () => {
    const { ctx, calls } = sendCtx();
    ctx.agentContext = {
      channelId: 'c1',
      guildId: 'g1',
      workspaceDir: path.join(process.cwd(), '.agent-test-workspace'),
    };
    const out = JSON.parse(
      await media.execute(ctx, { channel_id: 'c1', url: path.join(process.cwd(), 'package.json') }),
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /workspace/);
    assert.equal(calls.length, 0);
  });

  it('discord_list_expressions returns emojis and stickers', async () => {
    const ctx = {
      client: {
        makeRequest: async (_m, path) =>
          path.endsWith('/emojis') ? [{ id: 'e1', name: 'kek', animated: true }] : [{ id: 'k1', name: 'wow' }],
      },
    };
    const out = JSON.parse(await expr.execute(ctx, { guild_id: 'g1' }));
    assert.equal(out.ok, true);
    assert.deepEqual(out.emojis[0], { id: 'e1', name: 'kek', animated: true });
    assert.deepEqual(out.stickers[0], { id: 'k1', name: 'wow' });
  });
});
