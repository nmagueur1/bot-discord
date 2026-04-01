require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
        ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
        StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
        ChannelType, PermissionFlagsBits,
        ButtonBuilder, ButtonStyle, Partials } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, onSnapshot } = require('firebase/firestore');
const admin = require('firebase-admin');

// Parse le JSON depuis l'env
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

console.log('Firebase initialisé ✅');

// ── FIREBASE CLIENT ───────────────────────────────
const firebaseConfig = {
  apiKey:            process.env.FIREBASE_API_KEY,
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.FIREBASE_PROJECT_ID,
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.FIREBASE_APP_ID,
};

const fireApp = initializeApp(firebaseConfig);
const db      = getFirestore(fireApp);
const REF            = doc(db, 'famille', 'main');
const ROLE_REACT_REF = doc(db, 'bot', 'roleReact');

// ── SALONS ────────────────────────────────────────
const LOGS_TABLETTE_ID     = '1488697548225908956'; // Journal depuis la tablette
const LOGS_DISCORD_ID      = '1486169152459772005'; // Journal depuis le bot Discord
const WELCOME_CHANNEL_ID   = '1488695814242045962'; // Salon d'arrivée des membres
const REGLEMENT_CHANNEL_ID = '1486169077855813752'; // Salon règlement
const TICKET_CHANNEL_ID    = '1488697077645971607'; // Salon tickets
const ANNONCES_CHANNEL_ID  = '1488696390933680139'; // Salon annonces
const NEWS_CHANNEL_ID      = '1488696763337674852'; // Salon news / nouveautés
const TICKET_CATEGORY_ID   = '1488703536739909722'; // Catégorie où créer les salons de ticket
const RECRUTEMENT_STAFF_ID = '1488710114687979660'; // Salon staff pour examiner les candidatures
const BLACKLIST_ROLE_ID    = '1486188383960039538'; // Rôle blacklist
const TICKET_LOG_CHANNEL_ID= '1488714560243499018'; // Salon logs fermeture tickets

// ── RÔLES ─────────────────────────────────────────
const AGENT_ROLE_ID = '1488693237794209946'; // Rôle Agent

// ── SUIVI TICKETS INACTIFS ────────────────────────
const warnedTickets = new Set();

// ── STORE CANDIDATURES (en mémoire) ──────────────
const candidatures = {};
const AVIS_CHANNEL_ID = '1488696917084082187'; // Salon où poster les avis clients

// ── ROLE REACT CONFIG (mémoire + persisté Firestore) ──
// Map<messageId, Array<{ emoji: string, roleId: string }>>
const roleReactConfig = new Map();

// ── TICKET TRANSCRIPTS (mémoire temporaire) ───────
// Map<transcriptKey, { text: string, channelName: string }>
const ticketTranscripts = new Map();

// ── NOTATION AGENTS (mémoire temporaire) ──────────
// Map<ratingKey, { agentName: string, channelName: string }>
const agentRatingStore = new Map();

// ── OPTIONS TICKETS ───────────────────────────────
const TICKET_OPTIONS = [
  { label: '❓ Question',       value: 'question',    emoji: '❓', description: 'J\'ai une question à vous poser.' },
  { label: '💰 Achat',          value: 'achat',       emoji: '💰', description: 'J\'ai un achat à faire.' },
  { label: '📅 Rendez-vous',    value: 'rdv',         emoji: '📅', description: 'Je souhaite prendre un rendez-vous.' },
  { label: '📩 Recrutement',    value: 'recrutement', emoji: '📩', description: 'Je souhaite vous transmettre mon CV.' },
  { label: '🔑 Problème',       value: 'probleme',    emoji: '🔑', description: 'J\'ai besoin de vous pour régler un souci.' },
  { label: '🚫 Annuler',        value: 'annuler',     emoji: '🚫', description: 'J\'ai changé d\'avis.' },
];

// ── MESSAGES D'ACCUEIL (rotation aléatoire) ──────
const WELCOME_MESSAGES = [
  m => ({ msg: `Bienvenue <@${m.id}> dans l'Agence ! 🏠 N'hésite pas à consulter le règlement et à créer un ticket si tu as une demande.` }),
  m => ({ msg: `🎉 <@${m.id}> vient de rejoindre le serveur ! On est ravis de t'accueillir, bonne aventure parmi nous.` }),
  m => ({ msg: `🌟 Hey <@${m.id}>, tu as fait le bon choix ! Les portes de l'Agence Immobilière te sont grandes ouvertes.` }),
  m => ({ msg: `🤝 <@${m.id}> débarque sur le serveur ! Le café est chaud et l'équipe est prête — bienvenue !` }),
  m => ({ msg: `✨ Tout le monde applaudit pour <@${m.id}> qui nous rejoint aujourd'hui. Bienvenue à l'Agence !` }),
  m => ({ msg: `🏡 <@${m.id}> a poussé la porte de l'Agence Immobilière. Nous sommes heureux de te compter parmi nous !` }),
];

// ── JOURNAL LISTENER (temps réel) ─────────────────
const knownJournalIds = new Set();

// ── HELPERS ───────────────────────────────────────

function isPatron(interaction) {
  if (process.env.PATRON_ROLE_ID) {
    return interaction.member.roles.cache.has(process.env.PATRON_ROLE_ID);
  }
  return interaction.member.roles.cache.some(r => r.name === 'Patron');
}

// Agent OU Patron → accès aux commandes Agent
function isAgent(interaction) {
  return interaction.member.roles.cache.has(AGENT_ROLE_ID) || isPatron(interaction);
}

// Normalise un emoji (unicode ou custom) en clé de stockage
function normalizeEmoji(emojiStr) {
  const match = emojiStr.match(/<a?:[\w]+:(\d+)>/);
  if (match) return match[1]; // ID du custom emoji
  return emojiStr.trim();     // Emoji unicode brut
}

// Récupère TOUS les messages d'un salon (pagination)
async function fetchAllMessages(channel) {
  const messages = [];
  let lastId = null;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (!batch.size) break;
    messages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Construit le texte du transcript
function buildTranscript(channel, messages, closedByName) {
  const sep = '═'.repeat(55);
  const lines = [
    sep,
    `  TRANSCRIPT — #${channel.name}`,
    `  Fermé par   : ${closedByName}`,
    `  Date        : ${new Date().toLocaleString('fr-FR')}`,
    `  Messages    : ${messages.length}`,
    sep,
    '',
  ];
  for (const msg of messages) {
    const ts = new Date(msg.createdTimestamp).toLocaleString('fr-FR');
    const author = msg.author?.tag || 'Inconnu';
    if (msg.embeds.length && !msg.content) {
      const e = msg.embeds[0];
      const title = e.title || '';
      const desc  = e.description ? e.description.replace(/\n/g, ' ') : '';
      lines.push(`[${ts}] ${author} [EMBED]: ${title}${desc ? ' — ' + desc : ''}`);
    } else {
      const content = msg.content || (msg.embeds.length ? '[Embed]' : '[Aucun contenu]');
      const pj = msg.attachments.size ? ` [${msg.attachments.size} PJ]` : '';
      lines.push(`[${ts}] ${author}: ${content}${pj}`);
    }
  }
  lines.push('', sep, `  Fin du transcript — Agence Immobilière`, sep);
  return lines.join('\n');
}

// Sauvegarde roleReactConfig dans Firestore
async function saveRoleReactConfig() {
  const configs = {};
  for (const [msgId, pairs] of roleReactConfig) {
    configs[msgId] = pairs;
  }
  try {
    await setDoc(ROLE_REACT_REF, { configs });
  } catch (e) {
    console.error('Erreur sauvegarde role-react:', e.message);
  }
}

// Recherche un message dans tous les salons texte du serveur
async function findMessageInGuild(guild, messageId) {
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased()) continue;
    try {
      const msg = await channel.messages.fetch(messageId);
      if (msg) return msg;
    } catch { /* salon sans accès ou message inexistant */ }
  }
  return null;
}

