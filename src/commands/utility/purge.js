module.exports = {
    data: {
        name: 'purge',
        description: 'Purge messages',
        type: 3,
        options: [{
            name: "amount",
            description: "The number of messages to delete",
            required: true,
            type: 4
        }],
        usage: 'purge <amount>',
        support_interaction: true,
        guild_command: true,
    },
    execute: (c, d, a) => {
        const count = Number(a[0]) + 1;
        if (count) c.purgeMessages(d.channel_id, count).catch(console.warn);
        else c.deleteMessage(d.channel_id, d.id).catch(console.warn);
    }
};
