import fs from 'node:fs/promises';
import path from 'node:path';
import { snapshotFromMessage, renderEventBlock } from './event-format.js';
import { prefilter } from './prefilter.js';
import { createBudget } from './budget.js';
import { buildSystemPrompt, buildTurnInjector, buildCommandSystemPrompt } from './prompt.js';

function sanitizeFilename(name) {
  const base = path.basename(name ?? 'file');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return cleaned || 'file';
}

const DEFAULT_CONFIG = {
  debounceMs: 4000,
  forceDebounceMs: 500,
  channelCooldownMs: 20_000,
  dailyLimit: 500,
  bufferSize: 30,
  compactThreshold: 100,
  keepTail: 10,
  fetchHistoryMax: 50,
  maxTurns: 120,
};

function collectImageBlocks(snapshots) {
  const blocks = [];
  for (const snap of snapshots ?? []) {
    for (const att of snap.attachments_meta ?? []) {
      if (att?.content_type?.startsWith('image/') && att.url) {
        blocks.push({ type: 'image_url', image_url: { url: att.url } });
      }
    }
  }
  return blocks;
}

function collectImageBlocksFromRawAttachments(attachments) {
  const blocks = [];
  for (const att of attachments ?? []) {
    if (att?.content_type?.startsWith('image/') && att.url) {
      blocks.push({ type: 'image_url', image_url: { url: att.url } });
    }
  }
  return blocks;
}

function newChannelState() {
  return {
    rollingBuffer: [],
    pendingMsgs: [],
    debounceTimer: null,
    cooldownUntil: 0,
    lastBotMsgAt: 0,
    channelName: null,
  };
}

export class ChannelAIRuntime {
  constructor({ client, pool, config = {}, mutedChannelsResolver, fetcher, workspaceRoot }) {
    this.client = client;
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.channels = new Map();
    this.identity = { id: client._session?.user?.id, name: client._session?.user?.username };
    this.identity.mention = this.identity.id ? `<@${this.identity.id}>` : '<@unknown>';
    this.systemPrompt = buildSystemPrompt({ botUsername: this.identity.name ?? 'Bot' });
    this.budget = createBudget({ store: client.store, limit: this.config.dailyLimit });
    this.mutedChannelsResolver = mutedChannelsResolver ?? (async () => []);
    this.fetcher = fetcher ?? ((url) => fetch(url));
    this.workspaceRoot = workspaceRoot ?? path.join(process.cwd(), 'workspaces');
    this._agentGuild = new Map();
    this._installCleanupHook();
  }

  _installCleanupHook() {
    if (!this.client?.store) return;
    const prior = this.client.store.onDelete;
    this.client.store.onDelete = async (key, value) => {
      if (typeof prior === 'function') {
        try {
          await prior(key, value);
        } catch (err) {
          this.client.logger?.warn?.('prior onDelete hook failed', err);
        }
      }
      try {
        await this._handleStoreDelete(key);
      } catch (err) {
        this.client.logger?.warn?.('workspace cleanup failed', err);
      }
    };
  }

