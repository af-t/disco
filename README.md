# 🎶 Disco Bot

A modular and extendable Discord bot built with Node.js, designed for server management, moderation, and fun interactions. Customize and enhance it with ease to fit your community's vibe.

## ✨ Features

- **🛠️ Server Management**: Automate tasks and keep your server organized.
- **🛡️ Moderation Tools**: Keep your community safe with robust moderation commands.
- **🎉 Fun Commands**: Engage your members with interactive and entertaining features.
- **🔌 Modular Architecture**: Easily add or remove features to tailor the bot to your needs.
- **🤖 Natural AI Channel Participant**: Optional channel-aware AI (gated behind `AI_NATURAL_MODE=1`) that observes messages, debounces bursts, and decides when to engage. Acts via Discord API tools (send, reply, react, inspect).

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/)
- A [Discord Application](https://discord.com/developers/applications) with a bot token

### Installation

1. **Clone the repository**:

   ```bash
   git clone https://github.com/af-t/disco.git
   cd disco
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Configure the bot**:

   Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   ```

   **Environment variables**

   | Variable              | Required | Default                          | Description |
   |-----------------------|----------|----------------------------------|-------------|
   | `DISCORD_TOKEN`       | Yes      | —                                | Your Discord bot token |
   | `STORE_SERVER_URL`    | Yes      | `http://localhost:3000`          | URL of the internal store server |
   | `STORE_SERVER_PORT`   | No       | `3000`                           | Port for the store server |
   | `OPENROUTER_API_KEY`  | No       | —                                | OpenRouter API key (for AI commands) |
   | `OPENROUTER_MODEL`    | No       | `google/gemini-2.0-flash-001`    | AI model to use for the agent |
   | `AI_NATURAL_MODE`     | No       | `0`                              | `1` enables the channel-participant AI runtime; `0` disables `.ai`/`.openrouter`/`.chat` entirely |
   | `AI_DEBOUNCE_MS`      | No       | `4000`                           | Debounce window for normal messages before flushing to the AI |
   | `AI_FORCE_DEBOUNCE_MS`| No       | `500`                            | Debounce when the bot is directly addressed (mention / reply / DM) |
   | `AI_CHANNEL_COOLDOWN_MS` | No    | `20000`                          | Post-response cooldown per channel before the bot may speak again |
   | `AI_DAILY_LIMIT`      | No       | `500`                            | Per-guild LLM call cap per UTC day; mentions still bypass |
   | `AI_BUFFER_SIZE`      | No       | `30`                             | Rolling buffer size per channel (messages retained as context) |
   | `AI_COMPACT_THRESHOLD`| No       | `100`                            | Auto-compact `agent.messages` once length exceeds this |
   | `AI_FETCH_HISTORY_MAX`| No       | `50`                             | Hard cap for the `discord_fetch_history` tool |
   | `SPOTIFY_CLIENT_ID`   | No       | —                                | Spotify API client ID (for music downloads) |
   | `SPOTIFY_CLIENT_SECRET` | No     | —                                | Spotify API client secret |
   | `DISCORD_GATEWAY_URL` | No       | `wss://gateway.discord.gg`       | Discord WebSocket gateway URL (advanced) |
   | `DISCORD_API_BASE`    | No       | `https://discord.com/api/v10`    | Discord REST API base URL (advanced) |
   | `DISCORD_INTENTS`     | No       | 13 essential intents combined    | Comma-separated intent names (e.g., `GUILDS,GUILD_MEMBERS,GUILD_MESSAGES`). See [lib/intents.js](src/lib/intents.js) for all options |
   | `DISCORD_RECONNECT_DELAY` | No    | `5000`                           | Milliseconds between reconnect attempts |
   | `DISCORD_RECONNECT_LIMIT` | No    | `5`                              | Max reconnect attempts before giving up |
   | `DISCORD_MAX_RETRIES` | No       | `3`                              | Max API request retries |

4. **Start the bot**:

   ```bash
   npm start
   ```

## 🤖 Natural AI Mode

When `AI_NATURAL_MODE=1`, the bot acts as a normal channel member: it observes every message, applies a heuristic prefilter (direct address — mention / reply / DM — bypasses cooldown and budget), and lets the LLM decide whether to respond or stay silent. Actions are taken through 10 Discord tools (`discord_send`, `discord_reply`, `discord_react`, and seven inspect tools).

- `.ai-mute on | off | status` — admins with `MANAGE_CHANNELS` can silence the bot in a specific channel.
- `.ai` / `.openrouter` / `.chat` — direct invocation; the bot is forced to respond and keeps per-user history (`session:openrouter:{guild}:{user}`, 2h TTL).
- Image attachments are sent inline as multimodal blocks; non-image attachments are saved under `workspaces/channel-{id}/` or `workspaces/command-{guild}-{user}/` and exposed to the LLM via the built-in `Read` tool. Workspace directories are cleaned up automatically when the matching store key expires.

When `AI_NATURAL_MODE=0` (default), the `.ai` / `.openrouter` / `.chat` commands return a disabled message — there is no parallel legacy path.

## 🛠️ Customization

The bot's modular structure allows you to easily add, remove, or modify commands and features. Explore the `src` directory to see how commands are implemented and create your own to extend the bot's functionality.

## 🤝 Contributing

Contributions are welcome! Feel free to fork the repository, make changes, and submit a pull request. Please ensure your code follows the project's coding standards and includes appropriate tests.

## 📄 License

This project is licensed under the [MIT License](LICENSE).
