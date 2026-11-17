const {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits, EmbedBuilder, MessageFlags,
} = require('discord.js');
const db = require('../db');
const session = require('../session');
const { COMMAND_NAME, MIN_PRESENCE_MS } = require('../config');

const data = new SlashCommandBuilder()
  .setName(COMMAND_NAME)
  .setDescription('Pina Kho-lanta : le conseil du soir')
  .addSubcommand((sc) => sc.setName('profil').setDescription('Stats d\'un joueur')
    .addUserOption((o) => o.setName('joueur').setDescription('Par défaut : toi')))
  .addSubcommand((sc) => sc.setName('classement').setDescription('Classement MVP, boulet ou par catégorie')
    .addStringOption((o) => o.setName('type').setDescription('MVP, Boulet ou une catégorie').setRequired(true).setAutocomplete(true)))
  .addSubcommand((sc) => sc.setName('session').setDescription('Session en cours et temps de présence'))
  .addSubcommandGroup((g) => g.setName('config').setDescription('Réglages (admin)')
    .addSubcommand((sc) => sc.setName('salon-vocal').setDescription('Salon vocal suivi par le bot')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon vocal').setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice)))
    .addSubcommand((sc) => sc.setName('salon-resultats').setDescription('Salon où sont publiés les résultats')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon textuel').setRequired(true)
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sc) => sc.setName('voir').setDescription('Afficher la configuration actuelle')))
  .addSubcommandGroup((g) => g.setName('categorie').setDescription('Catégories de notes (admin)')
    .addSubcommand((sc) => sc.setName('ajouter').setDescription('Ajouter une catégorie')
      .addStringOption((o) => o.setName('nom').setDescription('Nom de la catégorie').setRequired(true).setMaxLength(40)))
    .addSubcommand((sc) => sc.setName('retirer').setDescription('Retirer une catégorie (l\'historique est conservé)')
      .addStringOption((o) => o.setName('nom').setDescription('Nom de la catégorie').setRequired(true).setAutocomplete(true)))
    .addSubcommand((sc) => sc.setName('liste').setDescription('Lister les catégories actives')))
  .addSubcommandGroup((g) => g.setName('admin').setDescription('Gestion des sessions (admin)')
    .addSubcommand((sc) => sc.setName('forcer-fin').setDescription('Terminer la session en cours et lancer le conseil'))
    .addSubcommand((sc) => sc.setName('annuler').setDescription('Annuler la session ou le vote en cours')));

const pct = (n, total) => (total > 0 ? `${Math.round((n / total) * 100)} %` : '-');
const avg = (x) => x.toFixed(2).replace('.', ',');
const reply = (interaction, content) =>
  interaction.reply({ ...(typeof content === 'string' ? { content } : content), flags: MessageFlags.Ephemeral });

// ---------- Joueurs ----------

async function profil(interaction) {
  const user = interaction.options.getUser('joueur') ?? interaction.user;
  const stats = db.getPlayerStats(user.id);
  if (!stats) return reply(interaction, `${user} n'a encore participé à aucun conseil terminé.`);

  const cats = db.getCategoryAverages(user.id);
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`🗿 Profil de ${stats.name}`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Sessions', value: String(stats.sessions), inline: true },
      { name: '🏆 MVP', value: `${stats.mvp} (${pct(stats.mvp, stats.sessions)})`, inline: true },
      { name: '🪨 Boulet', value: `${stats.boulet} (${pct(stats.boulet, stats.sessions)})`, inline: true },
      {
        name: 'Moyennes par catégorie',
        value: cats.length ? cats.map((c) => `**${c.name}** : ${avg(c.avg)}/5 (${c.n} notes)`).join('\n') : 'Aucune note reçue',
      },
    );
  return interaction.reply({ embeds: [embed] });
}

async function classement(interaction) {
  const type = interaction.options.getString('type');
  const key = type.toLowerCase();
  let title;
  let lines;

  if (key === 'mvp' || key === 'boulet') {
    const rows = db.getAllStats()
      .map((s) => ({ ...s, rate: s.sessions ? s[key] / s.sessions : 0 }))
      .sort((a, b) => b.rate - a.rate || b[key] - a[key]);
    title = key === 'mvp' ? '🏆 Classement MVP' : '🪨 Classement des boulets';
    lines = rows.map((r, i) => `**${i + 1}.** ${r.name} : ${pct(r[key], r.sessions)} (${r[key]}/${r.sessions} sessions)`);
  } else {
    const rows = db.getCategoryLeaderboard(type);
    title = `⭐ Classement : ${type}`;
    lines = rows.map((r, i) => `**${i + 1}.** ${r.name} : ${avg(r.avg)}/5 (${r.n} notes)`);
  }

  if (lines.length === 0) return reply(interaction, 'Pas encore de données pour ce classement.');
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(title).setDescription(lines.join('\n'))] });
}

