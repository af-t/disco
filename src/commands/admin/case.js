import { getRecentCases, getCasesByUser } from '../../lib/case.js';
import { extractUserID } from '../../lib/adminUtils.js';

const execute = async (client, message, args) => {
  const guildId = message.guild_id;
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'view') {
    const caseId = parseInt(args[1], 10);
    if (!caseId || caseId < 1) {
      await client.reply(message, 'Provide a valid case number: `.case view <number>`');
      return;
    }

    const caseData = await client.store.get(`modcase:${guildId}:${caseId}`);
    if (!caseData) {
      await client.reply(message, `Case #${caseId} not found.`);
      return;
    }

    const status = caseData.resolved ? '✅ Resolved' : '⏳ Active';
    const duration = caseData.duration ? `\n**Duration:** ${Math.floor(caseData.duration / 1000)}s` : '';

    const embed = {
      title: `Case #${caseData.id} — ${caseData.type.toUpperCase()}`,
      color: caseData.resolved ? 0x00ff00 : 0xff0000,
      fields: [
        { name: 'Status', value: status, inline: true },
        { name: 'Moderator', value: `<@${caseData.moderator_id}>`, inline: true },
        { name: 'User', value: `<@${caseData.user_id}>`, inline: true },
        { name: 'Reason', value: caseData.reason + duration },
        { name: 'Created', value: `<t:${Math.floor(caseData.created_at / 1000)}:F>` },
      ],
      footer: { text: `Case #${caseData.id}` },
    };

    if (caseData.resolved_at) {
      embed.fields.push({
        name: 'Resolved',
        value: `<t:${Math.floor(caseData.resolved_at / 1000)}:F>`,
      });
    }

    await client.reply(message, '', false, { embeds: [embed], allowed_mentions: {} });
    return;
  }

  if (subcommand === 'edit') {
    const caseId = parseInt(args[1], 10);
    if (!caseId || caseId < 1) {
      await client.reply(message, 'Provide a case number: `.case edit <number> <new reason>`');
      return;
    }

    const caseData = await client.store.get(`modcase:${guildId}:${caseId}`);
    if (!caseData) {
      await client.reply(message, `Case #${caseId} not found.`);
      return;
    }

    const newReason = args.slice(2).join(' ').trim();
    if (!newReason) {
      await client.reply(message, 'Provide a new reason: `.case edit <number> <reason>`');
      return;
    }

    caseData.reason = newReason;
    await client.store.set(`modcase:${guildId}:${caseId}`, caseData);
    await client.reply(message, `Updated Case #${caseId} reason: _${newReason}_`);
    return;
  }

  if (subcommand === 'list') {
    const userArg = args[1];
    const userId = extractUserID(userArg);
    const cases = userId
      ? await getCasesByUser(client, guildId, userId, 25)
      : await getRecentCases(client, guildId, 25);

    if (!cases.length) {
      await client.reply(message, 'No cases found.');
      return;
    }

    const lines = cases.map((c) => {
      const icon = c.resolved ? '✅' : '⏳';
      const dur = c.duration ? ` (${Math.floor(c.duration / 60000)}m)` : '';
      return `${icon} **#${c.id}** ${c.type}${dur} → <@${c.user_id}> — _${c.reason.slice(0, 60)}${c.reason.length > 60 ? '...' : ''}_`;
    });

    const embed = {
      title: `Moderation Cases (${cases.length})`,
      description: lines.join('\n'),
      color: 0x3498db,
      footer: { text: `Guild: ${guildId}` },
    };

    await client.reply(message, '', false, { embeds: [embed], allowed_mentions: {} });
    return;
  }

  // Default: show usage
  await client.reply(message, '', false, {
    embeds: [
      {
        title: 'Case Management',
        description: [
          '`.case view <number>` — View case details',
          '`.case edit <number> <reason>` — Edit case reason',
          '`.case list [user]` — List recent cases',
        ].join('\n'),
        color: 0x3498db,
      },
    ],
    allowed_mentions: {},
  });
};

export default {
  execute,
  data: {
    name: 'case',
    description: 'Manage moderation cases',
    slash: true,
    permissions: ['MODERATE_MEMBERS'],
    usage: 'case <view|edit|list> [args]',
    options: [
      {
        name: 'view',
        description: 'View a case by number',
        type: 1,
        options: [{ name: 'number', description: 'Case number', type: 4, required: true }],
      },
      {
        name: 'edit',
        description: 'Edit a case reason',
        type: 1,
        options: [
          { name: 'number', description: 'Case number', type: 4, required: true },
          { name: 'reason', description: 'New reason', type: 3, required: true },
        ],
      },
      {
        name: 'list',
        description: 'List cases (optionally filter by user)',
        type: 1,
        options: [{ name: 'user', description: 'Filter by user', type: 6, required: false }],
      },
    ],
  },
};
