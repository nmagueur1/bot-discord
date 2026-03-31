require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
        ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
        StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
const admin = require('firebase-admin');

// Parse le JSON depuis l'env
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

console.log('Firebase initialisé ✅');

// ── FIREBASE ADMIN ────────────────────────────────
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

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

  // ── NOUVELLES COMMANDES ───────────────────────────
  new SlashCommandBuilder()
    .setName('up')
    .setDescription('👑 [Patron] Passe un membre au statut Actif')
    .addStringOption(o => o.setName('membre').setDescription('Nom du membre (tel qu\'il apparaît dans la tablette)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('down')
    .setDescription('👑 [Patron] Passe un membre au statut Absent')
    .addStringOption(o => o.setName('membre').setDescription('Nom du membre (tel qu\'il apparaît dans la tablette)').setRequired(true)),
];

// ── REGISTER ──────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
(async () => {
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log('✅ Commandes enregistrées');
})();

// ── CLIENT ────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once('ready', () => console.log(`✅ Bot connecté : ${client.user.tag}`));

client.on('interactionCreate', async interaction => {

  // ════════════════════════════════════════════════
  // SLASH COMMANDS
  // ════════════════════════════════════════════════
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
          footer: { text: 'Tablette de gestion · Famille' }
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
        footer: { text: 'Tablette de gestion · Famille' }
      }]});
    }

    // ── MEMBRES ────────────────────────────────────
    if (interaction.commandName === 'membres') {
      const data   = (await getDoc(REF)).data();
      const lignes = data.membres.map(m => {
        const e = m.statut === 'actif' ? '🟢' : m.statut === 'absent' ? '🔴' : '⚪';
        return `${e} **${m.nom}** — ${m.role} · ${m.parts}`;
      }).join('\n');
      await interaction.reply({ embeds: [{ title: '👥 Membres', color: 0x5bb8d4, description: lignes, footer: { text: 'Tablette de gestion · Famille' } }]});
    }

    // ── MISSIONS ───────────────────────────────────
    if (interaction.commandName === 'missions') {
      const data    = (await getDoc(REF)).data();
      const actives = data.missions.filter(m => !m.done);
      if (!actives.length) { await interaction.reply('Aucune mission active.'); return; }
      const lignes  = actives.map(m => `▸ **${m.titre}** — ${m.phase}`).join('\n');
      await interaction.reply({ embeds: [{ title: '🎯 Missions actives', color: 0x5bb8d4, description: lignes, footer: { text: 'Tablette de gestion · Famille' } }]});
    }

    // ── JOURNAL ────────────────────────────────────
    if (interaction.commandName === 'journal') {
      const data   = (await getDoc(REF)).data();
      const recent = [...data.journal].sort((a,b) => b.ts - a.ts).slice(0,5);
      if (!recent.length) { await interaction.reply('Aucune entrée.'); return; }
      const lignes = recent.map(e => `▸ **${e.titre}**\n${e.contenu}`).join('\n\n');
      await interaction.reply({ embeds: [{ title: '📓 Journal — 5 dernières entrées', color: 0x5bb8d4, description: lignes, footer: { text: 'Tablette de gestion · Famille' } }]});
    }

    // ── TABLETTE ───────────────────────────────────
    if (interaction.commandName === 'tablette') {
      await interaction.reply({ embeds: [{
        title: '📱 Tablette de gestion', color: 0x5bb8d4,
        description: '[**Accéder à la tablette →**](https://comfy-snickerdoodle-dd1ffa.netlify.app/gate.html)',
        footer: { text: 'Tablette de gestion · Famille' }
      }]});
    }

    // ── DOSSIER ────────────────────────────────────
    if (interaction.commandName === 'dossier') {
      await interaction.reply({ embeds: [{
        title: '📂 Dossier RP', color: 0x5bb8d4,
        description: '[**Accéder au dossier →**](https://polite-seahorse-5e93cb.netlify.app)',
        footer: { text: 'Tablette de gestion · Famille' }
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
        await interaction.reply({ embeds: [{ title: '🗑 Compte supprimé', color: 0xf44336, description: `Le compte **${email}** a été supprimé.`, footer: { text: 'Tablette de gestion · Famille' } }], ephemeral: true });
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
          footer: { text: 'Tablette de gestion · Famille' }
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
          footer: { text: 'Tablette de gestion · Famille' }
        }]});
      } catch(e) {
        await interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
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
        ]
      },
    };
    await interaction.update({
      embeds: [{ ...embeds[val], footer: { text: 'Tablette de gestion · Famille' } }],
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
          footer: { text: 'Tablette de gestion · Famille' }
        }], ephemeral: true });

      } catch(e) {
        await interaction.reply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
      }
    }
  }

});

client.login(process.env.TOKEN);