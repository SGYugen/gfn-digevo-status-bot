const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

// Variables de entorno
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const MESSAGE_ID = process.env.STATUS_MESSAGE_ID || null;

const ROLE_SERVERS_DOWN = process.env.ROLE_SERVERS_DOWN || null;
const ROLE_WEB_DOWN = process.env.ROLE_WEB_DOWN || null;
const ROLE_WEB_OFFER = process.env.ROLE_WEB_OFFER || null;
const ROLE_SERVERS_ISSUES = process.env.ROLE_SERVERS_ISSUES || null;

console.log('Iniciando bot...');
console.log('DISCORD_TOKEN presente:', !!TOKEN);
console.log('STATUS_CHANNEL_ID:', CHANNEL_ID);
console.log('STATUS_MESSAGE_ID:', MESSAGE_ID);

// Estado previo para evitar spam
let previousFlags = {
  serversDown: false,
  serversIssues: false,
  webDown: false,
  webOffer: false
};

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

async function fetchDigevoSiteInfo() {
  let siteLevel = 'ok';
  let offerText = null;
  let offerUrl = null;

  try {
    const res = await axios.get('https://geforcenow.digevo.com/', { timeout: 8000 });
    if (res.status !== 200) siteLevel = 'issue';

    const $ = cheerio.load(res.data);
    const bodyText = $('body').text().toLowerCase();

    const hasOffer =
      bodyText.includes('$') ||
      bodyText.includes('clp') ||
      bodyText.includes('col') ||
      bodyText.includes('pen') ||
      bodyText.includes('descuento') ||
      bodyText.includes('oferta');

    if (hasOffer) {
      offerText = 'Oferta detectada';
      offerUrl = 'https://geforcenow.digevo.com/';
    }

    console.log('fetchDigevoSiteInfo: siteLevel =', siteLevel, 'offer =', !!offerText);
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

function mapSingleToLevel(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('major') || t.includes('outage') || t.includes('partial')) return 'issue';
  if (t.includes('degraded')) return 'degraded';
  if (t.includes('operational') || t.includes('available')) return 'ok';
  if (t === 'error') return 'issue';
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

function getEmbedColor(globalLevel) {
  if (globalLevel === 'ok') return 0x76b900;      // verde NVIDIA
  if (globalLevel === 'degraded') return 0xffa500; // naranja
  if (globalLevel === 'issue') return 0xff0000;    // rojo
  return 0x00aaff;
}

// ------------------------
// Construir embed + flags
// ------------------------

async function buildEmbedAndFlags() {
  const status = await fetchGfnStatus();
  const incident = await fetchGfnLatestIncident();
  const digevoSite = await fetchDigevoSiteInfo();

  const sclStatus = status.latamSouth;
  const bogStatus = status.latamNorth;
  const mallLevel = mapMallToLevel(status.mallHealth);
  const gfnLevel = mapStatusToLevel(sclStatus, bogStatus);

  console.log('buildEmbed: sclStatus =', sclStatus, 'bogStatus =', bogStatus, 'mall =', status.mallHealth);

  let gfnStatusText = '';
  if (gfnLevel === 'ok') gfnStatusText = 'Operativo';
  else if (gfnLevel === 'degraded') gfnStatusText = 'Degradado';
  else if (gfnLevel === 'issue') gfnStatusText = 'Incidencias activas';
  else gfnStatusText = 'Estado desconocido';

  const gfnIncidenciasLine =
    incident.incidentText && incident.incidentUrl
      ? `Incidencias: [${incident.incidentText}](${incident.incidentUrl})`
      : 'Incidencias: Sin incidencias recientes reportadas';

  let globalLevel = 'unknown';
  const mallIsIssue = mallLevel === 'issue';
  if (gfnLevel === 'issue' || mallIsIssue) globalLevel = 'issue';
  else if (gfnLevel === 'degraded') globalLevel = 'degraded';
  else if (gfnLevel === 'ok' && mallLevel === 'ok') globalLevel = 'ok';

  const sclLevel = mapSingleToLevel(sclStatus);
  const bogLevel = mapSingleToLevel(bogStatus);

  const sclIssueWord = sclLevel === 'issue' ? 'CAÍDA ' : sclLevel === 'degraded' ? 'LAG ' : '';
  const bogIssueWord = bogLevel === 'issue' ? 'CAÍDA ' : bogLevel === 'degraded' ? 'LAG ' : '';

  const sclLine = `- NPA-DIG-SCL-01 ${sclIssueWord}${levelToIcon(sclLevel)}`;
  const bogLine = `- NPA-DIG-BOG-01 ${bogIssueWord}${levelToIcon(bogLevel)}`;

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
        name: 'ESTADO SERVIDORES GFN',
        value:
          `[Ver estado servidores](https://status.geforcenow.com)\n\n` +
          `${levelToIcon(gfnLevel)} ${gfnStatusText}\n\n` +
          gfnIncidenciasLine,
        inline: false
      },
      {
        name: 'ESTADO SERVIDORES DIGEVO',
        value:
          `\n${sclLine}\n` +
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
    .setColor(getEmbedColor(globalLevel));

  if (digevoSite.siteLevel === 'issue' || digevoSite.offerText) {
    let extraLines = '\n';

    if (digevoSite.siteLevel === 'issue') {
      extraLines += '⚠️ Problemas detectados con la web de Digevo (posible caída o error).\n';
    }

    if (digevoSite.offerText && digevoSite.offerUrl) {
      extraLines += `[Oferta detectada](${digevoSite.offerUrl})`;
    }

    embed.addFields({
      name: 'WEB DIGEVO',
      value: extraLines.trim(),
      inline: false
    });
  }

  // Flags para pings
  const flags = {
    serversDown: globalLevel === 'issue',
    serversIssues: globalLevel === 'degraded' || mallLevel === 'issue',
    webDown: digevoSite.siteLevel === 'issue',
    webOffer: !!digevoSite.offerText
  };

  return { embed, flags };
}

// ------------------------
// Actualizar mensaje + pings
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

    const { embed, flags } = await buildEmbedAndFlags();

    // Detectar cambios para pings
    const messagesToSend = [];

    if (flags.serversDown && !previousFlags.serversDown && ROLE_SERVERS_DOWN) {
      messagesToSend.push(`<@&${ROLE_SERVERS_DOWN}> Servidores GFN/Digevo con caídas.`);
    }
    if (flags.serversIssues && !previousFlags.serversIssues && ROLE_SERVERS_ISSUES) {
      messagesToSend.push(`<@&${ROLE_SERVERS_ISSUES}> Servidores con problemas de rendimiento (lag/errores).`);
    }
    if (flags.webDown && !previousFlags.webDown && ROLE_WEB_DOWN) {
      messagesToSend.push(`<@&${ROLE_WEB_DOWN}> Problemas detectados con la web de Digevo.`);
    }
    if (flags.webOffer && !previousFlags.webOffer && ROLE_WEB_OFFER) {
      messagesToSend.push(`<@&${ROLE_WEB_OFFER}> Nueva oferta detectada en la web de Digevo.`);
    }

    previousFlags = flags;

    // Enviar pings (si hay)
    for (const content of messagesToSend) {
      await channel.send({ content });
    }

    // Editar o crear el mensaje de estado
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

// HTTP mínimo
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (_req, res) => {
  res.send('GFN Digevo status bot running');
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});
