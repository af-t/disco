/**
* This command is to delete messages by replying to the message.
*/

module.exports = {
    data: {
        name: "delete",
        aliases: [ "rm", "del", "remove" ],
        description: "Delete a message"
    },
    execute: (c, d) => {
        const mToDel = new Set();

        mToDel.add(d.id);
        if (d.message_reference) mToDel.add(d.message_reference.message_id);

        c.deleteMessageBulk(d.channel_id, [...mToDel.values()]).catch(console.warn);
    }
};