  async _handleStoreDelete(key) {
    if (typeof key !== 'string') return;
    if (key.startsWith('channel:buffer:')) {
      const channelId = key.slice('channel:buffer:'.length);
      if (!channelId) return;
      const dir = path.join(this.workspaceRoot, `channel-${channelId}`);
      await fs.rm(dir, { recursive: true, force: true });
      return;
    }
    if (key.startsWith('session:openrouter:')) {
      const rest = key.slice('session:openrouter:'.length);
      const idx = rest.indexOf(':');
      if (idx === -1) return;
      const guildPart = rest.slice(0, idx);
      const userId = rest.slice(idx + 1);
      if (!guildPart || !userId) return;
      const dir = path.join(this.workspaceRoot, `command-${guildPart}-${userId}`);
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async _saveNonImageAttachments(rawAttachments, msgId, workspaceDir) {
    const saved = [];
    const candidates = (rawAttachments ?? []).filter(
      (a) => a?.url && a.content_type && !a.content_type.startsWith('image/'),
    );
    if (candidates.length === 0) return saved;
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
    } catch (err) {
      this.client.logger?.warn?.('workspace mkdir failed', err);
      return saved;
    }
    for (const att of candidates) {
      const safe = sanitizeFilename(att.filename);
      const full = path.join(workspaceDir, `${msgId}-${safe}`);
      try {
        const res = await this.fetcher(att.url);
        if (!res?.ok) throw new Error(`fetch ${att.url} -> status ${res?.status ?? 'unknown'}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(full, buf);
        saved.push({ original: att.filename, saved_path: full, content_type: att.content_type });
      } catch (err) {
        this.client.logger?.warn?.('attachment save failed', err);
      }
    }
    return saved;
  }

  _state(channelId) {
    let s = this.channels.get(channelId);
    if (!s) {
      s = newChannelState();
      this.channels.set(channelId, s);
    }
    return s;
  }

  onBotMessage(sentMessage) {
    if (!sentMessage?.channel_id) return;
    const s = this._state(sentMessage.channel_id);
    const snap = snapshotFromMessage(
      {
        ...sentMessage,
        author: { id: this.identity.id, username: this.identity.name, global_name: this.identity.name },
      },
      { flag: 'bot' },
    );
    s.rollingBuffer.push(snap);
    while (s.rollingBuffer.length > this.config.bufferSize) s.rollingBuffer.shift();
    s.lastBotMsgAt = Date.now();
    s.cooldownUntil = Date.now() + this.config.channelCooldownMs;
  }

  async onMessage(msg) {
    if (msg.author?.bot || msg.author?.id === this.identity.id) return;

    const s = this._state(msg.channel_id);
    const snap = snapshotFromMessage(msg, { flag: 'new' });

    const workspaceDir = path.join(this.workspaceRoot, `channel-${msg.channel_id}`);
    const saved = await this._saveNonImageAttachments(msg.attachments, msg.id, workspaceDir);
    for (const entry of saved) {
      const meta = snap.attachments_meta.find((m) => m.filename === entry.original);
      if (meta) meta.saved_path = entry.saved_path;
    }

    s.rollingBuffer.push(snap);
    while (s.rollingBuffer.length > this.config.bufferSize) s.rollingBuffer.shift();
    s.pendingMsgs.push(snap);

    try {
      await this.client.store.set(`channel:buffer:${msg.channel_id}`, s.rollingBuffer, {
        isCache: true,
        ttl: 60 * 60 * 1000,
      });
    } catch {}

    const channelKey = `channel:${msg.channel_id}`;
    const muted = msg.guild_id ? await this.mutedChannelsResolver(msg.guild_id) : [];

    // Steering path: the channel's child is already running. Inject the new
    // message into the live loop immediately, skipping the debounce. Only
    // hard-drops (muted channel, exhausted budget) suppress steering.
    if (this.pool.isRunning(channelKey)) {
      if (muted.includes(msg.channel_id)) return;
      if (msg.guild_id && (await this.budget.exhausted(msg.guild_id))) return;
      const channelName = s.channelName ?? msg.channel_id;
      const block = renderEventBlock(snap, { channel_name: channelName, channel_id: msg.channel_id });
      for (const observed of s.rollingBuffer) observed.flag = 'observed';
      s.pendingMsgs = [];
      this._dispatch(channelKey, msg.channel_id, msg.guild_id ?? null, block).catch((err) =>
        this.client.logger?.error?.('AI steer dispatch error', err),
      );
      return;
    }

    // Idle path: heuristic prefilter, then debounce a flush.
    const decision = prefilter(msg, {
      selfId: this.identity.id,
      selfMention: this.identity.mention,
      channelState: s,
      config: { muted_channels: muted },
      budgetExhausted: msg.guild_id ? await this.budget.exhausted(msg.guild_id) : false,
    });

    if (decision === 'drop') return;
    const delay = decision === 'pass-immediate' ? this.config.forceDebounceMs : this.config.debounceMs;
    this._scheduleFlush(msg.channel_id, delay);
  }

  _scheduleFlush(channelId, delay) {
    const s = this._state(channelId);
    if (s.debounceTimer) clearTimeout(s.debounceTimer);
    s.debounceTimer = setTimeout(
      () => this._flush(channelId).catch((err) => this.client.logger?.error?.('AI flush error', err)),
      delay,
    );
  }

  async _flush(channelId) {
    const s = this._state(channelId);
    const sample = s.pendingMsgs[0];
    if (!sample) return;

    const guildId = sample.guild_id ?? (await this._guildOf(channelId));
    if (guildId && (await this.budget.exhausted(guildId))) {
      s.pendingMsgs = [];
      return;
    }

    const promptBlock = await this._composeUserPrompt(channelId, s);
    const imageBlocks = collectImageBlocks(s.pendingMsgs);
    const content = imageBlocks.length ? [{ type: 'text', text: promptBlock }, ...imageBlocks] : promptBlock;

    for (const snap of s.rollingBuffer) snap.flag = 'observed';
    s.pendingMsgs = [];

    try {
      await this._dispatch(`channel:${channelId}`, channelId, guildId, content);
    } catch (err) {
      this.client.logger?.error?.('AI flush failure', err);
    }
  }

  async _dispatch(channelKey, channelId, guildId, content) {
    if (guildId) this._agentGuild.set(channelKey, guildId);
    const spawnContext = {
      mode: 'natural',
      systemPrompt: this.systemPrompt,
      maxTurns: this.config.maxTurns,
      compactThreshold: this.config.compactThreshold,
      keepTail: this.config.keepTail,
      workspaceDir: path.join(this.workspaceRoot, `channel-${channelId}`),
      history: null,
    };
    await this.pool.run(channelKey, content, spawnContext);
  }

  async _guildOf(channelId) {
    try {
      const ch = await this.client.getChannel(channelId);
      return ch?.guild_id ?? null;
    } catch {
      return null;
    }
  }

  async invoke({ mode, msg, explicitPrompt }) {
    if (mode !== 'command') throw new Error(`Unknown invoke mode: ${mode}`);

    const guildPart = msg.guild_id ?? 'dm';
    const userId = msg.author?.id ?? 'unknown';
    const agentKey = `command:${guildPart}:${userId}`;
    const sessionKey = `session:openrouter:${guildPart}:${userId}`;

    let history = null;
    try {
      const persisted = await this.client.store.get(sessionKey);
      if (Array.isArray(persisted)) history = persisted;
    } catch {}

    const userTag = msg.author?.global_name || msg.author?.username || 'user';
    const cmdWorkspaceDir = path.join(this.workspaceRoot, `command-${guildPart}-${userId}`);
    const savedFiles = await this._saveNonImageAttachments(msg.attachments, msg.id, cmdWorkspaceDir);
    const workspaceHint = savedFiles.length
      ? [
          '[Workspace files (use the Read tool with the absolute path):',
          ...savedFiles.map((f) => `  - ${f.original} (${f.content_type}) -> ${f.saved_path}`),
          ']',
        ].join('\n')
      : null;
    const block = [
      `[Direct invocation from ${userTag} (user_id=${userId})]`,
      `[Context: channel_id=${msg.channel_id}, message_id=${msg.id}, guild_id=${msg.guild_id ?? 'DM'}, current_time=${new Date().toISOString()}]`,
      `[Reply via discord_reply with channel_id="${msg.channel_id}" and message_id="${msg.id}". Do not skip — the user explicitly asked.]`,
      workspaceHint,
      '',
      explicitPrompt ?? msg.content ?? '',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const imageBlocks = collectImageBlocksFromRawAttachments(msg.attachments);
    const content = imageBlocks.length ? [{ type: 'text', text: block }, ...imageBlocks] : block;

    this._agentGuild.set(agentKey, msg.guild_id ?? null);
    const spawnContext = {
      mode: 'command',
      systemPrompt: buildCommandSystemPrompt({ botUsername: this.identity.name ?? 'Bot', userTag }),
      maxTurns: this.config.maxTurns,
      compactThreshold: this.config.compactThreshold,
      keepTail: this.config.keepTail,
      workspaceDir: cmdWorkspaceDir,
      history,
    };

    try {
      const done = await this.pool.run(agentKey, content, spawnContext);
      if (done?.outcome === 'truncated') {
        await this.client
          .reply(msg, '⚠️ Run hit the turn limit — send another message to continue where it left off.')
          .catch(() => {});
      }
    } catch (err) {
      this.client.logger?.error?.('AI command invoke failure', err);
      await this.client.reply(msg, 'Sorry, something went wrong.').catch(() => {});
    }
  }

  // Called by ChildHandle when a child signals a budget charge.
  async onAgentCharge(agentKey, _kind) {
    const guildId = this._agentGuild.get(agentKey);
    if (guildId) await this.budget.increment(guildId);
  }

  // Called by ChildHandle when a command-mode child returns its messages.
  async onAgentMessages(agentKey, messages) {
    if (!agentKey.startsWith('command:')) return;
    const rest = agentKey.slice('command:'.length);
    try {
      await this.client.store.set(`session:openrouter:${rest}`, messages, {
        isCache: true,
        ttl: 2 * 60 * 60 * 1000,
      });
    } catch {}
  }

  async _composeUserPrompt(channelId, state) {
    let channelName = state.channelName;
    let guildId = null;
    try {
      const ch = await this.client.getChannel(channelId);
      channelName = ch?.name ?? channelId;
      guildId = ch?.guild_id ?? null;
      state.channelName = channelName;
    } catch {}
    const newCount = state.pendingMsgs.length;
    const ctxCount = Math.max(0, state.rollingBuffer.length - newCount);
    const header = buildTurnInjector({ channelId, channelName, guildId, newCount, contextCount: ctxCount });
    const blocks = state.rollingBuffer.map((snap) =>
      renderEventBlock(snap, { channel_name: channelName, channel_id: channelId }),
    );
    return `${header}\n\n${blocks.join('\n\n')}`;
  }
}
