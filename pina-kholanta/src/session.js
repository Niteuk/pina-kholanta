const {
  ActionRowBuilder, StringSelectMenuBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');
const db = require('./db');
const { computeResults } = require('./scoring');
const {
  MIN_PRESENCE_MS, EMPTY_GRACE_MS, VOTE_DURATION_MS, MIN_ELIGIBLE_PLAYERS, REVEAL_DELAY_MS,
} = require('./config');

// Heure d'arrivée en voc des joueurs actuellement présents (session en cours)
const joinTimes = new Map();
let emptyTimer = null;
const closeTimers = new Map();

// Note du milieu, à utiliser quand on ne peut pas juger une catégorie
const NEUTRAL_NOTE = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mention = (ids) => ids.map((id) => `<@${id}>`).join(' et ');
const fmtScore = (score) => score.toFixed(2).replace('.', ',');
const fmtMinutes = (ms) => `${Math.floor(ms / 60000)} min`;
const ts = (ms, style = 't') => `<t:${Math.floor(ms / 1000)}:${style}>`;

async function announce(client, content) {
  const channelId = db.getSetting('results_channel_id');
  if (!channelId) {
    console.warn('[Pina Kho-lanta] Aucun salon de résultats configuré (/pkl config salon-resultats).');
    return;
  }
  try {
    const channel = await client.channels.fetch(channelId);
    await channel.send(content);
  } catch (err) {
    console.error('[Pina Kho-lanta] Impossible de publier dans le salon de résultats :', err.message);
  }
}

function humansIn(guild) {
  const voiceId = db.getSetting('voice_channel_id');
  const channel = voiceId ? guild.channels.cache.get(voiceId) : null;
  return channel ? [...channel.members.values()].filter((m) => !m.user.bot) : [];
}

function cancelEmptyTimer() {
  if (emptyTimer) clearTimeout(emptyTimer);
  emptyTimer = null;
}

function startEmptyTimer(client) {
  cancelEmptyTimer();
  emptyTimer = setTimeout(() => {
    emptyTimer = null;
    const session = db.getOpenSession();
    if (session) endSession(client, session.id).catch(console.error);
  }, EMPTY_GRACE_MS);
}

function ensureOpenSession(client, now) {
  let session = db.getOpenSession();
  if (!session) {
    session = db.createSession(now);
    announce(client, `🔥 **Session #${session.id} ouverte !** Le Totem vous observe…`);
  }
  return session;
}

function onJoin(client, member, now) {
  cancelEmptyTimer();
  ensureOpenSession(client, now);
  db.upsertPlayer(member.id, member.displayName);
  if (!joinTimes.has(member.id)) joinTimes.set(member.id, now);
}

function onLeave(userId, now) {
  const session = db.getOpenSession();
  const joinedAt = joinTimes.get(userId);
  joinTimes.delete(userId);
  if (session && joinedAt !== undefined) db.addPresence(session.id, userId, now - joinedAt);
}

/** Enregistre le temps des joueurs encore présents (fin forcée, annulation). */
function flushPresence(sessionId, now) {
  for (const [userId, joinedAt] of joinTimes) db.addPresence(sessionId, userId, now - joinedAt);
  joinTimes.clear();
}

/** Remet l'état en mémoire en phase avec le salon vocal (démarrage, changement de config…). */
function resync(client, guild) {
  const now = Date.now();
  const humans = humansIn(guild);
  if (humans.length > 0) {
    for (const member of humans) onJoin(client, member, now);
  } else if (db.getOpenSession()) {
    startEmptyTimer(client);
  }
}

async function handleVoiceUpdate(client, oldState, newState) {
  const voiceId = db.getSetting('voice_channel_id');
  if (!voiceId) return;
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  const wasIn = oldState.channelId === voiceId;
  const isIn = newState.channelId === voiceId;
  if (wasIn === isIn) return;

  const now = Date.now();
  if (isIn) {
    onJoin(client, member, now);
  } else {
    onLeave(member.id, now);
    if (humansIn(newState.guild).length === 0 && db.getOpenSession()) startEmptyTimer(client);
  }
}

// ---------- Fin de session et bulletins ----------

async function endSession(client, sessionId) {
  cancelEmptyTimer();
  const now = Date.now();
  flushPresence(sessionId, now);
  db.markEligibility(sessionId, MIN_PRESENCE_MS);
  const eligible = db.getEligibleIds(sessionId);

  if (eligible.length < MIN_ELIGIBLE_PLAYERS) {
    db.updateSession(sessionId, { endedAt: now, status: 'annulee' });
    await announce(client,
      `🌙 Session #${sessionId} terminée, mais seulement ${eligible.length} joueur(s) ont passé `
      + `${fmtMinutes(MIN_PRESENCE_MS)} en voc (minimum ${MIN_ELIGIBLE_PLAYERS}). Pas de conseil ce soir.`);
    return;
  }

  const closesAt = now + VOTE_DURATION_MS;
  db.updateSession(sessionId, { endedAt: now, voteClosesAt: closesAt, status: 'vote' });
  await announce(client,
    `🗿 **Le conseil de la session #${sessionId} est ouvert !**\n`
    + `Joueurs appelés à voter : ${mention(eligible)}\n`
    + `Allez voir vos messages privés. Clôture ${ts(closesAt, 'R')}.`);

  const failed = await sendBallots(client, sessionId, eligible, closesAt);
  if (failed.length > 0) {
    await announce(client, `⚠️ Impossible d'envoyer le bulletin à ${mention(failed)}. `
      + 'Activez les messages privés venant des membres du serveur (Paramètres du serveur > Confidentialité).');
  }
  scheduleClose(client, sessionId, closesAt);
}

function buildBallotRows(sessionId, targetId, categories, notes) {
  return categories.map((cat) => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`rate:${sessionId}:${targetId}:${cat.id}`)
      .setPlaceholder(`${cat.name} : choisis une note`)
      .addOptions([1, 2, 3, 4, 5].map((n) => ({
        label: n === NEUTRAL_NOTE ? `${cat.name} : ${n}/5 · Pas d'avis / neutre` : `${cat.name} : ${n}/5`,
        description: n === NEUTRAL_NOTE ? 'À choisir si tu ne peux pas juger cette catégorie' : undefined,
        emoji: n === NEUTRAL_NOTE ? '🤷' : '⭐',
        value: String(n),
        default: notes.get(cat.id) === n,
      }))),
  ));
}

