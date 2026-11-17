require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const pkl = require('./commands/pkl');
const session = require('./session');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('❌ DISCORD_TOKEN et GUILD_ID doivent être définis (voir .env.example).');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (c) => {
  const guild = await c.guilds.fetch(GUILD_ID);
  // Enregistre /pkl sur le serveur (mise à jour instantanée à chaque démarrage)
  await guild.commands.set([pkl.data.toJSON()]);
  await session.init(c, guild);
  console.log(`🗿 Pina Kho-lanta connecté en tant que ${c.user.tag} sur « ${guild.name} »`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.guild.id !== GUILD_ID) return;
  session.handleVoiceUpdate(client, oldState, newState).catch(console.error);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete() && interaction.commandName === pkl.data.name) {
      await pkl.autocomplete(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === pkl.data.name) {
      await pkl.execute(interaction);
    } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('rate:')) {
      await session.handleRating(interaction);
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '💥 Une erreur est survenue.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
