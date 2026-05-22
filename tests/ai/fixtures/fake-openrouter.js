// Minimal fake of the openrouter createAgent() default export.
export default async function createAgent() {
  const agent = {
    messages: [],
    usage: { cost: 0, tokens: 0 },
    isRunning: false,
    systemPrompt: '',
    tools: {
      _tools: new Map(),
      register(tool) {
        this._tools.set(tool.name, tool);
      },
    },
    async run(content) {
      agent.isRunning = true;
      agent.messages.push({ role: 'user', content });
      // Exercise one proxy tool round-trip, then finish.
      const send = agent.tools._tools.get('discord_send');
      if (send) await send.execute({ channel_id: 'c1', content: 'hi from agent' });
      agent.messages.push({ role: 'assistant', content: 'done' });
      agent.isRunning = false;
      return 'done';
    },
    async cleanup() {},
  };
  return agent;
}
