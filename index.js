const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

// Variables de entorno
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const MESSAGE_ID = process.env.STATUS_MESSAGE_ID || null;

// Cliente de Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Obtiene estado desde status.geforcenow.com y hace healthcheck al mall
async function fetchGfnStatus() {
  let latamSouth = 'unknown';
  let latamNorth = 'unknown';
  let mallHealth = 'unknown';

  // Scrape de la página de status de NVIDIA
  try {
    const res = await axios.get('https://status.geforcenow.com/');
    const $ = cheerio.load(res.data);

    // Dependiendo del HTML, estos selectores pueden necesitar ajuste
    $('div.component-container, li.component-container').each((_, el) => {
      const name = $(el).text().trim();
      const statusEl = $(el).find('.component-status, .status, .component-statuses');
      const statusText = statusEl.text().trim().toLowerCase();

      if (name.toLowerCase().includes('latam south')) {
        latamSouth = statusText || 'unknown';
      }
      if (name.toLowerCase().includes('latam north')) {
        latamNorth = statusText || 'unknown';
      }
    });
  } catch (e) {
    console.error('Error leyendo status.geforcenow.com:', e.message);
    latamSouth = 'error';
    latamNorth = 'error';
  }

  // Healthcheck del Mall
  try {
    const mallRes = await axios.get('https://play.geforcenow.com/mall/', { timeout: 8000 });
    mallHealth = mallRes.status === 200 ? 'ok' : `http_${mallRes.status}`;
  } catch (e) {
    console.error('Error healthcheck mall:', e.message);
    mallHealth = 'error';
  }

  return {
    latamSouth,
    latamNorth,
    mallHealth,
    updatedAt: new Date()
  };
}

// Mapear texto de estado a emoji
function mapStatusToEmoji(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('operational') || t.includes('available') || t === 'ok') return '✅';
  if (t.includes('degraded') || t.includes('partial')) return '⚠️';
  if (t.includes('major') || t.includes('outage') || t.includes('down') || t.includes('error')) return '🔴';
  return '❓';
}

// Construir el embed de estado
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
      text: `Última actualización: ${status.updatedAt.toLocaleString('es-CL', {
        timeZone: 'America/Santiago'
      })}`
    })
    .setColor(0x00aaff);

  return embed;
}

// Crear o actualizar el mensaje de estado en Discord
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

// Evento ready del bot
client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  // Primera actualización inmediata
  updateStatusMessage();
  // Actualizar cada 5 minutos
  setInterval(updateStatusMessage, 5 * 60 * 1000);
});

// Login del bot
client.login(TOKEN);

// --- Servidor HTTP mínimo para Render ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.send('GFN Digevo status bot running');
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
