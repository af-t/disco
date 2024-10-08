// Clear all invites from a guild
const clearInvites = async (guildId) => {
    const invites = await client.getInvites(guildId);
    for (let i = 0; i < invites.length; i++) {
        const invite = invites[i];
        try {
            await client.deleteInvite(invite.code);
            console.debug(`Removed invite: ${invite.code}`);
        } catch {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to remove invite: ${invite.code}`);
        }
    }
};

// Copy roles from one guild to another
const copyRoles = async (sourceGuildId, targetGuildId) => {
    const roles = await client.getGuildRoles(sourceGuildId);
    let t_everyoneId;
    for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        try {
            if (role.name === "@everyone") {
                if (!t_everyoneId) {
                    const t_roles = await client.getGuildRoles(targetGuildId);
                    for (const t_role of t_roles) if (t_role.name === "@everyone") {
                        t_everyoneId = t_role.id;
                        break;
                    }
                }
                await client.editRole(targetGuildId, t_everyoneId, { permissions: role.permissions });
            } else await client.createRole(targetGuildId, {
                name: role.name,
                permissions: role.permissions,
                color: role.color,
                hoist: role.hoist,
                mentionable: role.mentionable
            });
            console.debug(`Copied role: ${role.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to copy role: ${role.name}`);
        }
    }
};

// Copy channels from one guild to another, keeping category and position intact
const copyChannels = async (sourceGuildId, targetGuildId) => {
    const channels = await client.getGuildChannels(sourceGuildId);

    const categories = channels.filter(channel => channel.type === 4); // Categories
    const normalChannels = channels.filter(channel => channel.type !== 4); // Regular channels

    const categoryMap = new Map();

    // Create categories first
    for (let i = 0; i < categories.length; i++) {
        const category = categories[i];
        try {
            const newCategory = await client.createChannel(targetGuildId, category.name, category.type, {
                position: category.position,
                nsfw: category.nsfw
            });
            console.debug(`Copied category: ${category.name}`);
            categoryMap.set(category.id, newCategory.id);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to copy category: ${category.name}`);
        }
    }

    // Create regular channels
    for (let i = 0; i < normalChannels.length; i++) {
        const channel = normalChannels[i];
        try {
            const options = {
                topic: channel.topic,
                position: channel.position,
                bitrate: channel.bitrate,
                user_limit: channel.user_limit,
                nsfw: channel.nsfw
            };

            if (channel.parent_id && categoryMap.has(channel.parent_id)) {
                options.parent_id = categoryMap.get(channel.parent_id);
            }

            await client.createChannel(targetGuildId, channel.name, channel.type, options);
            console.debug(`Copied channel: ${channel.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to copy channel: ${channel.name}`);
        }
    }
};

// Clear all channels in a guild
const clearChannels = async (guildId) => {
    const channels = await client.getGuildChannels(guildId);
    for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];
        try {
            await client.deleteChannel(channel.id);
            console.debug(`Deleted channel: ${channel.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to delete channel: ${channel.name}`);
        }
    }
};

// Clear all roles in a guild
const clearRoles = async (guildId) => {
    const roles = await client.getGuildRoles(guildId);
    for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        if (role.name !== "@everyone") {  // Don't delete the default '@everyone' role
            try {
                await client.deleteRole(guildId, role.id);
                console.debug(`Deleted role: ${role.name}`);
            } catch (error) {
                if (error?.retry_after) {
                    i--;
                    await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
                } else console.warn(`Failed to delete role: ${role.name}`);
            }
        }
    }
};

// Clear all emojis in a guild
const clearEmojis = async (guildId) => {
    const emojis = await client.getEmojis(guildId);
    for (let i = 0; i < emojis.length; i++) {
        const emoji = emojis[i];
        try {
            await client.deleteEmoji(guildId, emoji.id);
            console.debug(`Deleted emoji: ${emoji.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to delete emoji: ${emoji.name}`);
        }
    }
};