async function sendBallots(client, sessionId, eligible, closesAt) {
  const categories = db.listActiveCategories();
  const failed = [];

  for (const voterId of eligible) {
    try {
      const user = await client.users.fetch(voterId);
      await user.send(
        `🗿 **Conseil de la session #${sessionId}**\n`
        + 'Note chaque joueur dans chaque catégorie (1 = bof, 5 = au top). Tes notes sont **anonymes** '
        + `et tu peux les modifier jusqu'à la clôture ${ts(closesAt, 'R')}.\n`
        + '💡 Si tu ne peux pas juger une catégorie (ex. : il n\'a pas cuisiné ce soir), mets **3 · Pas d\'avis / neutre**.');

      for (const targetId of eligible.filter((id) => id !== voterId)) {
        // 5 menus maximum par message : on découpe si besoin
        for (let i = 0; i < categories.length; i += 5) {
          const chunk = categories.slice(i, i + 5);
          await user.send({
            embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle(`Note ${db.getPlayerName(targetId)}`)],
            components: buildBallotRows(sessionId, targetId, chunk, new Map()),
          });
        }
      }
    } catch (err) {
      console.error(`[Pina Kho-lanta] Bulletin non envoyé à ${voterId} :`, err.message);
      failed.push(voterId);
    }
  }
  return failed;
}

async function handleRating(interaction) {
  const [, sessionIdRaw, targetId, categoryIdRaw] = interaction.customId.split(':');
  const sessionId = Number(sessionIdRaw);
  const categoryId = Number(categoryIdRaw);
  const voterId = interaction.user.id;
  const session = db.getSession(sessionId);

  if (!session || session.status !== 'vote' || Date.now() > session.vote_closes_at) {
    return interaction.reply({ content: '⌛ Ce conseil est clos, la note n\'a pas été prise en compte.', flags: MessageFlags.Ephemeral });
  }
  if (voterId === targetId || !db.isEligible(sessionId, voterId) || !db.isEligible(sessionId, targetId)) {
    return interaction.reply({ content: '🚫 Tu ne peux pas donner cette note.', flags: MessageFlags.Ephemeral });
  }

  db.upsertRating(sessionId, voterId, targetId, categoryId, Number(interaction.values[0]));

  // On reconstruit le message pour afficher les notes déjà choisies
  const categoryIds = interaction.message.components.map((row) => Number(row.components[0].customId.split(':')[3]));
  const categories = db.getCategoriesByIds(categoryIds);
  const notes = db.getNotesGiven(sessionId, voterId, targetId);
  return interaction.update({ components: buildBallotRows(sessionId, targetId, categories, notes) });
}

