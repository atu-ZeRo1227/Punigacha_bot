require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
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

/* ========= 設定 ========= */
const TOKEN = process.env.DISCORD_TOKEN;
const GACHA_CHANNEL_ID = "1455005226892398826";
const RANK_CHANNEL_ID = "1455005604278964245";
const PAST_RANK_CHANNEL_ID = "1469382279800295567";
const COOLDOWN_MIN_DEFAULT = 60;
const GAS_URL = process.env.GACHA_LOG_URL;
const API_KEY = process.env.API_KEY || "my_secret_key"; // Code.gsのAPI_KEYと一致させる



/* ========= Client ========= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
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
      { timeout: 10000 } // 10秒でタイムアウトさせる
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
  await updateRankingChannel(); // ランキングチャンネルを更新
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

    // 既存のランキングメッセージを探して削除
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

/* ========= 起動時 ========= */
client.once("ready", async () => {
  await syncFromGas(); // 初回同期
  const commands = [
    new SlashCommandBuilder().setName("gacha").setDescription("ガチャパネルを設置").addChannelOption(o => o.setName("channel").setDescription("設置先のチャンネル").addChannelTypes(ChannelType.GuildText).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("admin_gacha").setDescription("管理者パネル").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("rank_user").setDescription("pt操作").addUserOption(o => o.setName("user").setDescription("対象ユーザー").setRequired(true)).addIntegerOption(o => o.setName("point").setDescription("追加・削除するpt").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("rank_reset").setDescription("ランキングリセット").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("gacha_sync").setDescription("スプレッドシートから再読み込み").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("cooldown_reset").setDescription("全ユーザーのクールタイムをリセット").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("gacha_cooldown").setDescription("ガチャのクールタイム(分)を設定").addIntegerOption(o => o.setName("minutes").setDescription("分").setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];
  await client.application.commands.set(commands);
  console.log(`起動完了: ${client.user.tag}`);
});

/* ========= Interaction ========= */
client.on("interactionCreate", async (i) => {
  try {
    /* --- パネル設置 --- */
    if (i.isChatInputCommand() && i.commandName === "gacha") {
      const channel = i.options.getChannel("channel");
      const title = cache.config.gacha_name ? `🎰 ${cache.config.gacha_name}` : "🎰 ガチャパネル";
      const embed = new EmbedBuilder().setTitle(title).setDescription("下のボタンを押して10連ガチャを引こう！").setColor(0x00ae86).setImage(cache.config.gacha_image || null);
      await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("gacha10").setLabel("10連ガチャ").setStyle(ButtonStyle.Primary))] });
      return i.reply({ content: "設置しました。", ephemeral: true });
    }

    /* --- クールタイム操作 --- */
    if (i.isChatInputCommand() && i.commandName === "gacha_cooldown") {
      await i.deferReply({ ephemeral: true });
      const min = i.options.getInteger("minutes");
      cache.config.cooldown_min = min;
      await saveToGas("save_config", { cooldown_min: min });
      return i.editReply(`ガチャのクールタイムを ${min}分 に設定しました。`);
    }

    if (i.isChatInputCommand() && i.commandName === "cooldown_reset") {
      await i.deferReply({ ephemeral: true });
      cache.cooldowns = {};
      await saveToGas("save_cooldown", {});
      return i.editReply("全ユーザーのクールタイムをリセットしました。");
    }

    if (i.isChatInputCommand() && i.commandName === "admin_gacha") {
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

    if (i.isButton() && i.customId === "gacha10") {
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

    /* --- 管理者モーダル表示 --- */
    if (i.isButton() && i.customId === "admin_name") {
      const modal = new ModalBuilder().setCustomId("m_name").setTitle("ガチャ名前変更");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("新ガチャ名").setStyle(TextInputStyle.Short)
      ));
      return i.showModal(modal);
    }

    if (i.isButton() && i.customId === "admin_add") {
       const m = new ModalBuilder().setCustomId("m_add").setTitle("キャラ追加");
       ["id", "rank", "name", "image", "rate"].forEach(v => m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(v).setLabel(v).setStyle(TextInputStyle.Short))));
       return i.showModal(m);
    }

    if (i.isButton() && i.customId === "admin_remove") {
      const m = new ModalBuilder().setCustomId("m_remove").setTitle("キャラ削除");
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("id").setLabel("ID").setStyle(TextInputStyle.Short)));
      return i.showModal(m);
    }

    if (i.isButton() && i.customId === "admin_list") {
      const list = cache.characters.map((c) => `[${c.id}] ${c.rank} ${c.name} (レート: ${c.rate})`).join("\n");
      return i.reply({ content: `📦 **キャラ一覧**\n\n${list || "未登録"}`, ephemeral: true });
    }

    // Modal Submit
    if (i.isModalSubmit() && i.customId === "m_name") {
      await i.deferReply({ ephemeral: true });
      const newName = i.fields.getTextInputValue("name");
      cache.config.gacha_name = newName;
      await saveToGas("save_config", { gacha_name: newName });
      return i.editReply({ content: "変更完了" });
    }

    if (i.isModalSubmit() && i.customId === "m_add") {
      await i.deferReply({ ephemeral: true });
      const newChar = { id: i.fields.getTextInputValue("id"), rank: i.fields.getTextInputValue("rank"), name: i.fields.getTextInputValue("name"), image: i.fields.getTextInputValue("image"), rate: Number(i.fields.getTextInputValue("rate")) };
      cache.characters.push(newChar);
      await saveToGas("save_config", { characters: cache.characters });
      await syncFromGas(); // 最新データを再取得してキャッシュ更新
      return i.editReply({ content: "追加しました" });
    }

    if (i.isModalSubmit() && i.customId === "m_remove") {
      await i.deferReply({ ephemeral: true });
      const id = i.fields.getTextInputValue("id");
      cache.characters = cache.characters.filter(c => c.id !== id);
      await saveToGas("save_config", { characters: cache.characters });
      await syncFromGas();
      return i.editReply({ content: "削除しました" });
    }

    if (i.isChatInputCommand() && i.commandName === "gacha_sync") {
      await i.deferReply({ ephemeral: true });
      await syncFromGas();
      return i.editReply("同期完了しました。");
    }

    if (i.isChatInputCommand() && i.commandName === "rank_user") {
      await i.deferReply({ ephemeral: true });
      await addPoint(i.options.getUser("user"), i.options.getInteger("point"));
      return i.editReply("操作完了");
    }

    if (i.isChatInputCommand() && i.commandName === "rank_reset") {
      await i.deferReply();
      const res = await rankReset();
      return i.editReply(res);
    }

  } catch (error) {
    console.error(error);
  }
});