// ── COMMANDES ─────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Liste des commandes disponibles'),
  new SlashCommandBuilder().setName('membres').setDescription('Liste les membres et leur statut'),
  new SlashCommandBuilder().setName('tablette').setDescription('🔒 [Agent] Lien d\'accès à la tablette'),
  new SlashCommandBuilder().setName('dossier').setDescription('🔒 [Agent] Lien d\'accès au dossier RP'),
  new SlashCommandBuilder().setName('creer-compte').setDescription('👑 [Patron] Crée un compte membre'),
  new SlashCommandBuilder()
    .setName('supprimer-compte')
    .setDescription('👑 [Patron] Supprime un compte membre')
    .addStringOption(o => o.setName('email').setDescription('Email (pseudo@famille.rp)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clean')
    .setDescription('👑 [Patron] Supprime les derniers messages du salon')
    .addIntegerOption(o => o.setName('nombre').setDescription('Nombre (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('up')
    .setDescription('👑 [Patron] Passe un membre au statut Actif')
    .addStringOption(o => o.setName('membre').setDescription('Nom du membre (tel qu\'il apparaît dans la tablette)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('down')
    .setDescription('👑 [Patron] Passe un membre au statut Absent')
    .addStringOption(o => o.setName('membre').setDescription('Nom du membre (tel qu\'il apparaît dans la tablette)').setRequired(true)),
  new SlashCommandBuilder().setName('reglement').setDescription('👑 [Patron] Envoie le règlement dans le salon dédié'),
  new SlashCommandBuilder().setName('annonce').setDescription('👑 [Patron] Créer une annonce dans le salon dédié'),
  new SlashCommandBuilder().setName('news').setDescription('👑 [Patron] Publier une nouveauté pour les clients'),
  new SlashCommandBuilder().setName('ticket-setup').setDescription('👑 [Patron] Poste le panneau de création de tickets dans ce salon'),
  new SlashCommandBuilder().setName('avis').setDescription('Laisser un avis sur l\'Agence Immobilière'),
  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('👑 [Patron] Gérer la blacklist')
    .addSubcommand(s => s.setName('add').setDescription('Ajouter un membre à la blacklist')
      .addUserOption(o => o.setName('membre').setDescription('Membre à blacklister').setRequired(true))
      .addStringOption(o => o.setName('raison').setDescription('Raison de la blacklist').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Retirer un membre de la blacklist')
      .addUserOption(o => o.setName('membre').setDescription('Membre à retirer').setRequired(true)))
    .addSubcommand(s => s.setName('liste').setDescription('Afficher la blacklist')),
  new SlashCommandBuilder()
    .setName('role-react')
    .setDescription('👑 [Patron] Configurer les rôles par réaction sur un message')
    .addSubcommand(s => s
      .setName('ajouter')
      .setDescription('Associer une réaction emoji → rôle sur un message')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message Discord').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji de réaction (ex: 👍 ou custom emoji)').setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('Rôle à attribuer/retirer automatiquement').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('supprimer')
      .setDescription('Retirer une config role-react (un emoji ou tout le message)')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji à retirer (laisser vide = tout supprimer pour ce message)').setRequired(false))
    )
    .addSubcommand(s => s
      .setName('liste')
      .setDescription('Afficher tous les role-react configurés')
    ),
];

// ── REGISTER ──────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('✅ Commandes enregistrées');
})();

// ── CLIENT ────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ── READY : chargement données + listener journal ─
client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  startAutoCloseInterval();

  // Charger les IDs existants du journal pour ne pas les reposter au démarrage
  try {
    const snap = await getDoc(REF);
    const initData = snap.data();
    if (initData?.journal) {
      initData.journal.forEach(e => knownJournalIds.add(e.id));
    }
    console.log(`📓 ${knownJournalIds.size} entrées journal chargées`);
  } catch (err) {
    console.error('Erreur chargement journal initial :', err.message);
  }

  // Charger les configs role-react depuis Firestore
  try {
    const snap = await getDoc(ROLE_REACT_REF);
    if (snap.exists()) {
      const data = snap.data();
      if (data?.configs) {
        for (const [msgId, pairs] of Object.entries(data.configs)) {
          roleReactConfig.set(msgId, pairs);
        }
        console.log(`🎭 ${roleReactConfig.size} config(s) role-react chargée(s)`);
      }
    }
  } catch (err) {
    console.error('Erreur chargement role-react :', err.message);
  }

  // Écoute en temps réel : nouvelles entrées journal → salon de logs
  onSnapshot(REF, async (docSnap) => {
    const data = docSnap.data();
    if (!data?.journal) return;

    const newEntries = data.journal
      .filter(e => !knownJournalIds.has(e.id))
      .sort((a, b) => a.ts - b.ts);

    if (!newEntries.length) return;

    for (const entry of newEntries) {
      knownJournalIds.add(entry.id);

      const isDiscordEntry = entry.auteur === 'Bot Discord';
      const channelId = isDiscordEntry ? LOGS_DISCORD_ID : LOGS_TABLETTE_ID;

      let logChannel;
      try {
        logChannel = await client.channels.fetch(channelId);
      } catch {
        console.warn(`⚠️ Impossible de récupérer le salon de logs : ${channelId}`);
        continue;
      }
      if (!logChannel) continue;

      await logChannel.send({ embeds: [{
        title: `📓 ${entry.titre}`,
        color: isDiscordEntry ? 0x5bb8d4 : 0x4caf50,
        description: entry.contenu || '*Aucun contenu*',
        fields: [
          ...(entry.tags?.length ? [{ name: '🏷 Tags', value: entry.tags.join(', '), inline: true }] : []),
          ...(entry.auteur     ? [{ name: '✍️ Auteur', value: entry.auteur, inline: true }] : []),
        ],
        timestamp: new Date(entry.ts).toISOString(),
        footer: { text: isDiscordEntry ? 'Log Discord · Agence' : 'Log Tablette · Agence' }
      }]});
    }
  });
});

// ── ARRIVÉE D'UN MEMBRE ───────────────────────────
client.on('guildMemberAdd', async member => {
  const channel = client.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!channel) return;

  const pick = WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)](member);

  await channel.send({ embeds: [{
    description: pick.msg,
    color: 0x5bb8d4,
    thumbnail: { url: member.user.displayAvatarURL({ dynamic: true }) },
    footer: { text: `Membre #${member.guild.memberCount} · Agence Immobilière` },
    timestamp: new Date().toISOString(),
  }]});
});

// ════════════════════════════════════════════════
// ROLE REACT — RÉACTION AJOUTÉE
// ════════════════════════════════════════════════
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (user.partial) {
    try { await user.fetch(); } catch { return; }
  }

  const configs = roleReactConfig.get(reaction.message.id);
  if (!configs || !configs.length) return;

  const emojiKey = reaction.emoji.id || reaction.emoji.name;
  const pair = configs.find(p => p.emoji === emojiKey);
  if (!pair) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  try {
    const member = await guild.members.fetch(user.id);
    await member.roles.add(pair.roleId);
    console.log(`✅ Role-react: ${user.tag} → rôle ${pair.roleId} ajouté`);
  } catch (e) {
    console.error('Erreur role-react add :', e.message);
  }
});

// ════════════════════════════════════════════════
// ROLE REACT — RÉACTION RETIRÉE
// ════════════════════════════════════════════════
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }
  if (user.partial) {
    try { await user.fetch(); } catch { return; }
  }

  const configs = roleReactConfig.get(reaction.message.id);
  if (!configs || !configs.length) return;

  const emojiKey = reaction.emoji.id || reaction.emoji.name;
  const pair = configs.find(p => p.emoji === emojiKey);
  if (!pair) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  try {
    const member = await guild.members.fetch(user.id);
    await member.roles.remove(pair.roleId);
    console.log(`✅ Role-react: ${user.tag} → rôle ${pair.roleId} retiré`);
  } catch (e) {
    console.error('Erreur role-react remove :', e.message);
  }
});

