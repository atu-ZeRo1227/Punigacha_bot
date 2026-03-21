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
const fs = require("fs");

/* ========= 設定 ========= */
const TOKEN = process.env.DISCORD_TOKEN;
const GACHA_CHANNEL_ID = "1455005226892398826";
const RANK_CHANNEL_ID = "1455005604278964245";
const PAST_RANK_CHANNEL_ID = "1469382279800295567";
const COOLDOWN_MIN = 60;
const GAS_URL = process.env.GACHA_LOG_URL;


/* ========= Render用Webサーバー (ポートバインディング) ========= */
const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running!");
}).listen(process.env.PORT || 3000);

/* ========= Client ========= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* ========= 共通 ========= */
const load = (f) => {
  try {
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`Error loading ${f}:`, e);
    return {};
  }
};
const save = (f, d) => {
  try {
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error(`Error saving ${f}:`, e);
  }
};

async function saveToSheet(type, data) {
  const gasUrl = process.env.GACHA_LOG_URL;
  if (!gasUrl) return;

  try {
    const response = await fetch(gasUrl, {
      method: "POST",
      body: JSON.stringify({
        type: type,
        timestamp: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
        ...data
      })
    });
    if (!response.ok) {
      console.error(`GAS sync failed (HTTP ${response.status}) (${type}):`, await response.text());
    }
  } catch (err) {
    console.error(`GAS sync failed (Network/Other) (${type}):`, err);
  }
}
async function syncToGas(type, data) { await saveToSheet(type, data); } // 既存の呼び出し箇所の互換性維持

const RANK_POINT = {
  "uz+": 10,
  uz: 8,
  zzz: 6,
  zz: 4,
  z: 2,
  sss: 1,
  ss: 1,
  s: 1,
  a: 1,
  b: 1,
  c: 1,
  d: 1,
  e: 1,
};

/* ========= ガチャ ========= */
function draw10() {
  const data = load("./gacha.json");
  const chars = data.characters || [];
  if (chars.length === 0) return [];

  // 全キャラクターのレート合計を計算（これが100なら「設定値＝％」になる）
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
    // 念のためのフォールバック
    if (!picked && chars.length > 0) results.push(chars[chars.length - 1]);
  }
  return results;
}

/* ========= クールタイム ========= */
function checkCooldown(uid) {
  const cd = load("./cooldown.json");
  if (!cd[uid]) return 0;
  const diff = Date.now() - cd[uid];
  const remain = COOLDOWN_MIN * 60000 - diff;
  return remain > 0 ? remain : 0;
}
function setCooldown(uid) {
  const cd = load("./cooldown.json");
  cd[uid] = Date.now();
  save("./cooldown.json", cd);
}

/* ========= ランキング ========= */
function addPoint(user, pt) {
  const r = load("./ranking.json");
  if (!r[user.id]) r[user.id] = { name: user.username, point: 0 };
  r[user.id].point += pt;
  save("./ranking.json", r);
  syncToGas("point_update", {
    user_id: user.id,
    user_name: user.username,
    added_point: pt,
    total_point: r[user.id].point
  });
}
function getSortedRank() {
  const r = load("./ranking.json");
  return Object.entries(r).sort((a, b) => b[1].point - a[1].point);
}
function getUserRank(uid) {
  return getSortedRank().findIndex((v) => v[0] === uid) + 1;
}
async function updateRankingChannel() {
  try {
    const ch = await client.channels.fetch(RANK_CHANNEL_ID);
    if (!ch || !ch.messages) return;

    const top20 = getSortedRank().slice(0, 20);

    const embed = new EmbedBuilder()
      .setTitle("🏆 ガチャランキング TOP20")
      .setColor(0xffd700)
      .setTimestamp();

    top20.forEach((u, i) =>
      embed.addFields({ name: `${i + 1}位 ${u[1].name}`, value: `${u[1].point}pt` }),
    );

    // チャンネル内の全メッセージを削除（常に最新のランキングのみを表示するため）
    let fetched;
    do {
      fetched = await ch.messages.fetch({ limit: 100 });
      if (fetched.size > 0) {
        await ch.bulkDelete(fetched).catch(async (e) => {
          // 14日以上前のメッセージが含まれる場合の個別削除
          for (const m of fetched.values()) {
            await m.delete().catch(() => { });
          }
        });
      }
    } while (fetched.size > 0);

    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("ランキング更新中にエラーが発生しました:", e);
  }
}

