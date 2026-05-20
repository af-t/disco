export function prefilter(msg, ctx) {
  const { selfId, selfMention, channelState, config, budgetExhausted } = ctx;

  const isMention = (msg.content && msg.content.includes(selfMention)) || msg.referenced_message?.author?.id === selfId;
  const isDM = !msg.guild_id;

  if (config.muted_channels?.includes(msg.channel_id)) {
    return 'drop';
  }

  if (isMention || isDM) {
    return 'pass-immediate';
  }

  if (Date.now() < (channelState.cooldownUntil ?? 0)) {
    return 'drop';
  }

  if (budgetExhausted) {
    return 'drop';
  }

  return 'gate';
}