// ── FERMETURE DE TICKET ───────────────────────────
async function closeTicketChannel(channel, closedByName = 'Automatique') {
  try {
    // Récupérer l'ID de l'ouvreur depuis le topic
    const topicMatch = channel.topic ? channel.topic.match(/opener:(\d+)/) : null;
    const openerId   = topicMatch ? topicMatch[1] : null;

    // Durée du ticket
    const duration = Date.now() - channel.createdTimestamp;
    const hours    = Math.floor(duration / 3600000);
    const minutes  = Math.floor((duration % 3600000) / 60000);

    // Trouver l'agent ayant pris en charge
    let claimedBy = 'Non pris en charge';
    try {
      const msgs = await channel.messages.fetch({ limit: 50 });
      const claimMsg = msgs.find(m => m.author.bot && m.embeds[0]?.fields?.some(f => f.name === '🙋 Agent assigné'));
      if (claimMsg) {
        const field = claimMsg.embeds[0].fields.find(f => f.name === '🙋 Agent assigné');
        if (field) claimedBy = field.value.replace(/\*\*/g, '');
      }
    } catch { /* ignore */ }

    // ── GÉNÉRATION DU TRANSCRIPT (avant suppression du salon) ──
    let transcriptText = null;
    let transcriptKey  = null;
    try {
      const allMsgs = await fetchAllMessages(channel);
      transcriptText = buildTranscript(channel, allMsgs, closedByName);
      if (transcriptText) {
        // Clé unique partagée entre le log staff ET le DM client
        transcriptKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        ticketTranscripts.set(transcriptKey, { text: transcriptText, channelName: channel.name });
      }
    } catch (e) {
      console.error('Erreur génération transcript :', e.message);
    }

    // Bouton réutilisé dans le log ET dans le DM
    const transcriptComponents = transcriptKey ? [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket-transcript_${transcriptKey}`)
          .setLabel('📄 Voir les messages')
          .setStyle(ButtonStyle.Secondary)
      )
    ] : [];

    // ── LOG CHANNEL ────────────────────────────
    try {
      const logCh = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
      if (logCh) {
        await logCh.send({
          embeds: [{
            title: `🔒 Ticket fermé — ${channel.name}`,
            color: 0xf44336,
            fields: [
              { name: '📁 Salon',              value: `\`${channel.name}\``,                    inline: true },
              { name: '⏱ Durée',              value: `${hours}h ${minutes}min`,                inline: true },
              { name: '🔒 Fermé par',          value: closedByName,                             inline: true },
              { name: '👤 Ouvert par',         value: openerId ? `<@${openerId}>` : 'Inconnu', inline: true },
              { name: '🙋 Pris en charge par', value: claimedBy,                               inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Agence Immobilière · Logs tickets' },
          }],
          components: transcriptComponents,
        });
      }
    } catch (e) { console.error('Erreur log ticket :', e.message); }

    // ── DM À L'OUVREUR ────────────────────────
    if (openerId) {
      try {
        const opener = await client.users.fetch(openerId);
        await opener.send({
          embeds: [{
            title: '📬 Votre ticket a été clôturé — Agence Immobilière',
            color: 0x5bb8d4,
            description:
              `Votre demande **${channel.name}** a bien été traitée et le ticket est maintenant fermé.\n\n` +
              `Merci d'avoir contacté l'Agence Immobilière ! ⭐`,
            fields: [
              { name: '⏱ Durée',  value: `${hours}h ${minutes}min`, inline: true },
              { name: '🙋 Agent', value: claimedBy,                  inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Agence Immobilière · Système de tickets' },
          }],
          components: transcriptComponents, // ← même bouton que dans le log staff
        });

        // ── DM DE NOTATION AGENT ──────────────────
        // Envoyé uniquement si un agent a pris en charge le ticket
        if (claimedBy !== 'Non pris en charge') {
          const ratingKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          agentRatingStore.set(ratingKey, { agentName: claimedBy, channelName: channel.name });

          const ratingButtons = new ActionRowBuilder().addComponents(
            [1, 2, 3, 4, 5].map(n =>
              new ButtonBuilder()
                .setCustomId(`agent-rate_${n}_${ratingKey}`)
                .setLabel(`${n}`)
                .setEmoji('⭐')
                .setStyle(n <= 2 ? ButtonStyle.Danger : n === 3 ? ButtonStyle.Secondary : ButtonStyle.Success)
            )
          );

          await opener.send({
            embeds: [{
              title: '⭐ Évaluez votre expérience',
              color: 0xf4c542,
              description:
                `Comment s'est passé votre échange avec **${claimedBy}** ?\n\n` +
                `Cliquez sur une note de **1 à 5 étoiles** — votre avis aide l'équipe à s'améliorer !`,
              fields: [
                { name: '🎫 Ticket', value: `\`${channel.name}\``, inline: true },
                { name: '🙋 Agent', value: claimedBy,              inline: true },
              ],
              footer: { text: 'Agence Immobilière · Évaluation · Une seule note possible' },
              timestamp: new Date().toISOString(),
            }],
            components: [ratingButtons],
          });
        }

      } catch { /* DMs fermés */ }
    }

    warnedTickets.delete(channel.id);
    setTimeout(() => channel.delete().catch(() => {}), 4000);

  } catch (err) {
    console.error('Erreur closeTicketChannel :', err.message);
  }
}

// ── AUTO-CLOSE : vérification toutes les 30 min ──
function startAutoCloseInterval() {
  setInterval(async () => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;

    const ticketChannels = guild.channels.cache.filter(
      c => c.parentId === TICKET_CATEGORY_ID && c.type === ChannelType.GuildText
    );

    const now = Date.now();
    const WARN_MS  = 23 * 60 * 60 * 1000;
    const CLOSE_MS = 24 * 60 * 60 * 1000;

    for (const [, ch] of ticketChannels) {
      try {
        const msgs = await ch.messages.fetch({ limit: 1 });
        const lastMsg = msgs.first();
        const lastTs  = lastMsg ? lastMsg.createdTimestamp : ch.createdTimestamp;
        const inactivity = now - lastTs;

        if (inactivity >= CLOSE_MS) {
          await ch.send({ embeds: [{
            description: '⏰ Ce ticket a été **fermé automatiquement** après 24 heures d\'inactivité.',
            color: 0xf44336,
          }]});
          await closeTicketChannel(ch, 'Auto (inactivité 24h)');

        } else if (inactivity >= WARN_MS && !warnedTickets.has(ch.id)) {
          warnedTickets.add(ch.id);
          await ch.send({ embeds: [{
            description: '⚠️ Aucune activité depuis **23 heures**. Ce ticket sera fermé automatiquement dans 1 heure si aucun message n\'est envoyé.',
            color: 0xf4c542,
          }]});
        }
      } catch { /* ignore */ }
    }
  }, 30 * 60 * 1000); // toutes les 30 minutes
}

