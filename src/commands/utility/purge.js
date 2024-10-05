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
    execute: async (d, a) => {
        let count = Number(a[0]) + 1;
        if (count) client.purgeMessages(d.channel_id, count).catch(console.warn);
        else if (d.message_reference) {
            let messages = [];
            let after = d.message_reference.message_id;
            count = 0;
            do {
                try {
                    messages = await client.getMessages(d.channel_id, { after, limit: 100 });
                    after = messages.at();
                    count += messages.length;
                } catch (error) {
                    if (error?.retry_after) await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
                    else console.warn(error);
                }
            } while (messages.length === 100);
            try {
                await client.purgeMessages(d.channel_id, count);
                await client.deleteMessage(d.channel_id, d.message_reference.message_id);
            } catch {};
        } else client.deleteMessage(d.channel_id, d.id).catch(console.warn);
    }
};