async function sessionStatus(interaction) {
  const open = db.getOpenSession();
  const voting = db.getVotingSessions();
  const parts = [];

  for (const v of voting) parts.push(`🗳️ Conseil de la session #${v.id} en cours, clôture ${session.ts(v.vote_closes_at, 'R')}.`);

  if (!open) {
    parts.push('Aucune session de jeu en cours. Elle démarrera dès que quelqu\'un rejoindra le salon vocal.');
  } else {
    const lines = session.liveParticipants(open.id).map((p) =>
      `${p.ms >= MIN_PRESENCE_MS ? '✅' : '⏳'} <@${p.userId}> : ${session.fmtMinutes(p.ms)}${p.inVoice ? '' : ' (parti)'}`);
    parts.push(`🔥 **Session #${open.id}** démarrée ${session.ts(open.started_at, 'R')}`,
      `Éligibilité : ${session.fmtMinutes(MIN_PRESENCE_MS)} en voc`, ...lines);
  }
  return reply(interaction, parts.join('\n'));
}

// ---------- Admin ----------

async function config(interaction, sub) {
  if (sub === 'salon-vocal') {
    const channel = interaction.options.getChannel('salon');
    db.setSetting('voice_channel_id', channel.id);
    session.resync(interaction.client, interaction.guild);
    return reply(interaction, `✅ Pina Kho-lanta surveille maintenant ${channel}.`);
  }
  if (sub === 'salon-resultats') {
    const channel = interaction.options.getChannel('salon');
    db.setSetting('results_channel_id', channel.id);
    return reply(interaction, `✅ Les résultats seront publiés dans ${channel}.`);
  }
  const voice = db.getSetting('voice_channel_id');
  const results = db.getSetting('results_channel_id');
  return reply(interaction, `Salon vocal : ${voice ? `<#${voice}>` : 'non défini'}\nSalon des résultats : ${results ? `<#${results}>` : 'non défini'}`);
}

async function categorie(interaction, sub) {
  if (sub === 'liste') {
    const cats = db.listActiveCategories();
    return reply(interaction, cats.length ? `Catégories actives : ${cats.map((c) => `**${c.name}**`).join(', ')}` : 'Aucune catégorie active.');
  }
  const name = interaction.options.getString('nom').trim();
  if (sub === 'ajouter') {
    const result = db.addCategory(name);
    const messages = {
      existe: `La catégorie **${name}** existe déjà.`,
      reactivee: `✅ Catégorie **${name}** réactivée.`,
      ajoutee: `✅ Catégorie **${name}** ajoutée. Elle sera notée dès le prochain conseil.`,
    };
    return reply(interaction, messages[result]);
  }
  return reply(interaction, db.deactivateCategory(name)
    ? `✅ Catégorie **${name}** retirée (ses anciennes notes restent dans les stats).`
    : `Catégorie **${name}** introuvable.`);
}

async function admin(interaction, sub) {
  if (sub === 'forcer-fin') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const done = await session.forceEnd(interaction.client);
    return interaction.editReply(done ? '✅ Session terminée.' : 'Aucune session en cours.');
  }
  const id = session.cancelCurrent(interaction.client, interaction.guild);
  return reply(interaction, id ? `✅ Session #${id} annulée.` : 'Rien à annuler.');
}

// ---------- Routage ----------

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return reply(interaction, '🚫 Réservé aux admins (permission « Gérer le serveur »).');
    }
    if (group === 'config') return config(interaction, sub);
    if (group === 'categorie') return categorie(interaction, sub);
    if (group === 'admin') return admin(interaction, sub);
  }
  if (sub === 'profil') return profil(interaction);
  if (sub === 'classement') return classement(interaction);
  if (sub === 'session') return sessionStatus(interaction);
  return undefined;
}

async function autocomplete(interaction) {
  const typed = interaction.options.getFocused().toLowerCase();
  const categories = db.listActiveCategories().map((c) => c.name);
  const choices = interaction.options.getSubcommand() === 'classement' ? ['MVP', 'Boulet', ...categories] : categories;
  await interaction.respond(
    choices.filter((c) => c.toLowerCase().includes(typed)).slice(0, 25).map((c) => ({ name: c, value: c })),
  );
}

module.exports = { data, execute, autocomplete };