// ════════════════════════════════════════════════
// SLASH COMMANDS
// ════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {

  if (interaction.isChatInputCommand()) {

    // ── HELP ───────────────────────────────────────
    if (interaction.commandName === 'help') {
      const select = new StringSelectMenuBuilder()
        .setCustomId('help-menu')
        .setPlaceholder('Choisir une catégorie...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('📊 Général').setValue('general').setDescription('Membres, avis'),
          new StringSelectMenuOptionBuilder().setLabel('🔗 Liens').setValue('liens').setDescription('Tablette et dossier RP (Agents)'),
          new StringSelectMenuOptionBuilder().setLabel('👑 Patron').setValue('patron').setDescription('Commandes réservées aux Patrons'),
        );

      await interaction.reply({
        embeds: [{
          title: '📋 Aide — Choisir une catégorie',
          color: 0x5bb8d4,
          description: 'Sélectionne une catégorie ci-dessous pour voir les commandes disponibles.',
          footer: { text: 'Tablette de gestion · Agence Immobilière' }
        }],
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true
      });
    }

    // ── MEMBRES ────────────────────────────────────
    if (interaction.commandName === 'membres') {
      const data   = (await getDoc(REF)).data();
      const lignes = data.membres.map(m => {
        const e = m.statut === 'actif' ? '🟢' : m.statut === 'absent' ? '🔴' : '⚪';
        return `${e} **${m.nom}** — ${m.role} · ${m.parts}`;
      }).join('\n');
      await interaction.reply({ embeds: [{ title: '👥 Membres', color: 0x5bb8d4, description: lignes, footer: { text: 'Tablette de gestion · Agence Immobilière' } }]});
    }

    // ── TABLETTE — AGENT ONLY ──────────────────────
    if (interaction.commandName === 'tablette') {
      if (!isAgent(interaction)) {
        await interaction.reply({ content: '❌ Cette commande est réservée aux **Agents** et **Patrons**.', ephemeral: true });
        return;
      }
      await interaction.reply({ embeds: [{
        title: '📱 Tablette de gestion', color: 0x5bb8d4,
        description: '[**Accéder à la tablette →**](https://comfy-snickerdoodle-dd1ffa.netlify.app/gate.html)',
        footer: { text: 'Tablette de gestion · Agence Immobilière' }
      }], ephemeral: true });
    }

    // ── DOSSIER — AGENT ONLY ───────────────────────
    if (interaction.commandName === 'dossier') {
      if (!isAgent(interaction)) {
        await interaction.reply({ content: '❌ Cette commande est réservée aux **Agents** et **Patrons**.', ephemeral: true });
        return;
      }
      await interaction.reply({ embeds: [{
        title: '📂 Dossier RP', color: 0x5bb8d4,
        description: '[**Accéder au dossier →**](https://polite-seahorse-5e93cb.netlify.app)',
        footer: { text: 'Tablette de gestion · Agence Immobilière' }
      }], ephemeral: true });
    }

    // ── CREER COMPTE (modal) — PATRON ONLY ────────
    if (interaction.commandName === 'creer-compte') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const modal = new ModalBuilder().setCustomId('modal-creer-compte').setTitle('👑 Créer un compte membre');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pseudo').setLabel('Pseudo du membre').setPlaceholder('Ex : MasonKnox').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motdepasse').setLabel('Mot de passe').setPlaceholder('Min. 6 caractères').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_id').setLabel('ID Discord du membre').setPlaceholder('Ex : 123456789012345678').setStyle(TextInputStyle.Short).setRequired(true)),
      );
      await interaction.showModal(modal);
    }

    // ── SUPPRIMER COMPTE — PATRON ONLY ────────────
    if (interaction.commandName === 'supprimer-compte') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const email = interaction.options.getString('email').trim();
      try {
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().deleteUser(user.uid);
        await interaction.reply({ embeds: [{ title: '🗑 Compte supprimé', color: 0xf44336, description: `Le compte **${email}** a été supprimé.`, footer: { text: 'Tablette de gestion · Agence Immobilière' } }], ephemeral: true });
      } catch(e) {
        await interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
      }
    }

    // ── CLEAN — PATRON ONLY ───────────────────────
    if (interaction.commandName === 'clean') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const nombre = interaction.options.getInteger('nombre');
      try {
        await interaction.deferReply({ ephemeral: true });
        const deleted = await interaction.channel.bulkDelete(nombre, true);
        await interaction.editReply({ content: `✅ **${deleted.size}** message(s) supprimé(s).` });
      } catch(e) {
        await interaction.editReply({ content: `❌ Erreur : ${e.message}` });
      }
    }

    // ── UP — PATRON ONLY ──────────────────────────
    if (interaction.commandName === 'up') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const nomRecherche = interaction.options.getString('membre').trim().toLowerCase();
      try {
        const snap = await getDoc(REF);
        const data = snap.data();
        const idx = data.membres.findIndex(m => m.nom.toLowerCase().includes(nomRecherche));
        if (idx === -1) {
          await interaction.reply({ content: `❌ Aucun membre trouvé avec le nom **${nomRecherche}**.`, ephemeral: true });
          return;
        }
        if (data.membres[idx].role === 'Patron') {
          await interaction.reply({ content: `⚠️ **${data.membres[idx].nom}** est déjà Patron.`, ephemeral: true });
          return;
        }
        data.membres[idx].role = 'Patron';
        await setDoc(REF, data);
        await interaction.reply({ embeds: [{
          title: '👑 Promotion effectuée',
          color: 0xf4c542,
          fields: [
            { name: 'Membre', value: data.membres[idx].nom, inline: true },
            { name: 'Avant',  value: 'Membre',              inline: true },
            { name: 'Après',  value: 'Patron 👑',           inline: true },
          ],
          footer: { text: 'Tablette de gestion · Agence Immobilière' }
        }]});
      } catch(e) {
        await interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
      }
    }

    // ── DOWN — PATRON ONLY ────────────────────────
    if (interaction.commandName === 'down') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const nomRecherche = interaction.options.getString('membre').trim().toLowerCase();
      try {
        const snap = await getDoc(REF);
        const data = snap.data();
        const idx = data.membres.findIndex(m => m.nom.toLowerCase().includes(nomRecherche));
        if (idx === -1) {
          await interaction.reply({ content: `❌ Aucun membre trouvé avec le nom **${nomRecherche}**.`, ephemeral: true });
          return;
        }
        if (data.membres[idx].role === 'Membre') {
          await interaction.reply({ content: `⚠️ **${data.membres[idx].nom}** est déjà Membre.`, ephemeral: true });
          return;
        }
        data.membres[idx].role = 'Membre';
        await setDoc(REF, data);
        await interaction.reply({ embeds: [{
          title: '🔽 Rétrogradation effectuée',
          color: 0x5bb8d4,
          fields: [
            { name: 'Membre', value: data.membres[idx].nom, inline: true },
            { name: 'Avant',  value: 'Patron',              inline: true },
            { name: 'Après',  value: 'Membre 🔽',           inline: true },
          ],
          footer: { text: 'Tablette de gestion · Agence Immobilière' }
        }]});
      } catch(e) {
        await interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
      }
    }

    // ── REGLEMENT — PATRON ONLY ───────────────────
    if (interaction.commandName === 'reglement') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const channel = client.channels.cache.get(REGLEMENT_CHANNEL_ID);
      if (!channel) { await interaction.reply({ content: '❌ Salon règlement introuvable.', ephemeral: true }); return; }
      await channel.send({ embeds: [{
        title: '📋 Règlement — Agence Immobilière',
        color: 0x5bb8d4,
        description:
          `1️⃣ **Respect** : aucun propos raciste, sexiste, homophobe ou irrespectueux ne sera accepté.\n\n` +
          `2️⃣ **Pas d'auto-promo** sans accord d'un Staff (même en DM).\n\n` +
          `3️⃣ Veuillez utiliser <#${TICKET_CHANNEL_ID}> pour créer un ticket et faire votre demande.\n\n` +
          `4️⃣ Il est interdit de DM ou de ping un membre du Staff.\n\n` +
          `5️⃣ Rendez-vous dans le général HRP pour des discussions HRP et général RP pour des discussions RP.\n\n` +
          `6️⃣ **Consultez les messages épinglés** de chaque salon, on y apprend plein de trucs.\n\n` +
          `7️⃣ **Favorisez les formes de politesse**, le respect de chacun, et évitez le langage SMS et d'écrire EN MAJUSCULES.\n\n` +
          `8️⃣ Toutes formes de publicités, Spam/Flood, contenus illégaux et pornographiques sont formellement interdites.\n\n` +
          `9️⃣ Tout manquement à ces règles entrainera automatiquement la radiation de votre compte discord du serveur Agence Immobilière | Wise FA.\n\n` +
          `🔟 Les clauses du [règlement Wise](https://wise-fa.gitbook.io/wisefa/reglement-wisefa/reglement-hrp/reglement-discord) ne bénéficient pas d'exemption.`,
        footer: { text: 'Agence Immobilière · Wise FA' },
        timestamp: new Date().toISOString(),
      }]});
      await interaction.reply({ content: '✅ Règlement publié dans le salon dédié.', ephemeral: true });
    }

    // ── ANNONCE — PATRON ONLY (modal) ─────────────
    if (interaction.commandName === 'annonce') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const modal = new ModalBuilder().setCustomId('modal-annonce').setTitle('📢 Nouvelle annonce');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('titre').setLabel('Titre de l\'annonce').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : Fermeture exceptionnelle')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('contenu').setLabel('Contenu').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Rédigez votre annonce ici...')
        ),
      );
      await interaction.showModal(modal);
    }

    // ── BLACKLIST ──────────────────────────────────
    if (interaction.commandName === 'blacklist') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const sub = interaction.options.getSubcommand();

      if (sub === 'add') {
        const cible  = interaction.options.getUser('membre');
        const raison = interaction.options.getString('raison');
        const member = await interaction.guild.members.fetch(cible.id).catch(() => null);
        const snap = await getDoc(REF);
        const data = snap.data();
        data.blacklist = data.blacklist || [];
        if (data.blacklist.find(b => b.userId === cible.id)) {
          await interaction.reply({ content: `⚠️ **${cible.displayName}** est déjà blacklisté.`, ephemeral: true });
          return;
        }
        data.blacklist.push({ userId: cible.id, pseudo: cible.username, raison, date: Date.now(), addedBy: interaction.user.username });
        await setDoc(REF, data);
        if (member) await member.roles.add(BLACKLIST_ROLE_ID).catch(() => {});
        await interaction.reply({ embeds: [{
          title: '🚫 Membre blacklisté', color: 0xf44336,
          fields: [
            { name: '👤 Membre',  value: `<@${cible.id}>`,            inline: true },
            { name: '📋 Raison', value: raison,                       inline: true },
            { name: '👑 Par',    value: interaction.user.displayName, inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Agence Immobilière · Blacklist' },
        }]});
      }

      if (sub === 'remove') {
        const cible  = interaction.options.getUser('membre');
        const member = await interaction.guild.members.fetch(cible.id).catch(() => null);
        const snap = await getDoc(REF);
        const data = snap.data();
        data.blacklist = data.blacklist || [];
        const before = data.blacklist.length;
        data.blacklist = data.blacklist.filter(b => b.userId !== cible.id);
        if (data.blacklist.length === before) {
          await interaction.reply({ content: `⚠️ **${cible.username}** n'est pas dans la blacklist.`, ephemeral: true });
          return;
        }
        await setDoc(REF, data);
        if (member) await member.roles.remove(BLACKLIST_ROLE_ID).catch(() => {});
        await interaction.reply({ embeds: [{
          title: '✅ Membre retiré de la blacklist', color: 0x4caf50,
          description: `<@${cible.id}> a été retiré de la blacklist.`,
          footer: { text: 'Agence Immobilière · Blacklist' },
        }]});
      }

      if (sub === 'liste') {
        const snap = await getDoc(REF);
        const data = snap.data();
        const bl   = data.blacklist || [];
        if (!bl.length) {
          await interaction.reply({ embeds: [{ title: '🚫 Blacklist', color: 0x5bb8d4, description: 'Aucun membre blacklisté.', footer: { text: 'Agence Immobilière · Blacklist' } }], ephemeral: true });
          return;
        }
        const lignes = bl.map((b, i) => {
          const dateStr = new Date(b.date).toLocaleDateString('fr-FR');
          return `**${i+1}.** <@${b.userId}> — ${b.raison}\n> Ajouté par ${b.addedBy} le ${dateStr}`;
        }).join('\n\n');
        await interaction.reply({ embeds: [{
          title: `🚫 Blacklist — ${bl.length} membre(s)`, color: 0xf44336,
          description: lignes,
          footer: { text: 'Agence Immobilière · Blacklist' },
        }], ephemeral: true });
      }
    }

    // ── AVIS ───────────────────────────────────────
    if (interaction.commandName === 'avis') {
      const modal = new ModalBuilder().setCustomId('modal-avis').setTitle('⭐ Laisser un avis');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('note').setLabel('Note globale (1 à 5 étoiles)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : 5').setMinLength(1).setMaxLength(1)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('avis').setLabel('Votre avis').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Décrivez votre expérience avec l\'Agence Immobilière...').setMaxLength(1000)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('agent').setLabel('Nom de l\'agent (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Ex : Jonathan Wise')
        ),
      );
      await interaction.showModal(modal);
    }

    // ── TICKET-SETUP — PATRON ONLY ────────────────
    if (interaction.commandName === 'ticket-setup') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }

      const select = new StringSelectMenuBuilder()
        .setCustomId('ticket-select')
        .setPlaceholder('Sélectionne une raison de contact...')
        .addOptions(TICKET_OPTIONS.map(o =>
          new StringSelectMenuOptionBuilder()
            .setLabel(o.label)
            .setValue(o.value)
            .setDescription(o.description)
        ));

      await interaction.channel.send({
        embeds: [{
          title: '🎫 Créer un ticket',
          color: 0x5bb8d4,
          description:
            'Bienvenue ! Pour contacter l\'équipe de l\'Agence Immobilière, sélectionne la raison de ta demande dans le menu ci-dessous.\n\n' +
            'Un salon privé sera automatiquement créé entre toi et notre équipe.\n\n' +
            '> ⚠️ **Avertissement** : Tout abus du système de tickets (spam, fausses demandes, trolling) entraînera des sanctions immédiates pouvant aller jusqu\'à l\'exclusion du serveur.',
          footer: { text: 'Agence Immobilière · Système de tickets' },
        }],
        components: [new ActionRowBuilder().addComponents(select)],
      });

      await interaction.reply({ content: '✅ Panneau de tickets posté.', ephemeral: true });
    }

    // ── NEWS — PATRON ONLY (modal + image) ────────
    if (interaction.commandName === 'news') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const modal = new ModalBuilder().setCustomId('modal-news').setTitle('🌟 Nouvelle actualité');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('titre').setLabel('Titre').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : Nouveau bien disponible !')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('contenu').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Décrivez la nouveauté...')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('image').setLabel('URL de l\'image').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('https://i.imgur.com/...')
        ),
      );
      await interaction.showModal(modal);
    }

    // ════════════════════════════════════════════════
    // ROLE REACT — PATRON ONLY
    // ════════════════════════════════════════════════
    if (interaction.commandName === 'role-react') {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      const sub = interaction.options.getSubcommand();

      // ── AJOUTER ────────────────────────────────────
      if (sub === 'ajouter') {
        const messageId = interaction.options.getString('message_id').trim();
        const emojiRaw  = interaction.options.getString('emoji').trim();
        const role      = interaction.options.getRole('role');

        const emojiKey = normalizeEmoji(emojiRaw);

        // Chercher le message dans le serveur et y ajouter la réaction du bot
        await interaction.deferReply({ ephemeral: true });

        const targetMsg = await findMessageInGuild(interaction.guild, messageId);
        if (!targetMsg) {
          await interaction.editReply({ content: `❌ Message introuvable. Vérifie l'ID \`${messageId}\` et assure-toi que j'ai accès au salon.` });
          return;
        }

        // Ajouter ou mettre à jour la config
        const existing = roleReactConfig.get(messageId) || [];
        const alreadyExists = existing.find(p => p.emoji === emojiKey && p.roleId === role.id);
        if (alreadyExists) {
          await interaction.editReply({ content: `⚠️ Cette combinaison emoji + rôle est déjà configurée sur ce message.` });
          return;
        }

        existing.push({ emoji: emojiKey, roleId: role.id });
        roleReactConfig.set(messageId, existing);
        await saveRoleReactConfig();

        // Réagir au message avec l'emoji (pour que les users puissent cliquer)
        try {
          await targetMsg.react(emojiRaw);
        } catch (e) {
          console.warn('Impossible de réagir au message :', e.message);
        }

        await interaction.editReply({ embeds: [{
          title: '✅ Role-react configuré',
          color: 0x4caf50,
          fields: [
            { name: '📝 Message',  value: `[Voir le message](${targetMsg.url})`,      inline: true },
            { name: '😀 Emoji',    value: emojiRaw,                                   inline: true },
            { name: '🎭 Rôle',    value: `<@&${role.id}>`,                            inline: true },
          ],
          description: 'Les membres qui réagissent avec cet emoji recevront automatiquement le rôle. Retirer la réaction le supprime.',
          footer: { text: 'Agence Immobilière · Role React' },
          timestamp: new Date().toISOString(),
        }]});
      }

      // ── SUPPRIMER ─────────────────────────────────
      if (sub === 'supprimer') {
        const messageId = interaction.options.getString('message_id').trim();
        const emojiRaw  = interaction.options.getString('emoji')?.trim();

        if (!roleReactConfig.has(messageId)) {
          await interaction.reply({ content: `❌ Aucun role-react configuré pour le message \`${messageId}\`.`, ephemeral: true });
          return;
        }

        if (emojiRaw) {
          // Supprimer uniquement la paire avec cet emoji
          const emojiKey = normalizeEmoji(emojiRaw);
          const pairs = roleReactConfig.get(messageId).filter(p => p.emoji !== emojiKey);
          if (pairs.length === 0) {
            roleReactConfig.delete(messageId);
          } else {
            roleReactConfig.set(messageId, pairs);
          }
          await saveRoleReactConfig();
          await interaction.reply({ content: `✅ La réaction **${emojiRaw}** a été retirée de la config du message \`${messageId}\`.`, ephemeral: true });
        } else {
          // Supprimer tout le message
          roleReactConfig.delete(messageId);
          await saveRoleReactConfig();
          await interaction.reply({ content: `✅ Toutes les configs role-react du message \`${messageId}\` ont été supprimées.`, ephemeral: true });
        }
      }

      // ── LISTE ──────────────────────────────────────
      if (sub === 'liste') {
        if (!roleReactConfig.size) {
          await interaction.reply({ embeds: [{
            title: '🎭 Role React — Aucune config',
            color: 0x5bb8d4,
            description: 'Aucun role-react configuré pour le moment.\nUtilise `/role-react ajouter` pour en créer un.',
            footer: { text: 'Agence Immobilière · Role React' },
          }], ephemeral: true });
          return;
        }

        const lines = [];
        for (const [msgId, pairs] of roleReactConfig) {
          lines.push(`**Message ID :** \`${msgId}\``);
          for (const p of pairs) {
            lines.push(`  └ ${p.emoji} → <@&${p.roleId}>`);
          }
        }

        await interaction.reply({ embeds: [{
          title: `🎭 Role React — ${roleReactConfig.size} message(s) configuré(s)`,
          color: 0x5bb8d4,
          description: lines.join('\n'),
          footer: { text: 'Agence Immobilière · Role React' },
          timestamp: new Date().toISOString(),
        }], ephemeral: true });
      }
    }
  }

  // ════════════════════════════════════════════════
  // SELECT MENU — HELP
  // ════════════════════════════════════════════════
  if (interaction.isStringSelectMenu() && interaction.customId === 'help-menu') {
    const val = interaction.values[0];
    const embeds = {
      general: {
        title: '📊 Commandes générales', color: 0x5bb8d4,
        fields: [
          { name: '👥 /membres', value: 'Liste des membres et leur statut.', inline: false },
          { name: '⭐ /avis',    value: 'Laisser un avis sur l\'Agence Immobilière.', inline: false },
        ]
      },
      liens: {
        title: '🔒 Liens — Accès Agent', color: 0x5bb8d4,
        fields: [
          { name: '📱 /tablette', value: 'Lien d\'accès à la tablette de gestion. *(Agents & Patrons)*', inline: false },
          { name: '📂 /dossier',  value: 'Lien d\'accès au dossier RP. *(Agents & Patrons)*', inline: false },
        ]
      },
      patron: {
        title: '👑 Commandes Patron', color: 0xf4c542,
        fields: [
          { name: '👑 /creer-compte',     value: 'Crée un compte membre et envoie les identifiants en DM.', inline: false },
          { name: '👑 /supprimer-compte', value: 'Supprime le compte d\'un membre.', inline: false },
          { name: '👑 /clean',            value: 'Supprime les X derniers messages du salon.', inline: false },
          { name: '🟢 /up [membre]',      value: 'Passe un membre au statut Actif sur la tablette.', inline: false },
          { name: '🔴 /down [membre]',    value: 'Passe un membre au statut Absent sur la tablette.', inline: false },
          { name: '📋 /reglement',        value: 'Envoie le règlement dans le salon dédié.', inline: false },
          { name: '📢 /annonce',          value: 'Crée une annonce dans le salon dédié (via formulaire).', inline: false },
          { name: '🌟 /news',             value: 'Publie une nouveauté avec image (via formulaire).', inline: false },
          { name: '🎫 /ticket-setup',     value: 'Poste le panneau de création de tickets dans le salon actuel.', inline: false },
          { name: '🎭 /role-react',       value: 'Configurer des rôles attribués automatiquement via les réactions.\n`ajouter` · `supprimer` · `liste`', inline: false },
          { name: '🚫 /blacklist',        value: 'Gérer la blacklist du serveur. `add` · `remove` · `liste`', inline: false },
        ]
      },
    };
    await interaction.update({
      embeds: [{ ...embeds[val], footer: { text: 'Tablette de gestion · Agence Immobilière' } }],
      components: interaction.message.components
    });
  }

  // ════════════════════════════════════════════════
  // SELECT MENU — RECRUTEMENT (permis)
  // ════════════════════════════════════════════════
  if (interaction.isStringSelectMenu() && interaction.customId === 'recruit-permis') {
    const d = candidatures[interaction.user.id];
    if (!d) { await interaction.reply({ content: '❌ Session expirée, recommence la candidature.', ephemeral: true }); return; }
    d.permis = interaction.values[0] === 'oui' ? '✅ Oui' : '❌ Non';

    const staffChannel = interaction.guild.channels.cache.get(RECRUTEMENT_STAFF_ID);
    if (!staffChannel) { await interaction.reply({ content: '❌ Salon staff introuvable.', ephemeral: true }); return; }

    const acceptBtn = new ButtonBuilder().setCustomId(`recruit-accept_${interaction.user.id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success);
    const refuseBtn = new ButtonBuilder().setCustomId(`recruit-refuse_${interaction.user.id}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger);

    await staffChannel.send({
      embeds: [{
        title: '📩 Nouvelle candidature — Agence Immobilière',
        color: 0xf4c542,
        thumbnail: { url: interaction.user.displayAvatarURL({ dynamic: true }) },
        fields: [
          { name: '👤 Pseudo Discord',      value: d.pseudo,       inline: true  },
          { name: '🆔 ID Unique',           value: d.id,           inline: true  },
          { name: '🎂 Âge HRP',             value: d.age,          inline: true  },
          { name: '📅 Disponibilités',      value: d.dispo,        inline: false },
          { name: '💗 Identité RP',         value: d.identite,     inline: true  },
          { name: '🎂 Date de naissance',   value: d.naissance,    inline: true  },
          { name: '📱 Téléphone RP',        value: d.tel,          inline: true  },
          { name: '🌍 Nationalité',         value: d.nationalite,  inline: true  },
          { name: '💼 Profession actuelle', value: d.metier,       inline: true  },
          { name: '🚗 Permis de conduire',  value: d.permis,       inline: true  },
          { name: '✍️ Motivation',          value: d.motivation,   inline: false },
          { name: '⭐ Pourquoi ce candidat',value: d.pourquoi,     inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Candidat · ${interaction.user.tag}` },
      }],
      components: [new ActionRowBuilder().addComponents(acceptBtn, refuseBtn)],
    });

    await interaction.reply({
      embeds: [{
        title: '✅ Candidature envoyée',
        color: 0x4caf50,
        description: 'Votre candidature a bien été transmise à notre équipe.\nNous reviendrons vers vous dans les meilleurs délais. Merci pour votre intérêt envers l\'Agence Immobilière !',
        footer: { text: 'Agence Immobilière · Recrutement' },
      }],
      ephemeral: true,
    });
  }

  // ════════════════════════════════════════════════
  // SELECT MENU — TICKET
  // ════════════════════════════════════════════════
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket-select') {
    const val    = interaction.values[0];
    const option = TICKET_OPTIONS.find(o => o.value === val);

    if (val === 'annuler') {
      await interaction.reply({ content: 'Pas de souci, tu peux revenir quand tu veux ! 👋', ephemeral: true });
      return;
    }

    if (val === 'rdv') {
      const modal = new ModalBuilder().setCustomId('modal-rdv').setTitle('📅 Prise de rendez-vous');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ig').setLabel('🎮 Numéro IG (obligatoire)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : 1234')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('identite').setLabel('💗 Prénom & Nom RP').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : Jonathan Wise')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('📆 Date souhaitée').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : Samedi 05/04')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('heure').setLabel('🕐 Heure souhaitée').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex : 19h00 – 21h00')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('infos').setLabel('📝 Informations complémentaires').setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('Type de bien, budget, questions...')),
      );
      await interaction.showModal(modal);
      return;
    }

    if (val === 'recrutement') {
      const modal = new ModalBuilder().setCustomId('recruit-step1').setTitle('📩 Candidature — Étape 1/3');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pseudo').setLabel('👤 Pseudo Discord').setStyle(TextInputStyle.Short).setValue(interaction.user.username).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id').setLabel('🆔 ID Unique (GTA)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('age').setLabel('🎂 Âge HRP').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dispo').setLabel('📅 Disponibilités (jours/horaires)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      await interaction.showModal(modal);
      return;
    }

    const safeName    = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 24);
    const channelName = `${option.emoji}・${safeName}`;

    const category = interaction.guild.channels.cache.get(TICKET_CATEGORY_ID);
    if (category) {
      const existing = interaction.guild.channels.cache.find(
        c => c.parentId === TICKET_CATEGORY_ID && c.permissionOverwrites.cache.has(interaction.user.id)
      );
      if (existing) {
        await interaction.reply({
          content: `❌ Tu as déjà un ticket ouvert : <#${existing.id}>. Merci de le clore avant d'en ouvrir un nouveau.`,
          ephemeral: true
        });
        return;
      }
    }

    try {
      const permOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (process.env.PATRON_ROLE_ID) {
        permOverwrites.push({ id: process.env.PATRON_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles] });
      }

      const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        topic: `opener:${interaction.user.id}`,
        permissionOverwrites: permOverwrites,
      });

      const ticketButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket-claim').setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ticket-close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );

      await ticketChannel.send({
        content: `<@${interaction.user.id}>`,
        embeds: [{
          title: `${option.emoji} Ticket — ${option.label.replace(/^\S+\s/, '')}`,
          color: 0x5bb8d4,
          description:
            `Bonjour <@${interaction.user.id}>,\n\n` +
            `Votre demande a bien été reçue par l'**Agence Immobilière**.\n\n` +
            `> **Objet :** ${option.description}\n\n` +
            `Un agent de notre équipe prendra en charge votre requête dans les meilleurs délais. En attendant, merci de **détailler votre demande** ci-dessous afin que nous puissions vous apporter la meilleure réponse possible.`,
          fields: [{ name: '📋 Statut', value: '⏳ En attente de prise en charge', inline: true }],
          footer: { text: 'Agence Immobilière · Système de tickets' },
          timestamp: new Date().toISOString(),
        }],
        components: [ticketButtons],
      });

      await interaction.reply({ content: `✅ Ton ticket a été créé : <#${ticketChannel.id}>`, ephemeral: true });

    } catch (err) {
      console.error('Erreur création ticket :', err.message);
      await interaction.reply({ content: `❌ Erreur lors de la création du ticket : ${err.message}`, ephemeral: true });
    }
  }

  // ════════════════════════════════════════════════
  // BOUTONS
  // ════════════════════════════════════════════════
  if (interaction.isButton()) {

    // ── TRANSCRIPT — VOIR LES MESSAGES D'UN TICKET ─
    if (interaction.customId.startsWith('ticket-transcript_')) {
      const key = interaction.customId.replace('ticket-transcript_', '');
      const data = ticketTranscripts.get(key);

      if (!data) {
        await interaction.reply({
          content: '⚠️ Le transcript n\'est plus disponible (le bot a redémarré depuis la fermeture du ticket).',
          ephemeral: true,
        });
        return;
      }

      const buffer = Buffer.from(data.text, 'utf-8');
      await interaction.reply({
        content: `📄 Transcript du ticket **${data.channelName}**`,
        files: [{ attachment: buffer, name: `transcript-${data.channelName}.txt` }],
        ephemeral: true,
      });
      return;
    }

    // ── NOTATION AGENT ────────────────────────────
    if (interaction.customId.startsWith('agent-rate_')) {
      const parts  = interaction.customId.split('_');  // ['agent-rate', '3', 'abc123']
      const stars  = parseInt(parts[1]);
      const key    = parts[2];

      const data = agentRatingStore.get(key);
      if (!data) {
        await interaction.reply({ content: '⚠️ Cette évaluation a déjà été soumise ou a expiré.', ephemeral: true });
        return;
      }

      // Anti double-vote : supprimer immédiatement
      agentRatingStore.delete(key);

      // Désactiver les boutons sur le message DM (highlight la note choisie)
      const disabledRow = new ActionRowBuilder().addComponents(
        [1, 2, 3, 4, 5].map(n =>
          new ButtonBuilder()
            .setCustomId(`agent-rated_${n}`)
            .setLabel(`${n}`)
            .setEmoji('⭐')
            .setStyle(n === stars ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );
      await interaction.message.edit({ components: [disabledRow] }).catch(() => {});

      // Poster dans le salon avis
      const etoiles  = '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
      const couleurs = [0xf44336, 0xff9800, 0xffc107, 0x8bc34a, 0x4caf50];
      const avisChannel = client.channels.cache.get(AVIS_CHANNEL_ID);
      if (avisChannel) {
        await avisChannel.send({ embeds: [{
          title: `${etoiles} — Évaluation agent`,
          color: couleurs[stars - 1],
          description: stars >= 4
            ? `*Excellente note ! L'agent a fait du bon travail.* 🎉`
            : stars === 3
            ? `*Note correcte. Toujours de la marge pour progresser !*`
            : `*Note faible. Pensez à en discuter en interne.*`,
          fields: [
            { name: '⭐ Note',    value: `**${stars}/5** — ${etoiles}`,         inline: true  },
            { name: '🙋 Agent',   value: data.agentName,                         inline: true  },
            { name: '👤 Client',  value: `<@${interaction.user.id}>`,           inline: true  },
            { name: '🎫 Ticket', value: `\`${data.channelName}\``,              inline: true  },
          ],
          thumbnail: { url: interaction.user.displayAvatarURL({ dynamic: true }) },
          timestamp: new Date().toISOString(),
          footer: { text: 'Agence Immobilière · Évaluations agents' },
        }]});
      }

      await interaction.reply({
        content: `✅ Merci pour votre note **${stars}/5** ! Votre retour a bien été enregistré.`,
        ephemeral: true,
      });
      return;
    }

    // ── RECRUTEMENT : ÉTAPE 2 (bouton → modal) ────
    if (interaction.customId === 'recruit-step2-btn') {
      const modal = new ModalBuilder().setCustomId('recruit-step2').setTitle('📩 Candidature — Étape 2/3');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('identite').setLabel('💗 Prénom & Nom RP').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('naissance').setLabel('🎂 Date de naissance RP').setStyle(TextInputStyle.Short).setPlaceholder('JJ/MM/AAAA').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('tel').setLabel('📱 Téléphone RP').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nationalite').setLabel('🌍 Nationalité RP').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('metier').setLabel('💼 Profession actuelle RP').setStyle(TextInputStyle.Short).setRequired(true)),
      );
      await interaction.showModal(modal);
    }

    // ── RECRUTEMENT : ÉTAPE 3 (bouton → modal) ────
    if (interaction.customId === 'recruit-step3-btn') {
      const modal = new ModalBuilder().setCustomId('recruit-step3').setTitle('📩 Candidature — Étape 3/3');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivation').setLabel('✍️ Pourquoi rejoindre l\'Agence ?').setStyle(TextInputStyle.Paragraph).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pourquoi').setLabel('⭐ Qu\'est-ce qui vous distingue ?').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      );
      await interaction.showModal(modal);
    }

    // ── RECRUTEMENT : ACCEPTER ─────────────────────
    if (interaction.customId.startsWith('recruit-accept_')) {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      await interaction.deferReply({ ephemeral: true });

      const userId = interaction.customId.split('_')[1];
      const data   = candidatures[userId];

      const safeName = (data?.identite || 'candidat').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 24);
      const permOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (process.env.PATRON_ROLE_ID) {
        permOverwrites.push({ id: process.env.PATRON_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
      }

      try {
        const ticketChannel = await interaction.guild.channels.create({
          name: `📩・${safeName}`,
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID,
          permissionOverwrites: permOverwrites,
        });

        const closeBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket-close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({
          content: `<@${userId}>`,
          embeds: [{
            title: '✅ Candidature acceptée — Agence Immobilière',
            color: 0x4caf50,
            description:
              `Bonjour <@${userId}>,\n\n` +
              `Nous avons le plaisir de vous informer que votre candidature a été **acceptée** par notre équipe.\n\n` +
              `Merci de nous transmettre les documents suivants pour finaliser votre dossier :\n\n` +
              `🪪 **Carte d'identité RP**\n` +
              `🚗 **Permis de conduire RP** (si applicable)\n` +
              `📅 **Vos disponibilités in-game** pour un entretien`,
            footer: { text: 'Agence Immobilière · Recrutement' },
            timestamp: new Date().toISOString(),
          }],
          components: [closeBtn],
        });

        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('recruit-accept_x').setLabel('Accepté ✅').setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId('recruit-refuse_x').setLabel('Refuser').setStyle(ButtonStyle.Danger).setDisabled(true),
        );
        await interaction.message.edit({ components: [disabledRow] });
        await interaction.editReply({ content: `✅ Candidature acceptée. Ticket créé : <#${ticketChannel.id}>` });
        delete candidatures[userId];

      } catch (err) {
        await interaction.editReply({ content: `❌ Erreur : ${err.message}` });
      }
    }

    // ── RECRUTEMENT : REFUSER ──────────────────────
    if (interaction.customId.startsWith('recruit-refuse_')) {
      if (!isPatron(interaction)) { await interaction.reply({ content: '❌ Réservé aux Patrons.', ephemeral: true }); return; }
      await interaction.deferReply({ ephemeral: true });

      const userId = interaction.customId.split('_')[1];
      try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [{
          title: '❌ Candidature — Agence Immobilière',
          color: 0xf44336,
          description:
            `Bonjour,\n\nNous avons bien examiné votre candidature et nous sommes au regret de vous informer qu'elle n'a pas été retenue à ce stade.\n\n` +
            `Nous vous remercions pour l'intérêt que vous portez à l'Agence Immobilière et vous souhaitons bonne chance dans vos recherches.`,
          footer: { text: 'Agence Immobilière · Recrutement' },
        }]});
      } catch { /* DMs fermés */ }

      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('recruit-accept_x').setLabel('Accepter').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('recruit-refuse_x').setLabel('Refusé ❌').setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await interaction.message.edit({ components: [disabledRow] });
      await interaction.editReply({ content: '❌ Candidature refusée. Un DM a été envoyé au candidat.' });
      delete candidatures[userId];
    }

    // ── PRENDRE EN CHARGE ─────────────────────────
    if (interaction.customId === 'ticket-claim') {
      if (!isPatron(interaction)) {
        await interaction.reply({ content: '❌ Seuls les membres du Staff peuvent prendre en charge un ticket.', ephemeral: true });
        return;
      }

      const originalEmbed = interaction.message.embeds[0];
      const fields = originalEmbed.fields
        .filter(f => f.name !== '📋 Statut')
        .concat([
          { name: '📋 Statut',        value: '✅ Pris en charge',                   inline: true },
          { name: '🙋 Agent assigné', value: `**${interaction.user.displayName}**`, inline: true },
        ]);

      const updatedEmbed = { ...originalEmbed.data, color: 0x4caf50, fields };

      const updatedButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket-claim').setLabel('Pris en charge').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('ticket-close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      );

      await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedButtons] });
      await interaction.reply({ content: `🙋 **${interaction.user.displayName}** a pris en charge ce ticket.` });
    }

    // ── FERMER LE TICKET ──────────────────────────
    if (interaction.customId === 'ticket-close') {
      const disabledButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket-claim').setLabel('Pris en charge').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('ticket-close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await interaction.message.edit({ components: [disabledButtons] }).catch(() => {});

      await interaction.reply({ embeds: [{
        description: `🔒 Ticket fermé par **${interaction.user.displayName}**. Suppression dans quelques secondes...`,
        color: 0xf44336,
      }]});

      await closeTicketChannel(interaction.channel, interaction.user.displayName);
    }
  }

  // ════════════════════════════════════════════════
  // MODAL SUBMITS
  // ════════════════════════════════════════════════
  if (interaction.isModalSubmit()) {

    // ── MODAL RDV ─────────────────────────────────
    if (interaction.customId === 'modal-rdv') {
      const ig       = interaction.fields.getTextInputValue('ig').trim();
      const identite = interaction.fields.getTextInputValue('identite').trim();
      const date     = interaction.fields.getTextInputValue('date').trim();
      const heure    = interaction.fields.getTextInputValue('heure').trim();
      const infos    = interaction.fields.getTextInputValue('infos').trim();

      await interaction.deferReply({ ephemeral: true });

      const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 24);
      const permOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ];
      if (process.env.PATRON_ROLE_ID) {
        permOverwrites.push({ id: process.env.PATRON_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] });
      }

      try {
        const ticketChannel = await interaction.guild.channels.create({
          name: `📅・${safeName}`,
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID,
          topic: `opener:${interaction.user.id}`,
          permissionOverwrites,
        });

        const ticketButtons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket-claim').setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('ticket-close').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        );

        await ticketChannel.send({
          content: `<@${interaction.user.id}>`,
          embeds: [{
            title: '📅 Demande de rendez-vous',
            color: 0x5bb8d4,
            description: `Bonjour <@${interaction.user.id}>, votre demande de rendez-vous a bien été reçue.\nUn agent de l'Agence Immobilière vous contactera dans les meilleurs délais.`,
            fields: [
              { name: '🎮 Numéro IG',    value: `**${ig}**`, inline: true  },
              { name: '💗 Identité RP',  value: identite,     inline: true  },
              { name: '📆 Date',         value: date,         inline: true  },
              { name: '🕐 Heure',        value: heure,        inline: true  },
              ...(infos ? [{ name: '📝 Informations complémentaires', value: infos, inline: false }] : []),
              { name: '📋 Statut', value: '⏳ En attente de prise en charge', inline: true },
            ],
            thumbnail: { url: interaction.user.displayAvatarURL({ dynamic: true }) },
            timestamp: new Date().toISOString(),
            footer: { text: 'Agence Immobilière · Système de tickets' },
          }],
          components: [ticketButtons],
        });

        await interaction.editReply({ content: `✅ Votre demande de rendez-vous a été enregistrée : <#${ticketChannel.id}>` });
      } catch (err) {
        await interaction.editReply({ content: `❌ Erreur : ${err.message}` });
      }
    }

    // ── MODAL RECRUIT ÉTAPE 1 ─────────────────────
    if (interaction.customId === 'recruit-step1') {
      candidatures[interaction.user.id] = {
        pseudo: interaction.fields.getTextInputValue('pseudo'),
        id:     interaction.fields.getTextInputValue('id'),
        age:    interaction.fields.getTextInputValue('age'),
        dispo:  interaction.fields.getTextInputValue('dispo'),
      };
      const d = candidatures[interaction.user.id];
      await interaction.reply({
        embeds: [{
          title: '📋 Récapitulatif — Étape 1/3',
          color: 0x5bb8d4,
          fields: [
            { name: '👤 Pseudo Discord', value: d.pseudo, inline: true },
            { name: '🆔 ID Unique',      value: d.id,     inline: true },
            { name: '🎂 Âge HRP',        value: d.age,    inline: true },
            { name: '📅 Disponibilités', value: d.dispo,  inline: false },
          ],
          footer: { text: 'Agence Immobilière · Recrutement — Étape 1/3' },
        }],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('recruit-step2-btn').setLabel('Étape suivante →').setEmoji('📝').setStyle(ButtonStyle.Primary)
        )],
        ephemeral: true,
      });
    }

    // ── MODAL RECRUIT ÉTAPE 2 ─────────────────────
    if (interaction.customId === 'recruit-step2') {
      const d = candidatures[interaction.user.id] || {};
      d.identite    = interaction.fields.getTextInputValue('identite');
      d.naissance   = interaction.fields.getTextInputValue('naissance');
      d.tel         = interaction.fields.getTextInputValue('tel');
      d.nationalite = interaction.fields.getTextInputValue('nationalite');
      d.metier      = interaction.fields.getTextInputValue('metier');
      candidatures[interaction.user.id] = d;
      await interaction.reply({
        embeds: [{
          title: '📋 Récapitulatif — Étape 2/3',
          color: 0x5bb8d4,
          fields: [
            { name: '💗 Identité RP',        value: d.identite,    inline: true },
            { name: '🎂 Date de naissance',   value: d.naissance,   inline: true },
            { name: '📱 Téléphone RP',        value: d.tel,         inline: true },
            { name: '🌍 Nationalité',         value: d.nationalite, inline: true },
            { name: '💼 Profession actuelle', value: d.metier,      inline: true },
          ],
          footer: { text: 'Agence Immobilière · Recrutement — Étape 2/3' },
        }],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('recruit-step3-btn').setLabel('Étape finale →').setEmoji('⭐').setStyle(ButtonStyle.Primary)
        )],
        ephemeral: true,
      });
    }

    // ── MODAL RECRUIT ÉTAPE 3 ─────────────────────
    if (interaction.customId === 'recruit-step3') {
      const d = candidatures[interaction.user.id] || {};
      d.motivation = interaction.fields.getTextInputValue('motivation');
      d.pourquoi   = interaction.fields.getTextInputValue('pourquoi');
      candidatures[interaction.user.id] = d;

      const permisMenu = new StringSelectMenuBuilder()
        .setCustomId('recruit-permis')
        .setPlaceholder('Avez-vous le permis de conduire RP ?')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('✅ Oui, j\'ai le permis').setValue('oui'),
          new StringSelectMenuOptionBuilder().setLabel('❌ Non, je n\'ai pas le permis').setValue('non'),
        );

      await interaction.reply({
        content: '🚗 **Dernière question** — Êtes-vous titulaire du permis de conduire RP ?',
        components: [new ActionRowBuilder().addComponents(permisMenu)],
        ephemeral: true,
      });
    }

    // ── MODAL AVIS ────────────────────────────────
    if (interaction.customId === 'modal-avis') {
      const noteRaw = interaction.fields.getTextInputValue('note').trim();
      const avis    = interaction.fields.getTextInputValue('avis').trim();
      const agent   = interaction.fields.getTextInputValue('agent').trim();

      const note = parseInt(noteRaw);
      if (isNaN(note) || note < 1 || note > 5) {
        await interaction.reply({ content: '❌ La note doit être un chiffre entre **1** et **5**.', ephemeral: true });
        return;
      }

      const etoiles  = '⭐'.repeat(note) + '☆'.repeat(5 - note);
      const couleurs = [0xf44336, 0xff9800, 0xffc107, 0x8bc34a, 0x4caf50];
      const couleur  = couleurs[note - 1];

      const channel = client.channels.cache.get(AVIS_CHANNEL_ID);
      if (!channel) { await interaction.reply({ content: '❌ Salon des avis introuvable.', ephemeral: true }); return; }

      // ── Sauvegarde dans Firebase + calcul note globale ──
      let noteGlobale = note;
      let nbAvis = 1;
      try {
        const snap = await getDoc(REF);
        const data = snap.exists() ? snap.data() : {};
        const avisArray = Array.isArray(data.avis) ? [...data.avis] : [];
        avisArray.push({
          id:     Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          ts:     Date.now(),
          note,
          texte:  avis,
          agent:  agent || null,
          auteur: interaction.user.username,
        });
        nbAvis      = avisArray.length;
        noteGlobale = Math.round((avisArray.reduce((s, a) => s + a.note, 0) / nbAvis) * 10) / 10;
        await setDoc(REF, { ...data, avis: avisArray, meta: { ...(data.meta || {}), updated: Date.now() } });
      } catch (fbErr) {
        console.error('Erreur Firebase avis:', fbErr);
      }

      const noteGlobaleEtoiles = '⭐'.repeat(Math.round(noteGlobale)) + '☆'.repeat(5 - Math.round(noteGlobale));

      await channel.send({ embeds: [{
        title: `${etoiles} — Avis client`,
        color: couleur,
        description: `*"${avis}"*`,
        fields: [
          { name: '⭐ Note',          value: `**${note}/5**`,                                          inline: true },
          { name: '👤 Client',        value: `<@${interaction.user.id}>`,                             inline: true },
          ...(agent ? [{ name: '🤝 Agent', value: agent, inline: true }] : []),
          { name: '📊 Note globale', value: `**${noteGlobale}/5** ${noteGlobaleEtoiles} *(${nbAvis} avis)*`, inline: false },
        ],
        thumbnail: { url: interaction.user.displayAvatarURL({ dynamic: true }) },
        timestamp: new Date().toISOString(),
        footer: { text: 'Agence Immobilière · Avis clients' },
      }]});

      await interaction.reply({ content: '✅ Merci pour ton avis ! Il a bien été publié.', ephemeral: true });
    }

    // ── MODAL CREER COMPTE ─────────────────────────
    if (interaction.customId === 'modal-creer-compte') {
      const pseudo    = interaction.fields.getTextInputValue('pseudo').trim();
      const mdp       = interaction.fields.getTextInputValue('motdepasse').trim();
      const discordId = interaction.fields.getTextInputValue('discord_id').trim();
      const email     = `${pseudo.toLowerCase().replace(/\s+/g,'.')}@famille.rp`;

      try {
        await admin.auth().createUser({ email, password: mdp, displayName: pseudo });

        try {
          const membre = await client.users.fetch(discordId);
          await membre.send({ embeds: [{
            title: '🔐 Tes identifiants Tablette', color: 0x5bb8d4,
            description: 'Voici tes accès à la Tablette de gestion. Garde-les précieusement.',
            fields: [
              { name: '📧 Email',        value: `\`${email}\``, inline: true },
              { name: '🔑 Mot de passe', value: `\`${mdp}\``,   inline: true },
            ],
            footer: { text: 'Ne partage pas ces informations' }
          }]});
        } catch(dmErr) {
          console.log(`DM impossible pour ${discordId} — DMs probablement fermés.`);
        }

        await interaction.reply({ embeds: [{
          title: '✅ Compte créé', color: 0x4caf50,
          fields: [
            { name: 'Pseudo', value: pseudo, inline: true },
            { name: 'Email',  value: email,  inline: true },
          ],
          description: `Les identifiants ont été envoyés en DM à <@${discordId}>.`,
          footer: { text: 'Tablette de gestion · Agence Immobilière' }
        }], ephemeral: true });

      } catch(e) {
        await interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
      }
    }

    // ── MODAL ANNONCE ──────────────────────────────
    if (interaction.customId === 'modal-annonce') {
      const titre   = interaction.fields.getTextInputValue('titre').trim();
      const contenu = interaction.fields.getTextInputValue('contenu').trim();

      const channel = client.channels.cache.get(ANNONCES_CHANNEL_ID);
      if (!channel) { await interaction.reply({ content: '❌ Salon annonces introuvable.', ephemeral: true }); return; }

      await channel.send({ embeds: [{
        title: `📢 ${titre}`,
        color: 0x5bb8d4,
        description: contenu,
        timestamp: new Date().toISOString(),
        footer: { text: `Annonce · ${interaction.user.displayName} · Agence Immobilière` },
      }]});

      await interaction.reply({ content: '✅ Annonce publiée dans le salon dédié.', ephemeral: true });
    }

    // ── MODAL NEWS ─────────────────────────────────
    if (interaction.customId === 'modal-news') {
      const titre   = interaction.fields.getTextInputValue('titre').trim();
      const contenu = interaction.fields.getTextInputValue('contenu').trim();
      const image   = interaction.fields.getTextInputValue('image').trim();

      const channel = client.channels.cache.get(NEWS_CHANNEL_ID);
      if (!channel) { await interaction.reply({ content: '❌ Salon news introuvable.', ephemeral: true }); return; }

      await channel.send({ embeds: [{
        title: `🌟 ${titre}`,
        color: 0xf4c542,
        description: contenu,
        image: { url: image },
        timestamp: new Date().toISOString(),
        footer: { text: `Nouveauté · ${interaction.user.displayName} · Agence Immobilière` },
      }]});

      await interaction.reply({ content: '✅ Nouveauté publiée dans le salon dédié.', ephemeral: true });
    }
  }

});

client.login(process.env.TOKEN);
