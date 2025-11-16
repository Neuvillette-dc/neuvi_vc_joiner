require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");

const tokens = (process.env.TOKENS || "").split(",").map(t => t.trim()).filter(Boolean);
const messages = (process.env.MESSAGES || "").split(",").map(m => m.trim());
const channelId = process.env.CHANNEL_ID;
const interval = parseInt(process.env.INTERVAL_MS || "10000", 10);

if (!tokens.length || !channelId) {
  console.error("❌ Missing TOKENS or CHANNEL_ID in .env file");
  process.exit(1);
}

tokens.forEach((token, i) => {
  const client = new Client();

  client.once("ready", async () => {
    console.log(`✅ [${i + 1}] Logged in as ${client.user.tag}`);

    const channel = await client.channels.fetch(channelId).catch(err => {
      console.error(`❌ [${client.user.tag}] Channel fetch failed:`, err.message);
      return null;
    });
    if (!channel) return;

    const msg = messages[i] || messages[0] || "Hello there!";
    console.log(`💬 [${client.user.tag}] will send: "${msg}" every ${interval / 1000}s`);

    setInterval(async () => {
      try {
        await channel.send(msg);
        console.log(`📨 [${client.user.tag}] Sent message.`);
      } catch (err) {
        console.error(`⚠️ [${client.user.tag}] Send error:`, err.message);
      }
    }, interval);
  });

  client.login(token).catch(err => {
    console.error(`❌ Login failed for token #${i + 1}:`, err.message);
  });
});
