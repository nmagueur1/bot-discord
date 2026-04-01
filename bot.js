require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
        ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
        StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
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
const REF     = doc(db, 'famille', 'main');

// ── SALONS ────────────────────────────────────────
const LOGS_TABLETTE_ID    = '1488697548225908956'; // Journal depuis la tablette
const LOGS_DISCORD_ID     = '1486169152459772005'; // Journal depuis le bot Discord
const WELCOME_CHANNEL_ID  = '1488695814242045962'; // Salon d'arrivée des membres
const REGLEMENT_CHANNEL_ID= '1486169077855813752'; // Salon règlement
const TICKET_CHANNEL_ID   = '1488697077645971607'; // Salon tickets
const ANNONCES_CHANNEL_ID = '1486169061531324620'; // Salon annonces / news

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

// ── HELPER PATRON ─────────────────────────────────
function isPatron(interaction) {
  if (process.env.PATRON_ROLE_ID) {
    return interaction.member.roles.cache.has(process.env.PATRON_ROLE_ID);
  }
  return interaction.member.roles.cache.some(r => r.name === 'Patron');
}

// ── COMMANDES ─────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Liste des commandes disponibles'),
  new SlashCommandBuilder().setName('caisse').setDescription('Affiche la caisse commune'),
  new SlashCommandBuilder().setName('membres').setDescription('Liste les membres et leur statut'),
  new SlashCommandBuilder().setName('missions').setDescription('Liste les missions actives'),
  new SlashCommandBuilder().setName('journal').setDescription('5 dernières entrées du journal'),
  new SlashCommandBuilder().setName('transaction').setDescription('Ajoute une transaction'),
  new SlashCommandBuilder().setName('tablette').setDescription('Lien d\'accès à la tablette'),
  new SlashCommandBuilder().setName('dossier').setDescription('Lien d\'accès au dossier RP'),
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
];

// ── REGISTER ──────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('✅ Commandes enregistrées');
})();

// ── CLIENT ────────────────────────────────────────
// NOTE : GuildMembers est un intent privilégié — il doit être activé
// dans le Discord Developer Portal (Bot → Privileged Gateway Intents)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ]
});