// ---------- Clôture du vote et révélation ----------

function scheduleClose(client, sessionId, closesAt) {
  if (closeTimers.has(sessionId)) clearTimeout(closeTimers.get(sessionId));
  const delay = Math.max(0, closesAt - Date.now());
  closeTimers.set(sessionId, setTimeout(() => {
    closeTimers.delete(sessionId);
    closeVote(client, sessionId).catch(console.error);
  }, delay));
}

async function closeVote(client, sessionId) {
  const session = db.getSession(sessionId);
  if (!session || session.status !== 'vote') return;

  const eligible = db.getEligibleIds(sessionId);
  const { rows, mvp, boulet } = computeResults(eligible, db.getSessionRatings(sessionId));

  if (rows.length === 0) {
    db.updateSession(sessionId, { status: 'annulee' });
    await announce(client, `🦗 Personne n'a voté pour la session #${sessionId}. Le Totem reste muet.`);
    return;
  }

  db.finishSession(sessionId, rows, mvp, boulet);
  const scoreOf = (id) => fmtScore(rows.find((r) => r.userId === id).score);

  await announce(client, `🗿 **Le conseil de la session #${sessionId} est terminé.** Le Totem a parlé…`);
  await sleep(REVEAL_DELAY_MS);

  if (mvp.length === 0) {
    await announce(client, '🤝 Égalité parfaite entre tout le monde : ni MVP ni boulet ce soir !');
  } else {
    await announce(client, `🥥 ${boulet.length > 1 ? 'Les boulets' : 'Le boulet'} du soir…`);
    await sleep(REVEAL_DELAY_MS);
    await announce(client, `🪨 ${mention(boulet)} (${scoreOf(boulet[0])}/5)`);
    await sleep(REVEAL_DELAY_MS);
    await announce(client, `🔥 Et ${mvp.length > 1 ? 'les MVP' : 'le MVP'} du soir…`);
    await sleep(REVEAL_DELAY_MS);
    await announce(client, `🏆 ${mention(mvp)} (${scoreOf(mvp[0])}/5)`);
    await sleep(REVEAL_DELAY_MS);
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => `${medals[i] ?? `**${i + 1}.**`} <@${r.userId}> : ${fmtScore(r.score)}/5`);
  await announce(client, {
    embeds: [new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`Classement de la session #${sessionId}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Score = moyenne des moyennes par catégorie' })],
  });
}

// ---------- Commandes admin ----------

async function forceEnd(client) {
  const session = db.getOpenSession();
  if (!session) return false;
  await endSession(client, session.id);
  return true;
}

function cancelCurrent(client, guild) {
  const session = db.getOpenSession() ?? db.getVotingSessions()[0];
  if (!session) return null;
  cancelEmptyTimer();
  if (closeTimers.has(session.id)) clearTimeout(closeTimers.get(session.id));
  closeTimers.delete(session.id);
  joinTimes.clear();
  db.updateSession(session.id, { endedAt: Date.now(), status: 'annulee' });
  resync(client, guild); // si des joueurs sont encore en voc, une nouvelle session repart de zéro
  return session.id;
}

/** Temps cumulé d'un joueur dans la session en cours, y compris le passage actuel. */
function liveMs(sessionId, userId) {
  const stored = db.getPresence(sessionId).find((p) => p.user_id === userId)?.total_ms ?? 0;
  const joinedAt = joinTimes.get(userId);
  return stored + (joinedAt !== undefined ? Date.now() - joinedAt : 0);
}

function liveParticipants(sessionId) {
  const ids = new Set([...db.getPresence(sessionId).map((p) => p.user_id), ...joinTimes.keys()]);
  return [...ids].map((id) => ({ userId: id, ms: liveMs(sessionId, id), inVoice: joinTimes.has(id) }))
    .sort((a, b) => b.ms - a.ms);
}

// ---------- Démarrage ----------

async function init(client, guild) {
  // Reprend les votes en cours après un redémarrage du bot
  for (const session of db.getVotingSessions()) scheduleClose(client, session.id, session.vote_closes_at);
  resync(client, guild);
}

module.exports = {
  init, resync, handleVoiceUpdate, handleRating, forceEnd, cancelCurrent, liveParticipants, ts, fmtMinutes,
};
