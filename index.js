const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

// Variables de entorno
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const MESSAGE_ID = process.env.STATUS_MESSAGE_ID || null;

console.log('Iniciando bot...');
console.log('DISCORD_TOKEN presente:', !!TOKEN);
console.log('STATUS_CHANNEL_ID:', CHANNEL_ID);
console.log('STATUS_MESSAGE_ID:', MESSAGE_ID);

// Cliente de Discord
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Logs de eventos de Discord
client.on('debug', msg => console.log('[DEBUG]', msg));
client.on('warn', msg => console.warn('[WARN]', msg));
client.on('error', err => console.error('[CLIENT ERROR]', err));

client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  updateStatusMessage();
  setInterval(updateStatusMessage, 5 * 60 * 1000); // cada 5 minutos
});

// ------------------------
// Scrape de estados GFN/Digevo
// ------------------------

async function fetchGfnStatus() {
  let latamSouth = 'unknown';
  let latamNorth = 'unknown';
  let mallHealth = 'unknown';

  console.log('fetchGfnStatus: iniciando...');

  // Status oficial GFN (NVIDIA) [page:1]
  try {
    const res = await axios.get('https://status.geforcenow.com/');
    const $ = cheerio.load(res.data);

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

    console.log('fetchGfnStatus: latamSouth =', latamSouth, 'latamNorth =', latamNorth);
  } catch (e) {
    console.error('Error leyendo status.geforcenow.com:', e.message);
    latamSouth = 'error';
    latamNorth = 'error';
  }

  // Healthcheck Mall Digevo [page:3]
  try {
    const mallRes = await axios.get('https://play.geforcenow.com/mall/', { timeout: 8000 });
    mallHealth = mallRes.status === 200 ? 'ok' : `http_${mallRes.status}`;
    console.log('fetchGfnStatus: mallHealth =', mallHealth);
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

// Historial de incidentes GFN (lo más reciente) [page:2]
async function fetchGfnLatestIncident() {
  let incidentText = 'Sin incidentes recientes reportados';
  let incidentUrl = 'https://status.geforcenow.com/history';

  try {
    const res = await axios.get('https://status.geforcenow.com/history');
    const $ = cheerio.load(res.data);

    // Esto depende del HTML de statuspage; usamos un selector genérico
    // Primer bloque de incidente
    const firstIncident = $('.incident-title, .incidents-list .incident-container, .unresolved-incidents li').first();

    if (firstIncident && firstIncident.length > 0) {
      // Título simple
      const text = firstIncident.text().trim().replace(/\s+/g, ' ');
      if (text) {
        incidentText = text;
      }

      // Si hay link interno, lo usamos; si no, dejamos el history genérico
      const link = firstIncident.find('a').attr('href');
      if (link) {
        if (link.startsWith('http')) {
          incidentUrl = link;
        } else {
          incidentUrl = 'https://status.geforcenow.com' + link;
        }
      }
    }

    console.log('fetchGfnLatestIncident:', incidentText, '->', incidentUrl);
  } catch (e) {
    console.error('Error leyendo history de GFN:', e.message);
  }

  return { incidentText, incidentUrl };
}

// ------------------------
// Helpers de estado
// ------------------------

function mapStatusToLevel(latamSouth, latamNorth) {
  const s = (latamSouth || '').toLowerCase();
  const n = (latamNorth || '').toLowerCase();
  const all = `${s} ${n}`;

  if (all.includes('major') || all.includes('outage') || all.includes('partial')) return 'issue';
  if (all.includes('degraded')) return 'degraded';
  if (all.includes('operational') || all.includes('available')) return 'ok';
  return 'unknown';
}

function mapMallToLevel(mallHealth) {
  const m = (mallHealth || '').toLowerCase();
  if (m === 'ok') return 'ok';
  if (m.startsWith('http_5') || m === 'error') return 'issue';
  return 'unknown';
}

function levelToIcon(level) {
  if (level === 'ok') return '🟢';
  if (level === 'degraded') return '🟡';
  if (level === 'issue') return '🔴';
  return '⚪';
}

// ------------------------
// Construir embed
// ------------------------

async function buildEmbed() {
  const status = await fetchGfnStatus();
  const incident = await fetchGfnLatestIncident();

  const sclStatus = status.latamSouth;
  const bogStatus = status.latamNorth;
  const mallLevel = mapMallToLevel(status.mallHealth);
  const gfnLevel = mapStatusToLevel(sclStatus, bogStatus);

  console.log('buildEmbed: sclStatus =', sclStatus, 'bogStatus =', bogStatus, 'mall =', status.mallHealth);

  // Texto general para GFN
  let gfnStatusText = '';
  if (gfnLevel === 'ok') gfnStatusText = 'Operativo';
  else if (gfnLevel === 'degraded') gfnStatusText = 'Degradado';
  else if (gfnLevel === 'issue') gfnStatusText = 'Incidencias activas';
  else gfnStatusText = 'Estado desconocido';

  // Texto general para Digevo (usando mall + regiones) [page:3]
  let digevoLevel = 'unknown';
  if (gfnLevel === 'issue' || mallLevel === 'issue') digevoLevel = 'issue';
  else if (gfnLevel === 'degraded') digevoLevel = 'degraded';
  else if (gfnLevel === 'ok' && mallLevel === 'ok') digevoLevel = 'ok';

  let digevoStatusText = '';
  if (digevoLevel === 'ok') digevoStatusText = 'Operativo';
  else if (digevoLevel === 'degraded') digevoStatusText = 'Degradado';
  else if (digevoLevel === 'issue') digevoStatusText = 'Posibles incidencias / lag';
  else digevoStatusText = 'Estado desconocido';

  // Incidencias Digevo según healthcheck [page:3]
  let digevoIncidentText = '';
  if (mallLevel === 'ok') {
    digevoIncidentText = 'Sin incidencias detectadas por el monitor';
  } else if (mallLevel === 'issue') {
    digevoIncidentText = 'Problemas al conectar con play.geforcenow.com/mall (posible lag/caída)';
  } else {
    digevoIncidentText = 'Información insuficiente (healthcheck no concluyente)';
  }

  const embed = new EmbedBuilder()
    .setTitle('Estado GeForce NOW (GFN & Digevo)')
    .setDescription('Panel automático de estado para GFN global y servidores Digevo (Chile/Colombia).')
    .addFields(
      {
        name: '[ESTADO SERVIDORES GFN](https://status.geforcenow.com)',
        value:
          `${levelToIcon(gfnLevel)} ${gfnStatusText}\n` +
          `Incidencias: [${incident.incidentText}](${incident.incidentUrl})`,
        inline: false
      },
      {
        name: 'ESTADO SERVIDORES DIGEVO',
        value:
          `${levelToIcon(digevoLevel)} ${digevoStatusText}\n` +
          `Incidencias: ${digevoIncidentText}`,
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

// ------------------------
// Actualizar mensaje en Discord
// ------------------------

async function updateStatusMessage() {
  try {
    console.log('updateStatusMessage: iniciando...');
    if (!CHANNEL_ID) {
      console.error('Falta STATUS_CHANNEL_ID');
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_ID).catch(err => {
      console.error('Error al buscar canal:', err.message);
      return null;
    });
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

// Login del bot
if (!TOKEN) {
  console.error('No hay DISCORD_TOKEN, abortando login');
} else {
  client.login(TOKEN).catch(err => {
    console.error('Error en client.login:', err);
  });
}

// --- Servidor HTTP mínimo para Railway/Render ---
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (_req, res) => {
  res.send('GFN Digevo status bot running');
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