// Copy all emojis from one guild to another
const copyEmojis = async (sourceGuildId, targetGuildId) => {
    const emojis = await client.getEmojis(sourceGuildId);
    for (let i = 0; i < emojis.length; i++) {
        const emoji = emojis[i];
        const imageUrl = emoji.animated
            ? `https://cdn.discordapp.com/emojis/${emoji.id}.gif`
            : `https://cdn.discordapp.com/emojis/${emoji.id}.png`;
        try {
            await client.createEmoji(targetGuildId, emoji.name, imageUrl, emoji.roles);
            console.debug(`Copied emoji: ${emoji.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to copy emoji: ${emoji.name}`);
        }
    }
};

// Clear all soundboards in a guild
const clearSoundboards = async (guildId) => {
    const soundboards = await client.getSoundboards(guildId); // Assuming there's a getSoundboards function
    for (let i = 0; i < soundboards.length; i++) {
        const soundboard = soundboards[i];
        try {
            await client.deleteSoundboard(guildId, soundboard.id); // Assuming there's a deleteSoundboard function
            console.debug(`Deleted soundboard: ${soundboard.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to delete soundboard: ${soundboard.name}`);
        }
    }
};

// Copy all soundboards from one guild to another
const copySoundboards = async (sourceGuildId, targetGuildId) => {
    const soundboards = await client.getSoundboards(sourceGuildId);
    for (let i = 0; i < soundboards.length; i++) {
        const soundboard = soundboards[i];
        try {
            await client.createSoundboard(targetGuildId, soundboard.name, soundboard.file);
            console.debug(`Copied soundboard: ${soundboard.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to copy soundboard: ${soundboard.name}`);
        }
    }
};

// Clear all stickers in a guild
const clearStickers = async (guildId) => {
    const stickers = await client.getStickers(guildId);
    for (let i = 0; i < stickers.length; i++) {
        const sticker = stickers[i];
        try {
            await client.deleteSticker(guildId, sticker.id);
            console.debug(`Deleted sticker: ${sticker.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to delete sticker: ${sticker.name}`);
        }
    }
};

// Copy all stickers from one guild to another
const copyStickers = async (sourceGuildId, targetGuildId) => {
    const stickers = await client.getStickers(sourceGuildId);
    for (let i = 0; i < stickers.length; i++) {
        const sticker = stickers[i];
        const imageUrl = `https://cdn.discordapp.com/stickers/${sticker.id}.png`;
        try {
            await client.createSticker(targetGuildId, sticker.name, sticker.tags, imageUrl, sticker.type);
            console.debug(`Copied sticker: ${sticker.name}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else console.warn(`Failed to copy sticker: ${sticker.name}`);
        }
    }
};

// Copy all content in the source guild to the target guild
const copyGuild = async (sourceGuildId, targetGuildId, template = true) => {
    await clearChannels(targetGuildId);
    await clearRoles(targetGuildId);
    await copyRoles(sourceGuildId, targetGuilId);
    await copyChannels(sourceGuildId, targetGuildId);
    if (!template) {
        await clearEmojis(targetGuildId);
        await copyEmojis(sourceGuildId, targetGuildId);
        await clearSoundboards(targetGuildId);
        await copySoundboards(sourceGuildId, targetGuildId);
        await clearStickers(targetGuildId);
        await copyStickers(sourceGuildId, targetGuildId);
    }
};

// Clear timeout for all members in a guild
const clearTimeouts = async (guildId) => {
    const members = await client.getGuildMembers(guildId, { timeout: true }); // Only get members with timeout
    for (let i = 0; i < members.length; i++) {
        const member = members[i];
        try {
            await client.unmuteMember(guildId, member.user.id); // Remove timeout with unmute
            console.debug(`Removed timeout for member: ${member.user.username}`);
        } catch (error) {
            if (error?.retry_after) {
                i--;
                await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
            } else {
                console.warn(`Failed to remove timeout for member: ${member.user.username}`);
            }
        }
    }
};

module.exports = {
    clearInvites,
    copyRoles,
    clearRoles,
    copyChannels,
    clearChannels,
    clearEmojis,
    copyEmojis,
    clearSoundboards,
    copySoundboards,
    clearStickers,
    copyStickers,
    clearTimeouts,
    copyGuild
};
