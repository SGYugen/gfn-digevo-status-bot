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

client.on('debug', msg => console.log('[DEBUG]', msg));
client.on('warn', msg => console.warn('[WARN]', msg));
client.on('error', err => console.error('[CLIENT ERROR]', err));

client.once('ready', () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  updateStatusMessage();
  setInterval(updateStatusMessage, 5 * 60 * 1000);
});

// ------------------------
// Scrapes
// ------------------------

async function fetchGfnStatus() {
  let latamSouth = 'unknown';
  let latamNorth = 'unknown';
  let mallHealth = 'unknown';

  console.log('fetchGfnStatus: iniciando...');

  // Status oficial GFN [page:1]
  try {
    const res = await axios.get('https://status.geforcenow.com/');
    const $ = cheerio.load(res.data);

    $('div.component-container, li.component-container').each((_, el) => {
      const name = $(el).text().trim();
      const statusEl = $(el).find('.component-status, .status, .component-statuses');
      const statusText = statusEl.text().trim().toLowerCase().replace(/\s+/g, ' ');

      if (name.toLowerCase().includes('latam south')) latamSouth = statusText || 'unknown';
      if (name.toLowerCase().includes('latam north')) latamNorth = statusText || 'unknown';
    });

    console.log('fetchGfnStatus: latamSouth =', latamSouth, 'latamNorth =', latamNorth);
  } catch (e) {
    console.error('Error leyendo status.geforcenow.com:', e.message);
    latamSouth = 'error';
    latamNorth = 'error';
  }

  // Healthcheck Mall [page:3]
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

// Incidente más reciente de GFN [page:2]
async function fetchGfnLatestIncident() {
  let incidentText = null;
  let incidentUrl = null;

  try {
    const res = await axios.get('https://status.geforcenow.com/history');
    const $ = cheerio.load(res.data);

    const firstIncident =
      $('.incident-title').first().length > 0
        ? $('.incident-title').first()
        : $('.incidents-list .incident-container').first();

    if (firstIncident && firstIncident.length > 0) {
      const text = firstIncident.text().trim().replace(/\s+/g, ' ');
      if (text) incidentText = text;

      const link = firstIncident.find('a').attr('href');
      if (link) {
        incidentUrl = link.startsWith('http')
          ? link
          : 'https://status.geforcenow.com' + link;
      }
    }

    console.log('fetchGfnLatestIncident:', incidentText || 'sin incidentes visibles', '->', incidentUrl);
  } catch (e) {
    console.error('Error leyendo history de GFN:', e.message);
  }

  return { incidentText, incidentUrl };
}

// Info de la web de Digevo (caída / oferta) [page:3]
async function fetchDigevoSiteInfo() {
  let siteLevel = 'ok'; // ok / issue / unknown
  let offerText = null;
  let offerUrl = null;

  try {
    const res = await axios.get('https://geforcenow.digevo.com/', { timeout: 8000 });
    if (res.status !== 200) siteLevel = 'issue';

    const $ = cheerio.load(res.data);

    // Heurística simple para oferta principal (ej: BLACK SALE, descuentos, CLP/COL/PE) [page:3]
    const bodyText = $('body').text().toLowerCase();

    const hasMoney =
      bodyText.includes('$') ||
      bodyText.includes('clp') ||
      bodyText.includes('col') ||
      bodyText.includes('pen') ||
      bodyText.includes('descuento') ||
      bodyText.includes('oferta');

    if (hasMoney) {
      // Intentar usar el bloque del slider principal
      const hero = $('body').text().trim().replace(/\s+/g, ' ');
      offerText = hero.slice(0, 200) + '...';
      offerUrl = 'https://geforcenow.digevo.com/';
    }

    console.log('fetchDigevoSiteInfo: siteLevel =', siteLevel, 'offerText =', offerText ? 'sí' : 'no');
  } catch (e) {
    console.error('Error accediendo a geforcenow.digevo.com:', e.message);
    siteLevel = 'issue';
  }

  return { siteLevel, offerText, offerUrl };
}

// ------------------------
// Helpers
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
  const digevoSite = await fetchDigevoSiteInfo();

  const sclStatus = status.latamSouth;
  const bogStatus = status.latamNorth;
  const mallLevel = mapMallToLevel(status.mallHealth);
  const gfnLevel = mapStatusToLevel(sclStatus, bogStatus);

  console.log('buildEmbed: sclStatus =', sclStatus, 'bogStatus =', bogStatus, 'mall =', status.mallHealth);

  // Texto general GFN
  let gfnStatusText = '';
  if (gfnLevel === 'ok') gfnStatusText = 'Operativo';
  else if (gfnLevel === 'degraded') gfnStatusText = 'Degradado';
  else if (gfnLevel === 'issue') gfnStatusText = 'Incidencias activas';
  else gfnStatusText = 'Estado desconocido';

  // Incidencias GFN: solo link cuando hay incidencia [page:2]
  let gfnIncidenciasLine = 'Incidencias: Sin incidencias recientes reportadas';
  if (incident.incidentText && incident.incidentUrl) {
    gfnIncidenciasLine = `Incidencias: [${incident.incidentText}](${incident.incidentUrl})`;
  }

  // Nivel Digevo global [page:3]
  let digevoLevel = 'unknown';
  if (gfnLevel === 'issue' || mallLevel === 'issue') digevoLevel = 'issue';
  else if (gfnLevel === 'degraded') digevoLevel = 'degraded';
  else if (gfnLevel === 'ok' && mallLevel === 'ok') digevoLevel = 'ok';

  let digevoStatusText = '';
  if (digevoLevel === 'ok') digevoStatusText = 'Operativo';
  else if (digevoLevel === 'degraded') digevoStatusText = 'Degradado';
  else if (digevoLevel === 'issue') digevoStatusText = 'Posibles incidencias / lag';
  else digevoStatusText = 'Estado desconocido';

  // Estado por servidor NPA-DIG-SCL-01 / NPA-DIG-BOG-01
  // Heurística: usamos latamSouth para SCL y latamNorth para BOG
  const sclLevel = mapStatusToLevel(sclStatus, sclStatus);
  const bogLevel = mapStatusToLevel(bogStatus, bogStatus);

  const sclIssueWord = sclLevel === 'issue' ? 'CAÍDA ' : sclLevel === 'degraded' ? 'LAG ' : '';
  const bogIssueWord = bogLevel === 'issue' ? 'CAÍDA ' : bogLevel === 'degraded' ? 'LAG ' : '';

  const sclLine = `- NPA-DIG-SCL-01 ${sclIssueWord}${levelToIcon(sclLevel)}`;
  const bogLine = `- NPA-DIG-BOG-01 ${bogIssueWord}${levelToIcon(bogLevel)}`;

  // Incidencias Digevo según mall [page:3]
  let digevoIncidenciasText = '';
  if (mallLevel === 'ok') {
    digevoIncidenciasText = 'Incidencias: Sin incidencias detectadas por el monitor';
  } else if (mallLevel === 'issue') {
    digevoIncidenciasText =
      'Incidencias: Problemas al conectar con play.geforcenow.com/mall (posible lag/caída)';
  } else {
    digevoIncidenciasText = 'Incidencias: Información insuficiente (healthcheck no concluyente)';
  }

  const embed = new EmbedBuilder()
    .setTitle('Estado GeForce NOW (GFN & Digevo)')
    .setDescription('Panel automático de estado para GFN global y servidores Digevo (Chile/Colombia).')
    .addFields(
      {
        // Campo 1: título + espacio + cuerpo
        name: 'ESTADO SERVIDORES GFN',
        value:
          `[Ver status global](https://status.geforcenow.com)\n\n` +
          `${levelToIcon(gfnLevel)} ${gfnStatusText}\n` +
          `${gfnIncidenciasLine}`,
        inline: false
      },
      {
        // Campo 2: título + espacio + cuerpo
        name: 'ESTADO SERVIDORES DIGEVO',
        value:
          `${levelToIcon(digevoLevel)} ${digevoStatusText}\n` +
          `${sclLine}\n` +
          `${bogLine}\n` +
          `${digevoIncidenciasText}`,
        inline: false
      }
    )
    .setFooter({
      text: `Última actualización: ${status.updatedAt.toLocaleString('es-CL', {
        timeZone: 'America/Santiago'
      })}`
    })
    .setColor(0x00aaff);

  // Campo extra bajo condiciones (web Digevo) [page:3]
  if (digevoSite.siteLevel === 'issue' || digevoSite.offerText) {
    let extraLines = '';

    if (digevoSite.siteLevel === 'issue') {
      extraLines += '⚠️ Problemas detectados con la web de Digevo (posible caída o error).\n';
    }

    if (digevoSite.offerText) {
      extraLines += `🎁 Oferta detectada: [${digevoSite.offerText}](${digevoSite.offerUrl})`;
    }

    embed.addFields({
      name: 'WEB DIGEVO',
      value: extraLines || 'Sin novedades relevantes en la web',
      inline: false
    });
  }

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

// --- Servidor HTTP mínimo para host ---
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (_req, res) => {
  res.send('GFN Digevo status bot running');
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