/* ========= ランキングリセット処理 ========= */
async function rankReset() {
  const sorted = getSortedRank();
  if (sorted.length === 0) return "リセットするデータがありません。";

  const topUserId = sorted[0][0];
  const gachaName = cache.config.gacha_name || "今回のガチャ";

  try {
    // 1. 過去ランキングチャンネルへ投稿
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

    // 2. 1位のユーザーに個別にDMを送る
    try {
      const topUser = await client.users.fetch(topUserId);
      await topUser.send(
        "✨ 月間ガチャptランキング1位、本当におめでとうございます！\nこのDMの内容をスクショし、「当選用チケット」を発行して管理者に送ってください！担当者が対応いたします。"
      );
    } catch (e) {
      console.error("1位へのDM送信に失敗:", e.message);
    }

    // 3. 全員のポイントリセットと保存
    Object.keys(cache.ranking).forEach((uid) => {
      cache.ranking[uid].point = 0;
    });

    await saveToGas("save_ranking", cache.ranking);
    await updateRankingChannel(); // 表示もリセット

    return "ランキングを過去ログに保存し、全員のポイントをリセットしました。";
  } catch (err) {
    console.error("Reset error:", err);
    return "リセット中にエラーが発生しました。PAST_RANK_CHANNEL_ID等を確認してください。";
  }
}

/* ========= サーバー起動 & Bot起動 (並行処理) ========= */
// 1. 接続開始：成功するまでしつこく再試行する
async function startBot() {
  console.log("🎬 Discord Botのログインプロセスを開始します...");
  if (!TOKEN) {
    console.error("❌ エラー: DISCORD_TOKEN が設定されていません。環境変数を確認してください。");
    return;
  }

  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    try {
      attempts++;
      console.log(`📡 ログイン試行中... (${attempts}/${maxAttempts}回目)`);
      await client.login(TOKEN);
      // ログイン成功すればこのループを抜ける
      break;
    } catch (err) {
      console.error(`❌ ログイン失敗: ${err.message}`);
      if (attempts >= maxAttempts) {
        console.error("💀 制限回数に達したため再試行を中止します。");
        break;
      }
      console.log("⏳ 10秒後に再試行します...");
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

// 実行開始
startBot();

// 2. Render維持用HTTPサーバー（目覚まし窓口）を起動
const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Bot is Active");
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  console.log(`[${now}] ⏰ 目覚まし信号を受信しました。`);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 HTTPサーバー起動完了。Renderのステータスが「Success」になります (Port: ${PORT})`);
});

// 未処理のエラーで落ちないように保護
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});