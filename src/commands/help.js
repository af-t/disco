module.exports = {
    data: {
        name: "help",
        description: "displays a list of commands available"
    },
    execute: (c, d) => {
        const embeds = [];
        const cmds = new Map();
        let embed;

        for (const key in global.cmds) if (!cmds.has(global.cmds[key].data.name)) cmds.set(global.cmds[key].data.name, global.cmds[key]);
        for (const cmd of [...cmds.values()]) {
            if (!embed) embed = { type: "rich", color: 0xc99630, description: "" };

            embed.description += `- ${cmd.data.usage ?? cmd.data.name}\t-\t${cmd.data.description ?? "No description provided"}.\n`;

            if (embed.description.length >= 3800) {
                embeds.push(embed);
                embed = null;
            }
        }
        if (embed) embeds.push(embed);

        c.sendMessage(d.channel_id, "### Commands available", { embeds }).catch(console.warn);
    }
};