async function refreshGachaData() {
  const gasUrl = process.env.GACHA_LOG_URL;
  if (!gasUrl) return { success: false, message: "GACHA_LOG_URLが設定されていません。" };

  try {
    const response = await fetch(`${gasUrl}?type=get_gacha`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gacha sync failed (HTTP ${response.status}):`, errorText);
      throw new Error(`GASからのデータ取得に失敗しました。(HTTP ${response.status})`);
    }

    const data = await response.json();
    if (data && data.characters) {
      save("./gacha.json", data);
      return { success: true, message: "ガチャデータを更新しました。" };
    } else {
      console.error("Gacha sync failed: Invalid data format", data);
      return { success: false, message: "取得したデータが不正です。" };
    }
  } catch (e) {
    console.error("Gacha sync error:", e);
    return { success: false, message: `エラー: ${e.message}` };
  }
}

/* ========= 起動時 ========= */
client.once("ready", async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName("gacha")
      .setDescription("ガチャパネルを設置する")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("設置先のチャンネル").addChannelTypes(ChannelType.GuildText).setRequired(true),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("admin_gacha")
      .setDescription("管理者ガチャパネル")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("rank_user")
      .setDescription("特定ユーザーpt操作")
      .addUserOption((o) => o.setName("user").setDescription("対象のユーザー").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("point").setDescription("追加・削除するポイント").setRequired(true),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("rank_reset")
      .setDescription("全員のポイントを0にリセット")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName("gacha_sync")
      .setDescription("スプレッドシートからガチャデータを同期する")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];
  await client.application.commands.set(commands);
  console.log(`起動完了: ${client.user.tag}`);
  console.log(`所属サーバー数: ${client.guilds.cache.size}`);
});

/* ========= Interaction ========= */
client.on("interactionCreate", async (i) => {
  try {

    /* --- ガチャパネル --- */
    if (i.isChatInputCommand() && i.commandName === "gacha") {
      const channel = i.options.getChannel("channel");

      const gachaData = load("./gacha.json");
      const title = gachaData.gacha_name ? `🎰 ${gachaData.gacha_name}` : "🎰 ガチャパネル";

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription("下のボタンを押して10連ガチャを引こう！")
        .setColor(0x00ae86)
        .setImage(gachaData.gacha_image || null); // 画像が設定されていれば表示

      try {
        await channel.send({
          embeds: [embed],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("gacha10")
                .setLabel("10連ガチャ")
                .setStyle(ButtonStyle.Primary),
            ),
          ],
        });
        return i.reply({ content: `${channel} にガチャパネルを設置しました。`, ephemeral: true });
      } catch (e) {
        console.error(e);
        return i.reply({ content: "チャンネルにメッセージを送信できませんでした。権限を確認してください。", ephemeral: true });
      }
    }

    /* --- 管理者ガチャパネル --- */
    if (i.isChatInputCommand() && i.commandName === "admin_gacha") {
      return i.reply({
        content: "⚙ 管理者ガチャパネル",
        ephemeral: true,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("admin_name")
              .setLabel("ガチャ名前変更")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId("admin_list")
              .setLabel("中身一覧")
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId("admin_add")
              .setLabel("キャラ追加")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId("admin_remove")
              .setLabel("キャラ削除")
              .setStyle(ButtonStyle.Danger),
          ),
        ],
      });
    }

    /* --- ガチャ実行 --- */
    if (i.isButton() && i.customId === "gacha10") {
      const remain = checkCooldown(i.user.id);
      if (remain > 0) {
        const min = Math.ceil(remain / 60000);
        try {
          await i.user.send(`⏳ あと ${min}分で引けます`);
        } catch (e) {
          // DMが送れない場合などは無視
        }
        return i.reply({ content: "クールタイム中です。DMを確認してください。", ephemeral: true });
      }

      const before = getSortedRank().slice(0, 20);
      const results = draw10();

      // ガチャデータが空の場合のハンドリング
      if (results.length < 10) {
        return i.reply({ content: "ガチャデータが正しく設定されていません。(キャラクターが登録されていないか、確率が0です)", ephemeral: true });
      }

      setCooldown(i.user.id);

      let total = 0;
      const embed = new EmbedBuilder()
        .setTitle("🎰 10連ガチャ結果")
        .setColor(0xffd700) // ゴールド色
        .setTimestamp();

      results.forEach((c, index) => {
        const pt = RANK_POINT[c.rank.toLowerCase()] || 0;
        total += pt;
        const rankUpper = c.rank.toUpperCase();
        embed.addFields({
          name: `${index + 1}. [${rankUpper}] ${c.name}`,
          value: `獲得pt: ${pt}pt\n[キャラクター画像](${c.image})`,
          inline: false
        });
      });

      addPoint(i.user, total);

      // 現在の順位を取得
      const currentRank = getUserRank(i.user.id);

      // スプレッドシートへデータ送信
      const gachaName = load("./gacha.json").gacha_name || "ガチャ";
      const pulledText = results.map((c) => `[${c.rank.toUpperCase()}] ${c.name}`).join(", ");
      const userCurrentPt = (load("./ranking.json")[i.user.id] || { point: 0 }).point;

      await saveToSheet("gacha_draw", {
        user_id: i.user.id,
        user_name: i.user.username,
        gacha_name: gachaName,
        contents: pulledText,
        points: userCurrentPt
      });

      embed.addFields(
        { name: "━━━━━━━━━━━━━━━", value: "\u200B" }, // 区切り線
        { name: "💰 今回の獲得ポイント", value: `${total}pt`, inline: true },
        { name: "👑 現在の順位", value: `${currentRank}位`, inline: true },
      );

      try {
        await i.user.send({ embeds: [embed] });
        await i.reply({ content: "結果をDMで送信しました。", ephemeral: true });
      } catch (e) {
        console.error(e);
        await i.reply({ content: "DMの送信に失敗しました。設定を確認してください。", ephemeral: true });
      }

      const after = getSortedRank().slice(0, 20);
      if (JSON.stringify(before) !== JSON.stringify(after)) await updateRankingChannel();
    }

    /* --- 管理者Modal --- */
    if (i.isButton() && i.customId === "admin_name") {
      const modal = new ModalBuilder().setCustomId("m_name").setTitle("ガチャ名前変更");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("name")
            .setLabel("新ガチャ名")
            .setStyle(TextInputStyle.Short),
        ),
      );
      return i.showModal(modal);
    }

    if (i.isModalSubmit() && i.customId === "m_name") {
      const d = load("./gacha.json");
      d.gacha_name = i.fields.getTextInputValue("name");
      save("./gacha.json", d);
      syncToGas("gacha_name_update", { gacha_name: d.gacha_name });
      return i.reply({ content: "変更しました", ephemeral: true });
    }

    if (i.isButton() && i.customId === "admin_add") {
      const m = new ModalBuilder().setCustomId("m_add").setTitle("キャラ追加");
      ["id", "rank", "name", "image", "rate"].forEach((v) =>
        m.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(v).setLabel(v).setStyle(TextInputStyle.Short),
          ),
        ),
      );
      return i.showModal(m);
    }

    if (i.isModalSubmit() && i.customId === "m_add") {
      const d = load("./gacha.json");
      if (!d.characters) d.characters = [];
      if (d.characters.some((c) => c.id === i.fields.getTextInputValue("id")))
        return i.reply({ content: "ID重複", ephemeral: true });


      const newChar = {
        id: i.fields.getTextInputValue("id"),
        rank: i.fields.getTextInputValue("rank"),
        name: i.fields.getTextInputValue("name"),
        image: i.fields.getTextInputValue("image"),
        rate: Number(i.fields.getTextInputValue("rate")),
      };
      d.characters.push(newChar);
      save("./gacha.json", d);
      syncToGas("character_add", newChar);
      return i.reply({ content: "追加しました", ephemeral: true });
    }

    if (i.isButton() && i.customId === "admin_remove") {
      const m = new ModalBuilder().setCustomId("m_remove").setTitle("キャラ削除");
      m.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("id").setLabel("ID").setStyle(TextInputStyle.Short),
        ),
      );
      return i.showModal(m);
    }

    if (i.isModalSubmit() && i.customId === "m_remove") {
      const d = load("./gacha.json");
      if (!d.characters) d.characters = [];
      const before = d.characters.length;
      const removeId = i.fields.getTextInputValue("id");
      d.characters = d.characters.filter((c) => c.id !== removeId);
      if (before === d.characters.length)
        return i.reply({ content: "見つかりません", ephemeral: true });
      save("./gacha.json", d);
      syncToGas("character_remove", { id: removeId });
      return i.reply({ content: "削除しました", ephemeral: true });
    }


    if (i.isButton() && i.customId === "admin_list") {
      const d = load("./gacha.json");
      const chars = d.characters || [];
      const total = chars.reduce((acc, c) => acc + (Number(c.rate) || 0), 0);
      const list = chars.map((c) => `[${c.id}] ${c.rank} ${c.name} (確率重み: ${c.rate})`).join("\n");
      return i.reply({
        content: `📦 **キャラ一覧** (合計レート: ${total})\n※合計が100の時、レートがそのまま％になります\n\n${list || "未登録"}`,
        ephemeral: true,
      });
    }


    /* --- ランキング操作 --- */
    if (i.isChatInputCommand() && i.commandName === "rank_user") {
      await i.deferReply({ ephemeral: true });
      addPoint(i.options.getUser("user"), i.options.getInteger("point"));
      await updateRankingChannel();
      return i.editReply("操作完了");
    }

    if (i.isChatInputCommand() && i.commandName === "rank_reset") {
      const r = load("./ranking.json");
      const gachaData = load("./gacha.json");
      const gachaName = gachaData.gacha_name || "今回のガチャ";

      const sortedDetails = getSortedRank();
      if (sortedDetails.length === 0) return i.reply("リセット可能なランキングデータがありません。");

      const topUserId = sortedDetails[0][0];

      try {
        await i.deferReply();
        // 1. 過去ランキングチャンネルへ投稿
        const pastCh = await client.channels.fetch(PAST_RANK_CHANNEL_ID).catch(() => null);
        if (pastCh) {
          const pastEmbed = new EmbedBuilder()
            .setTitle(`🏆 ${gachaName}：月間最終ランキング`)
            .setColor(0x00ae86)
            .setTimestamp();

          sortedDetails.slice(0, 20).forEach((u, index) => {
            pastEmbed.addFields({ name: `${index + 1}位 ${u[1].name}`, value: `${u[1].point}pt` });
          });

          await pastCh.send({ embeds: [pastEmbed] });
          await pastCh.send(`🎉 **今月の一位は <@${topUserId}> さんでした。おめでとうございます！！**`);
        }

        // 2. 1位のユーザーに個別にDMを送る
        try {
          const topUser = await client.users.fetch(topUserId);
          await topUser.send(
            "月間ガチャptランキング一位おめでとうございます！このDMの内容をスクショし、当選用チケットを発行して、送ってください！管理者が担当致します"
          );
        } catch (e) {
          console.error("1位のユーザーへのDM送信に失敗しました:", e);
        }

        // 3. ポイントをリセット
        Object.keys(r).forEach((uid) => {
          r[uid].point = 0;
        });
        save("./ranking.json", r);
        await updateRankingChannel();

        return i.editReply("ランキングを過去ログに保存し、月間ランキングをリセットしました。");
      } catch (err) {
        console.error("リセット処理中にエラーが発生しました:", err);
        if (i.deferred || i.replied) {
          return i.editReply({ content: "リセット処理中にエラーが発生しました。PAST_RANK_CHANNEL_IDを確認してください。" });
        }
        return i.reply({ content: "リセット処理中にエラーが発生しました。PAST_RANK_CHANNEL_IDを確認してください。", ephemeral: true });
      }
    }

    /* --- ガチャ同期 --- */
    if (i.isChatInputCommand() && i.commandName === "gacha_sync") {
      await i.deferReply({ ephemeral: true });
      const result = await refreshGachaData();
      return i.editReply(result.message);
    }

  } catch (error) {
    console.error("Interaction processing error:", error);
    try {
      if (i.deferred || i.replied) {
        await i.followUp({ content: "エラーが発生しました。", ephemeral: true });
      } else {
        await i.reply({ content: "エラーが発生しました。", ephemeral: true });
      }
    } catch (err) {
      console.error("Failed to send error reply:", err);
    }
  }
});



client.login(TOKEN);