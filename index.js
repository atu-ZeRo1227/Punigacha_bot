require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const axios = require("axios");
const http = require("http");

/* ========= 設定 ========= */
const TOKEN = process.env.DISCORD_TOKEN;
const GACHA_CHANNEL_ID = "1455005226892398826";
const RANK_CHANNEL_ID = "1455005604278964245";
const PAST_RANK_CHANNEL_ID = "1469382279800295567";
const COOLDOWN_MIN_DEFAULT = 60;
const GAS_URL = process.env.GACHA_LOG_URL;
const API_KEY = process.env.API_KEY || "my_secret_key";
const PORT = process.env.PORT || 10000;

/* ========= 1. Render用HTTPサーバー (独立して動作) ========= */
const startHttpServer = () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bot components are running independently.");
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    console.log(`[${now}] ⏰ HTTP Health Check received.`);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 HTTP Server is listening on Port: ${PORT}`);
  });

  server.on('error', (err) => {
    console.error("HTTP Server Error:", err);
  });
};

/* ========= 2. Discord Bot Client 設定 & ログイン ========= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 明示的に指定
  ],
});

/* ========= 共通（Spreadsheet API経由） ========= */
let cache = {
  config: {},
  characters: [],
  ranking: {},
  cooldowns: {}
};

// GASから全データを取得して同期
async function syncFromGas() {
  if (!GAS_URL) return;
  try {
    const res = await axios.post(GAS_URL, 
      { action: "get_all", key: API_KEY },
      { timeout: 15000 } // タイムアウトを少し長めに設定
    );
    if (res.data) {
      cache.config = res.data.config || {};
      cache.characters = res.data.characters || [];
      cache.ranking = res.data.ranking || {};
      cache.cooldowns = res.data.cooldowns || {};
      console.log("Synced all data from Spreadsheet");
    }
  } catch (err) {
    console.error("Failed to sync from GAS:", err.message);
  }
}

async function saveToGas(action, data) {
  if (!GAS_URL) return;
  try {
    await axios.post(GAS_URL, { action, key: API_KEY, data });
  } catch (err) {
    console.error(`Failed to save to GAS (${action}):`, err.message);
  }
}

const RANK_POINT = {
  "uz+": 10, uz: 8, zzz: 6, zz: 4, z: 2, 
  sss: 1, ss: 1, s: 1, a: 1, b: 1, c: 1, d: 1, e: 1,
};

/* ========= ガチャ ========= */
function draw10() {
  const chars = cache.characters;
  if (chars.length === 0) return [];

  const totalWeight = chars.reduce((acc, c) => acc + (Number(c.rate) || 0), 0);
  if (totalWeight <= 0) return [];

  const results = [];
  for (let i = 0; i < 10; i++) {
    let r = Math.random() * totalWeight;
    let picked = false;
    for (const c of chars) {
      const rate = Number(c.rate) || 0;
      if (r < rate) {
        results.push(c);
        picked = true;
        break;
      }
      r -= rate;
    }
    if (!picked && chars.length > 0) results.push(chars[chars.length - 1]);
  }
  return results;
}

/* ========= クールタイム ========= */
function checkCooldown(uid) {
  if (!cache.cooldowns[uid]) return 0;
  const diff = Date.now() - cache.cooldowns[uid];
  const cooldownMin = Number(cache.config.cooldown_min) || COOLDOWN_MIN_DEFAULT;
  const remain = cooldownMin * 60000 - diff;
  return remain > 0 ? remain : 0;
}

async function setCooldown(uid) {
  cache.cooldowns[uid] = Date.now();
  await saveToGas("save_cooldown", cache.cooldowns);
}

/* ========= ランキング ========= */
async function addPoint(user, pt) {
  if (!cache.ranking[user.id]) cache.ranking[user.id] = { point: 0 };
  cache.ranking[user.id].name = user.username;
  cache.ranking[user.id].point += pt;
  
  await saveToGas("save_ranking", cache.ranking);
  await updateRankingChannel(); 
}

async function updateRankingChannel() {
  if (!RANK_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(RANK_CHANNEL_ID);
    if (!channel) return;

    const sorted = getSortedRank().slice(0, 20);
    const embed = new EmbedBuilder()
      .setTitle("🏆 ガチャランキング TOP20")
      .setColor(0xffd700)
      .setTimestamp();
    
    sorted.forEach((u, i) => {
      embed.addFields({ name: `${i + 1}位 ${u[1].name}`, value: `${u[1].point}pt` });
    });

    const messages = await channel.messages.fetch({ limit: 50 });
    const oldMsg = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title === "🏆 ガチャランキング TOP20");
    if (oldMsg) await oldMsg.delete().catch(() => {});

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to update ranking channel:", err.message);
  }
}

function getSortedRank() {
  return Object.entries(cache.ranking).sort((a, b) => b[1].point - a[1].point);
}

function getUserRank(uid) {
  return getSortedRank().findIndex((v) => v[0] === uid) + 1;
}

/* ========= 起動時イベント ========= */
client.once(Events.ClientReady, async () => {
  console.log(`✅ ログイン成功: ${client.user.tag}`);
  await syncFromGas(); 
  
  const commands = [
    new SlashCommandBuilder().setName("gacha").setDescription("ガチャパネルを設置").addChannelOption(o => o.setName("channel").setDescription("設置先のチャンネル").addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("admin_gacha").setDescription("管理者パネル").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("rank_user").setDescription("pt操作").addUserOption(o => o.setName("user").setDescription("対象ユーザー").setRequired(true)).addIntegerOption(o => o.setName("point").setDescription("追加・削除するpt").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("rank_reset").setDescription("ランキングリセット").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("gacha_sync").setDescription("スプレッドシートから再読み込み").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("cooldown_reset").setDescription("全ユーザーのクールタイムをリセット").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("gacha_cooldown").setDescription("ガチャのクールタイム(分)を設定").addIntegerOption(o => o.setName("minutes").setDescription("分").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];
  
  try {
    await client.application.commands.set(commands);
    console.log("🚀 スラッシュコマンドの登録が完了しました。");
  } catch (err) {
    console.error("スラッシュコマンドの登録に失敗しました:", err);
  }
});

/* ========= Interaction処理 ========= */
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (i.commandName === "gacha") {
        const channel = i.options.getChannel("channel");
        const title = cache.config.gacha_name ? `🎰 ${cache.config.gacha_name}` : "🎰 ガチャパネル";
        const embed = new EmbedBuilder().setTitle(title).setDescription("下のボタンを押して10連ガチャを引こう！").setColor(0x00ae86).setImage(cache.config.gacha_image || null);
        await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("gacha10").setLabel("10連ガチャ").setStyle(ButtonStyle.Primary))] });
        return i.reply({ content: "設置しました。", ephemeral: true });
      }

      if (i.commandName === "gacha_cooldown") {
        await i.deferReply({ ephemeral: true });
        const min = i.options.getInteger("minutes");
        cache.config.cooldown_min = min;
        await saveToGas("save_config", { cooldown_min: min });
        return i.editReply(`ガチャのクールタイムを ${min}分 に設定しました。`);
      }

      if (i.commandName === "cooldown_reset") {
        await i.deferReply({ ephemeral: true });
        cache.cooldowns = {};
        await saveToGas("save_cooldown", {});
        return i.editReply("全ユーザーのクールタイムをリセットしました。");
      }

      if (i.commandName === "admin_gacha") {
        return i.reply({
          content: "⚙ 管理者パネル", ephemeral: true,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("admin_name").setLabel("名前変更").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("admin_list").setLabel("キャラ一覧").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("admin_add").setLabel("キャラ追加").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("admin_remove").setLabel("キャラ削除").setStyle(ButtonStyle.Danger),
          )]
        });
      }

      if (i.commandName === "gacha_sync") {
        await i.deferReply({ ephemeral: true });
        await syncFromGas();
        return i.editReply("同期完了しました。");
      }

      if (i.commandName === "rank_user") {
        await i.deferReply({ ephemeral: true });
        await addPoint(i.options.getUser("user"), i.options.getInteger("point"));
        return i.editReply("操作完了");
      }

      if (i.commandName === "rank_reset") {
        await i.deferReply();
        const res = await rankReset();
        return i.editReply(res);
      }
    }

    if (i.isButton()) {
      if (i.customId === "gacha10") {
        await i.deferReply({ ephemeral: true });
        const remain = checkCooldown(i.user.id);
        if (remain > 0) return i.editReply({ content: `⏳ あと ${Math.ceil(remain / 60000)}分です。` });

        const results = draw10();
        if (results.length < 10) return i.editReply({ content: "データなし" });

        await setCooldown(i.user.id);
        let total = 0;
        const embed = new EmbedBuilder().setTitle("🎰 ガチャ結果").setColor(0xffd700).setTimestamp();
        results.forEach((c, index) => {
          const pt = RANK_POINT[c.rank.toLowerCase()] || 0;
          total += pt;
          embed.addFields({ name: `${index + 1}. [${c.rank.toUpperCase()}] ${c.name}`, value: `獲得pt: ${pt}pt\n[画像](${c.image})` });
        });

        await addPoint(i.user, total);
        const currentRank = getUserRank(i.user.id);
        embed.addFields({ name: "━━━━━━━━━━━━━━━", value: `💰 獲得: ${total}pt | 👑 順位: ${currentRank}位` });

        try {
          await i.user.send({ embeds: [embed] });
          await i.editReply({ content: "結果をDMに送信しました。" });
        } catch (e) {
          await i.editReply({ content: "DM送信失敗。設定を確認してください。" });
        }
      }

      if (i.customId === "admin_name") {
        const modal = new ModalBuilder().setCustomId("m_name").setTitle("ガチャ名前変更");
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("name").setLabel("新ガチャ名").setStyle(TextInputStyle.Short)
        ));
        return i.showModal(modal);
      }

      if (i.customId === "admin_add") {
         const m = new ModalBuilder().setCustomId("m_add").setTitle("キャラ追加");
         ["id", "rank", "name", "image", "rate"].forEach(v => m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(v).setLabel(v).setStyle(TextInputStyle.Short))));
         return i.showModal(m);
      }

      if (i.customId === "admin_remove") {
        const m = new ModalBuilder().setCustomId("m_remove").setTitle("キャラ削除");
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("ID").setStyle(TextInputStyle.Short)));
        return i.showModal(m);
      }

      if (i.customId === "admin_list") {
        const list = cache.characters.map((c) => `[${c.id}] ${c.rank} ${c.name} (レート: ${c.rate})`).join("\n");
        return i.reply({ content: `📦 **キャラ一覧**\n\n${list || "未登録"}`, ephemeral: true });
      }
    }

    if (i.isModalSubmit()) {
      if (i.customId === "m_name") {
        await i.deferReply({ ephemeral: true });
        const newName = i.fields.getTextInputValue("name");
        cache.config.gacha_name = newName;
        await saveToGas("save_config", { gacha_name: newName });
        return i.editReply({ content: "変更完了" });
      }

      if (i.customId === "m_add") {
        await i.deferReply({ ephemeral: true });
        const newChar = { id: i.fields.getTextInputValue("id"), rank: i.fields.getTextInputValue("rank"), name: i.fields.getTextInputValue("name"), image: i.fields.getTextInputValue("image"), rate: Number(i.fields.getTextInputValue("rate")) };
        cache.characters.push(newChar);
        await saveToGas("save_config", { characters: cache.characters });
        await syncFromGas(); 
        return i.editReply({ content: "追加しました" });
      }

      if (i.customId === "m_remove") {
        await i.deferReply({ ephemeral: true });
        const id = i.fields.getTextInputValue("id");
        cache.characters = cache.characters.filter(c => c.id !== id);
        await saveToGas("save_config", { characters: cache.characters });
        await syncFromGas();
        return i.editReply({ content: "削除しました" });
      }
    }
  } catch (error) {
    console.error("Interaction Error:", error);
  }
});

/* ========= ランキングリセット処理 ========= */
async function rankReset() {
  const sorted = getSortedRank();
  if (sorted.length === 0) return "リセットするデータがありません。";

  const topUserId = sorted[0][0];
  const gachaName = cache.config.gacha_name || "今回のガチャ";

  try {
    const pastCh = await client.channels.fetch(PAST_RANK_CHANNEL_ID).catch(() => null);
    if (pastCh) {
      const pastEmbed = new EmbedBuilder()
        .setTitle(`🏆 ${gachaName}：月間最終ランキング結果`)
        .setColor(0x00ae86)
        .setTimestamp();
      
      sorted.slice(0, 20).forEach((u, index) => {
        pastEmbed.addFields({ name: `${index + 1}位 ${u[1].name}`, value: `${u[1].point}pt` });
      });

      await pastCh.send({ embeds: [pastEmbed] });
      await pastCh.send(`🎉 **今月の第1位は <@${topUserId}> さんでした！おめでとうございます！**`);
    }

    try {
      const topUser = await client.users.fetch(topUserId);
      await topUser.send(
        "✨ 月間ガチャptランキング1位、本当におめでとうございます！\nこのDMの内容をスクショし、「当選用チケット」を発行して管理者に送ってください！担当者が対応いたします。"
      );
    } catch (e) {
      console.error("1位へのDM送信に失敗:", e.message);
    }

    Object.keys(cache.ranking).forEach((uid) => {
      cache.ranking[uid].point = 0;
    });

    await saveToGas("save_ranking", cache.ranking);
    await updateRankingChannel(); 

    return "ランキングを過去ログに保存し、全員のポイントをリセットしました。";
  } catch (err) {
    console.error("Reset error:", err);
    return "リセット中にエラーが発生しました。";
  }
}

/* ========= 3. 起動実行部分 ========= */

// HTTPサーバーを起動
startHttpServer();

// Discord Botを起動
async function loginToDiscord() {
  if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN が設定されていません。");
    return;
  }
  
  try {
    console.log("📡 Discordにログインを試行します...");
    await client.login(TOKEN);
  } catch (err) {
    console.error("❌ ログインエラー:", err);
    // 5秒後に再試行
    setTimeout(loginToDiscord, 5000);
  }
}

loginToDiscord();

/* ========= エラー対策 ========= */
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});