// ── READY : listener journal Firestore ───────────
client.once('ready', async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);

  // Charger les IDs existants pour ne pas les reposter au démarrage
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

  // Écoute en temps réel : nouvelles entrées → salon de logs
  onSnapshot(REF, async (docSnap) => {
    const data = docSnap.data();
    if (!data?.journal) return;

    const newEntries = data.journal
      .filter(e => !knownJournalIds.has(e.id))
      .sort((a, b) => a.ts - b.ts);

    if (!newEntries.length) return;

    for (const entry of newEntries) {
      knownJournalIds.add(entry.id);

      // Choisir le bon salon selon l'origine
      const isDiscordEntry = entry.auteur === 'Bot Discord';
      const channelId = isDiscordEntry ? LOGS_DISCORD_ID : LOGS_TABLETTE_ID;
      const logChannel = client.channels.cache.get(channelId);

      if (!logChannel) {
        console.warn(`⚠️ Salon de logs introuvable : ${channelId}`);
        continue;
      }

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
          new StringSelectMenuOptionBuilder().setLabel('📊 Général').setValue('general').setDescription('Caisse, membres, missions, journal'),
          new StringSelectMenuOptionBuilder().setLabel('💸 Finances').setValue('finances').setDescription('Transactions et caisse'),
          new StringSelectMenuOptionBuilder().setLabel('🔗 Liens').setValue('liens').setDescription('Tablette et dossier RP'),
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

    // ── CAISSE ─────────────────────────────────────
    if (interaction.commandName === 'caisse') {
      const data = (await getDoc(REF)).data();
      const caisse   = new Intl.NumberFormat('fr-FR').format(data.finances.caisse);
      const objectif = new Intl.NumberFormat('fr-FR').format(data.finances.objectif);
      const pct      = data.finances.objectif > 0 ? Math.round((data.finances.caisse / data.finances.objectif) * 100) : 0;
      await interaction.reply({ embeds: [{
        title: '💰 Caisse Commune', color: 0x5bb8d4,
        fields: [
          { name: 'Disponible',  value: `**${caisse} $**`, inline: true },
          { name: 'Objectif',    value: `${objectif} $`,   inline: true },
          { name: 'Progression', value: `${pct}%`,         inline: true },
        ],
        footer: { text: 'Tablette de gestion · Agence Immobilière' }
      }]});
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

    // ── MISSIONS ───────────────────────────────────
    if (interaction.commandName === 'missions') {
      const data    = (await getDoc(REF)).data();
      const actives = data.missions.filter(m => !m.done);
      if (!actives.length) { await interaction.reply('Aucune mission active.'); return; }
      const lignes  = actives.map(m => `▸ **${m.titre}** — ${m.phase}`).join('\n');
      await interaction.reply({ embeds: [{ title: '🎯 Missions actives', color: 0x5bb8d4, description: lignes, footer: { text: 'Tablette de gestion · Agence Immobilière' } }]});
    }

    // ── JOURNAL ────────────────────────────────────
    if (interaction.commandName === 'journal') {
      const data   = (await getDoc(REF)).data();
      const recent = [...data.journal].sort((a,b) => b.ts - a.ts).slice(0,5);
      if (!recent.length) { await interaction.reply('Aucune entrée.'); return; }
      const lignes = recent.map(e => `▸ **${e.titre}**\n${e.contenu}`).join('\n\n');
      await interaction.reply({ embeds: [{ title: '📓 Journal — 5 dernières entrées', color: 0x5bb8d4, description: lignes, footer: { text: 'Tablette de gestion · Agence Immobilière' } }]});
    }

    // ── TABLETTE ───────────────────────────────────
    if (interaction.commandName === 'tablette') {
      await interaction.reply({ embeds: [{
        title: '📱 Tablette de gestion', color: 0x5bb8d4,
        description: '[**Accéder à la tablette →**](https://comfy-snickerdoodle-dd1ffa.netlify.app/gate.html)',
        footer: { text: 'Tablette de gestion · Agence Immobilière' }
      }]});
    }

    // ── DOSSIER ────────────────────────────────────
    if (interaction.commandName === 'dossier') {
      await interaction.reply({ embeds: [{
        title: '📂 Dossier RP', color: 0x5bb8d4,
        description: '[**Accéder au dossier →**](https://polite-seahorse-5e93cb.netlify.app)',
        footer: { text: 'Tablette de gestion · Agence Immobilière' }
      }]});
    }

    // ── TRANSACTION (modal) ────────────────────────
    if (interaction.commandName === 'transaction') {
      const modal = new ModalBuilder().setCustomId('modal-transaction').setTitle('💸 Nouvelle transaction');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('libelle').setLabel('Libellé').setPlaceholder('Ex : Vente appartement Vinewood').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('montant').setLabel('Montant ($)').setPlaceholder('50000').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('type').setLabel('Type : entree ou sortie').setPlaceholder('entree').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note').setLabel('Note (optionnel)').setPlaceholder('Précisions...').setStyle(TextInputStyle.Short).setRequired(false)),
      );
      await interaction.showModal(modal);
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
          { name: '💰 /caisse',  value: 'Caisse commune, objectif et progression.', inline: false },
          { name: '👥 /membres', value: 'Liste des membres et leur statut.', inline: false },
          { name: '🎯 /missions',value: 'Missions actives par phase.', inline: false },
          { name: '📓 /journal', value: '5 dernières entrées du journal.', inline: false },
        ]
      },
      finances: {
        title: '💸 Commandes finances', color: 0x4caf50,
        fields: [
          { name: '💸 /transaction', value: 'Ouvre un formulaire pour ajouter une transaction à la caisse.', inline: false },
        ]
      },
      liens: {
        title: '🔗 Liens', color: 0x5bb8d4,
        fields: [
          { name: '📱 /tablette', value: 'Lien d\'accès à la tablette de gestion.', inline: false },
          { name: '📂 /dossier',  value: 'Lien d\'accès au dossier RP.', inline: false },
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
        ]
      },
    };
    await interaction.update({
      embeds: [{ ...embeds[val], footer: { text: 'Tablette de gestion · Agence Immobilière' } }],
      components: interaction.message.components
    });
  }

  // ════════════════════════════════════════════════
  // MODAL SUBMITS
  // ════════════════════════════════════════════════
  if (interaction.isModalSubmit()) {

    // ── MODAL TRANSACTION ──────────────────────────
    if (interaction.customId === 'modal-transaction') {
      const label   = interaction.fields.getTextInputValue('libelle').trim();
      const montant = parseInt(interaction.fields.getTextInputValue('montant'));
      const type    = interaction.fields.getTextInputValue('type').toLowerCase().trim();
      const note    = interaction.fields.getTextInputValue('note').trim();

      if (isNaN(montant) || montant <= 0) { await interaction.reply({ content: '❌ Montant invalide.', ephemeral: true }); return; }
      if (type !== 'entree' && type !== 'sortie') { await interaction.reply({ content: '❌ Type invalide — écris `entree` ou `sortie`.', ephemeral: true }); return; }

      const snap = await getDoc(REF);
      const data = snap.data();
      data.finances.caisse += type === 'entree' ? montant : -montant;
      data.finances.transactions.push({ id: Date.now().toString(36), label, montant, type, ts: Date.now(), note: note || 'Via Discord' });
      data.journal.push({ id: Date.now().toString(36)+'j', ts: Date.now(), titre: `Transaction : ${label}`, contenu: `${type==='entree'?'Entrée':'Sortie'} de ${new Intl.NumberFormat('fr-FR').format(montant)} $${note?' — '+note:''}`, tags: ['finances'], auteur: 'Bot Discord' });
      await setDoc(REF, data);

      const signe = type === 'entree' ? '+' : '−';
      await interaction.reply({ embeds: [{
        title: `${type==='entree'?'📈':'📉'} Transaction enregistrée`,
        color: type === 'entree' ? 0x4caf50 : 0xf44336,
        fields: [
          { name: 'Libellé', value: label, inline: true },
          { name: 'Montant', value: `${signe}${new Intl.NumberFormat('fr-FR').format(montant)} $`, inline: true },
          ...(note ? [{ name: 'Note', value: note, inline: true }] : []),
        ],
        footer: { text: 'Enregistré dans la tablette en temps réel' }
      }]});
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

      const channel = client.channels.cache.get(ANNONCES_CHANNEL_ID);
      if (!channel) { await interaction.reply({ content: '❌ Salon annonces introuvable.', ephemeral: true }); return; }

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
