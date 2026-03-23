require('dotenv').config();
const { Client, GatewayIntentBits } = require("discord.js");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const RANK_CHANNEL_ID = "1455005604278964245";

client.once('ready', async () => {
    console.log('Logged in as', client.user.tag);
    try {
        const ch = await client.channels.fetch(RANK_CHANNEL_ID);
        if (ch) {
            console.log('Found channel:', ch.name, 'in guild:', ch.guild.name);
            console.log('Can send messages:', ch.permissionsFor(client.user).has('SendMessages'));
            console.log('Can manage messages:', ch.permissionsFor(client.user).has('ManageMessages'));
        } else {
            console.log('Channel NOT found.');
        }
    } catch (e) {
        console.error('Error fetching channel:', e.message);
    }
    process.exit();
});

client.login(process.env.DISCORD_TOKEN);
