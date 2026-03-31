const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const MESSAGE_ID = process.env.STATUS_MESSAGE_ID || null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

async function fetchGfnStatus() {
  let latamSouth = 'unknown';
  let latamNorth = 'unknown';
  let mallHealth = 'unknown';

  try {
    const res = await axios.get('https://status.geforcenow.com/');
    const $ = cheerio.load(res.data);

    $('div.component-container, li.component-container').each((_, el) => {
      const name = $(el).text().trim();
      const statusEl = $(el).find('.component-status, .status, .component-statuses');
      const statusText = statusEl.text().trim().toLowerCase();

      if (name.toLowerCase().includes('latam south')) latamSouth = statusText || 'unknown';
      if (name.toLowerCase().includes('latam north')) latamNorth = statusText || 'unknown';
    });
  } catch (e) {
    console.error('Error leyendo status.geforcenow.com:', e.message);
    latamSouth = 'error';
    latamNorth = 'error';
  }

  try {
    const mallRes = await axios.get('https://play.geforcenow.com/mall/', { timeout: 8000 });
    mallHealth = mallRes.status === 200 ? 'ok' : `http_${mallRes.status}`;
  } catch (e) {
    console.error('Error healthcheck mall:', e.message);
    mallHealth = 'error';
  }

  return { latamSouth, latamNorth, mallHealth, updatedAt: new Date() };
}

function mapStatusToEmoji(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('operational') || t.includes('available') || t === 'ok') return '✅';
  if (t.includes('degraded') || t.includes('partial')) return '⚠️';
  if (t.includes('major') || t.includes('outage') || t.includes('down') || t.includes('error')) return '🔴';
  return '❓';
}

async function buildEmbed() {
  const status = await fetchGfnStatus();

  const sclStatus = status.latamSouth;
  const bogStatus = status.latamNorth;

  const embed = new EmbedBuilder()
    .setTitle('Estado GeForce NOW by Digevo (LATAM)')
    .setDescription('Panel automático de estado para Digevo (Chile/Colombia).')
    .addFields(
      {
        name: 'NPA-DIG-SCL-01 (Chile, RTX 4080)',
        value: `${mapStatusToEmoji(sclStatus)} ${sclStatus}`,
        inline: false
      },
      {
        name: 'NPA-DIG-BOG-01 (Colombia, RTX 4080)',
        value: `${mapStatusToEmoji(bogStatus)} ${bogStatus}`,
        inline: false
      },
      {
        name: 'Mall Digevo (play.geforcenow.com/mall)',
        value: `${mapStatusToEmoji(status.mallHealth)} ${status.mallHealth}`,
        inline: false
      }
    )
    .setFooter({
      text: `Última actualización: ${status.updatedAt.toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`
    })
    .setColor(0x00aaff);

  return embed;
}

async function updateStatusMessage() {
  try {
    if (!CHANNEL_ID) {
      console.error('Falta STATUS_CHANNEL_ID');
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('No se encontró el canal');
      return;
    }

    const embed = await buildEmbed();

    if (MESSAGE_ID) {
      const msg = await channel.messages.fetch(MESSAGE_ID).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed] });
        console.log('Mensaje de estado actualizado');
        return;
      } else {
        console.log('No se encontró el mensaje previo, creando uno nuevo');
      }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    console.log('Nuevo mensaje de estado ID:', newMsg.id);
  } catch (e) {
    console.error('Error actualizando mensaje:', e);
  }
}

client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  updateStatusMessage();
  setInterval(updateStatusMessage, 5 * 60 * 1000);
});

client.login(TOKEN);
