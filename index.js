process.env.DISCORD_DISABLE_UPDATE_MESSAGE = 'true';

const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const readline = require('readline');
const { Client } = require('discord.js-selfbot-v13');
const ClientUserSettingManager = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
const { default: AntiCaptcha } = require('anti-captcha');

const TOKEN_FILE = './tokens.txt';
const CONFIG_FILE = './config.json';
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

if (ClientUserSettingManager && !ClientUserSettingManager.__patched) {
  const originalPatch = ClientUserSettingManager.prototype._patch;
  ClientUserSettingManager.prototype._patch = function patched(data = {}) {
    data.friend_source_flags = data.friend_source_flags || {};
    if (typeof data.friend_source_flags.all !== 'boolean') data.friend_source_flags.all = false;
    if (!Array.isArray(data.guild_positions)) data.guild_positions = [];
    if (!Array.isArray(data.user_guild_settings)) data.user_guild_settings = [];
    if (!Array.isArray(data.guild_folders)) data.guild_folders = [];
    return originalPatch.call(this, data);
  };
  ClientUserSettingManager.__patched = true;
}

const defaultConfig = {
  guildId: null,
  vcId: null,
  anticaptchaKey: null,
  chatter: {
    tokens: [],
    channelId: null,
    messageDelaySec: 10,
    messages: [],
    dispatchMode: 'random',
    assignments: [],
  },
};

const LOG_FILE_PATH = './chutiya.log';
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

function appendLog(level, message, error) {
  const timestamp = new Date().toISOString();
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  const details = error ? ` | ${error.stack || error.message || String(error)}` : '';
  try {
    fs.appendFileSync(LOG_FILE_PATH, `[${timestamp}] [${level}] ${payload}${details}\n`);
  } catch (_err) {
    // Ignore logging failures silently.
  }
}

const logger = {
  info(message) {
    appendLog('INFO', message);
  },
  error(message, error) {
    appendLog('ERROR', message, error);
  },
  confirm(message) {
    appendLog('CONFIRM', message);
    originalStdoutWrite(`${message}\n`);
  },
  notify(message) {
    appendLog('NOTICE', message);
    originalStdoutWrite(`${message}\n`);
  },
};

function emitLines(lines) {
  if (!lines) return;
  const payload = Array.isArray(lines) ? lines : [lines];
  payload.filter(Boolean).forEach(text => logger.confirm(String(text)));
}

const BORDER_DOUBLE = {
  topLeft: '╔',
  topRight: '╗',
  bottomLeft: '╚',
  bottomRight: '╝',
  horizontal: '═',
  vertical: '║',
};

const BORDER_SINGLE = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
};

function repeatChar(char, count) {
  return char.repeat(Math.max(0, count));
}

function centerText(text, width) {
  const target = width <= 0 ? '' : String(text ?? '');
  if (target.length >= width) {
    return target.slice(0, width);
  }
  const totalPadding = width - target.length;
  const left = Math.floor(totalPadding / 2);
  const right = totalPadding - left;
  return `${repeatChar(' ', left)}${target}${repeatChar(' ', right)}`;
}

function buildColumnMatrix(options, columns) {
  const sanitized = Array.isArray(options) ? options : [];
  if (!sanitized.length) {
    return [['No options available']];
  }

  const columnCount = Math.max(1, columns);
  const rows = Math.ceil(sanitized.length / columnCount);
  const matrix = [];

  for (let row = 0; row < rows; row += 1) {
    const entries = [];
    for (let column = 0; column < columnCount; column += 1) {
      const index = column * rows + row;
      if (index < sanitized.length) {
        const { key, label } = sanitized[index];
        const text = `[${key}] ${label}`;
        entries.push(text);
      } else {
        entries.push('');
      }
    }
    matrix.push(entries);
  }

  return matrix;
}

function renderAdaptiveMenu({
  title,
  metaLines = [],
  options = [],
  columns = 1,
  exitLabel = '[0] EXIT',
}) {
  const sanitizedMeta = Array.isArray(metaLines) ? metaLines.map(line => String(line ?? '')) : [];
  const sanitizedOptions = Array.isArray(options)
    ? options.map(option => ({ key: option.key, label: option.label }))
    : [];

  const terminalWidth = Math.max(60, Number(process.stdout.columns) || 80);
  const columnCount = sanitizedOptions.length ? Math.max(1, Math.min(columns, sanitizedOptions.length)) : 1;
  const matrix = buildColumnMatrix(sanitizedOptions, columnCount);
  const columnWidths = new Array(columnCount).fill(0);
  matrix.forEach(row => {
    row.forEach((cell, index) => {
      if (cell.length > columnWidths[index]) {
        columnWidths[index] = cell.length;
      }
    });
  });

  const columnWidthTotal = columnWidths.reduce((sum, width) => sum + width, 0);
  let columnGap = columnCount > 1 ? Math.max(2, Math.floor((terminalWidth - columnWidthTotal) / (columnCount * 2))) : 0;
  let optionsContentWidth = columnWidthTotal + columnGap * (columnCount - 1);

  const metaWidth = sanitizedMeta.length ? Math.max(...sanitizedMeta.map(line => line.length)) : 0;
  let contentWidth = Math.max(optionsContentWidth, metaWidth);
  const maxContentWidth = terminalWidth - 12;

  if (contentWidth > maxContentWidth && columnCount > 1) {
    while (columnGap > 1 && contentWidth > maxContentWidth) {
      columnGap -= 1;
      optionsContentWidth = columnWidthTotal + columnGap * (columnCount - 1);
      contentWidth = Math.max(optionsContentWidth, metaWidth);
    }
  }

  contentWidth = Math.min(contentWidth, maxContentWidth);

  let innerPadding = Math.max(2, Math.floor((terminalWidth - contentWidth) / 20));
  while (innerPadding > 1 && contentWidth + innerPadding * 2 + 4 > terminalWidth - 2) {
    innerPadding -= 1;
  }

  const innerWidth = contentWidth + innerPadding * 2;
  const innerBoxWidth = innerWidth + 2;
  let outerWidth = Math.max(innerBoxWidth + 2, (title ? title.length : 0) + 4);
  outerWidth = Math.min(outerWidth, terminalWidth - 2);
  const outerContentWidth = outerWidth - 2;
  const sideSpace = Math.max(0, Math.floor((outerContentWidth - innerBoxWidth) / 2));
  const sideRemainder = Math.max(0, outerContentWidth - innerBoxWidth - sideSpace);

  const outerLines = [];
  outerLines.push(BORDER_DOUBLE.topLeft + repeatChar(BORDER_DOUBLE.horizontal, outerWidth - 2) + BORDER_DOUBLE.topRight);
  outerLines.push(BORDER_DOUBLE.vertical + centerText(title || '', outerWidth - 2) + BORDER_DOUBLE.vertical);
  outerLines.push(BORDER_DOUBLE.vertical + repeatChar(' ', outerWidth - 2) + BORDER_DOUBLE.vertical);

  const innerLines = [];
  innerLines.push(BORDER_SINGLE.topLeft + repeatChar(BORDER_SINGLE.horizontal, innerWidth) + BORDER_SINGLE.topRight);

  sanitizedMeta.forEach(line => {
    const truncated = line.length > contentWidth ? line.slice(0, contentWidth) : line;
    const padded = truncated.padEnd(contentWidth, ' ');
    innerLines.push(
      `${BORDER_SINGLE.vertical}${repeatChar(' ', innerPadding)}${padded}${repeatChar(' ', innerPadding)}${BORDER_SINGLE.vertical}`,
    );
  });

  if (sanitizedMeta.length && matrix.length) {
    innerLines.push(BORDER_SINGLE.vertical + repeatChar(' ', innerWidth) + BORDER_SINGLE.vertical);
  }

  matrix.forEach(row => {
    const segments = row.map((cell, index) => {
      const width = columnWidths[index] || 0;
      const truncated = cell.length > width ? cell.slice(0, width) : cell;
      return truncated.padEnd(width, ' ');
    });
    const joined = segments.join(repeatChar(' ', columnGap));
    const paddedRow = joined.padEnd(contentWidth, ' ');
    innerLines.push(
      `${BORDER_SINGLE.vertical}${repeatChar(' ', innerPadding)}${paddedRow}${repeatChar(' ', innerPadding)}${BORDER_SINGLE.vertical}`,
    );
  });

  innerLines.push(BORDER_SINGLE.bottomLeft + repeatChar(BORDER_SINGLE.horizontal, innerWidth) + BORDER_SINGLE.bottomRight);

  innerLines.forEach(line => {
    const padded = `${repeatChar(' ', sideSpace)}${line}${repeatChar(' ', sideRemainder)}`;
    outerLines.push(BORDER_DOUBLE.vertical + padded.padEnd(outerWidth - 2, ' ') + BORDER_DOUBLE.vertical);
  });

  outerLines.push(BORDER_DOUBLE.vertical + repeatChar(' ', outerWidth - 2) + BORDER_DOUBLE.vertical);
  outerLines.push(BORDER_DOUBLE.bottomLeft + repeatChar(BORDER_DOUBLE.horizontal, outerWidth - 2) + BORDER_DOUBLE.bottomRight);

  const exitPadding = Math.max(2, Math.floor((terminalWidth - exitLabel.length) / 10));
  let exitInnerWidth = exitLabel.length + exitPadding * 2;
  const exitBoxMax = terminalWidth - 4;
  if (exitInnerWidth + 2 > exitBoxMax) {
    exitInnerWidth = Math.max(exitLabel.length + 2, exitBoxMax - 2);
  }

  const exitBoxWidth = exitInnerWidth + 2;
  const exitSide = Math.max(0, Math.floor((terminalWidth - exitBoxWidth) / 2));
  const exitRemainder = Math.max(0, terminalWidth - exitBoxWidth - exitSide);
  const exitLines = [
    repeatChar(' ', exitSide) + BORDER_SINGLE.topLeft + repeatChar(BORDER_SINGLE.horizontal, exitInnerWidth) + BORDER_SINGLE.topRight + repeatChar(' ', exitRemainder),
    repeatChar(' ', exitSide) + BORDER_SINGLE.vertical + centerText(exitLabel, exitInnerWidth) + BORDER_SINGLE.vertical + repeatChar(' ', exitRemainder),
    repeatChar(' ', exitSide) + BORDER_SINGLE.bottomLeft + repeatChar(BORDER_SINGLE.horizontal, exitInnerWidth) + BORDER_SINGLE.bottomRight + repeatChar(' ', exitRemainder),
  ];

  const leftMargin = Math.max(0, Math.floor((terminalWidth - outerWidth) / 2));
  const rightMargin = Math.max(0, terminalWidth - outerWidth - leftMargin);
  const finalLines = outerLines.map(line => `${repeatChar(' ', leftMargin)}${line}${repeatChar(' ', rightMargin)}`);

  const headerTitle = centerText('MADMAXX', terminalWidth);
  const cornerLabel = 'modified by neuviii';
  const cornerLine = terminalWidth > cornerLabel.length
    ? `${repeatChar(' ', terminalWidth - cornerLabel.length)}${cornerLabel}`
    : cornerLabel.slice(0, terminalWidth);

  process.stdout.write('\u001Bc');
  process.stdout.write(`${headerTitle}\n${cornerLine}\n${finalLines.join('\n')}\n\n${exitLines.join('\n')}\n`);
}

const state = {
  tokens: [],
  config: JSON.parse(JSON.stringify(defaultConfig)),
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    return { ...defaultConfig };
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const config = {
      ...defaultConfig,
      ...parsed,
    };

    config.chatter = sanitizeChatterConfig(parsed.chatter || config.chatter);
    return config;
  } catch (err) {
    logger.error('Failed to read config.json. Using defaults.', err);
    return { ...defaultConfig };
  }
}

function saveConfig() {
  const output = {
    ...defaultConfig,
    ...state.config,
    chatter: sanitizeChatterConfig(state.config?.chatter),
  };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(output, null, 2));
    logger.info('Config saved.');
  } catch (err) {
    logger.error('Failed to write config.json.', err);
  }
}

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function pause(message = 'Press enter to continue.') {
  return ask(message);
}

function formatToken(token) {
  return `${token.slice(0, 25)}...`;
}

function parseIndexes(selection, max) {
  return selection
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10) - 1)
    .filter(index => Number.isInteger(index) && index >= 0 && index < max)
    .sort((a, b) => b - a)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function sanitizeChatterConfig(raw = {}) {
  if (!raw || typeof raw !== 'object') return { ...defaultConfig.chatter };

  const tokens = Array.isArray(raw.tokens)
    ? Array.from(new Set(raw.tokens.map(token => (typeof token === 'string' ? token.trim() : String(token || '')).trim()).filter(Boolean)))
    : [];

  const tokenSet = new Set(tokens);

  let channelId = null;
  if (raw.channelId !== undefined && raw.channelId !== null) {
    channelId = String(raw.channelId).trim();
    if (!channelId) channelId = null;
  }

  let delay = Number(raw.messageDelaySec);
  if (!Number.isFinite(delay) || delay < 0) {
    const interval = Number(raw.interval);
    if (Number.isFinite(interval) && interval >= 0) {
      delay = Math.max(0, Math.round(interval / 1000));
    } else {
      delay = defaultConfig.chatter.messageDelaySec;
    }
  } else {
    delay = Math.max(0, Math.round(delay));
  }

  const rawMessages = Array.isArray(raw.messages)
    ? raw.messages
    : raw.message
      ? [raw.message]
      : [];

  const normalized = [];
  let maxId = 0;

  rawMessages.forEach((entry, index) => {
    let text = null;
    let id = null;

    if (typeof entry === 'string') {
      text = entry;
    } else if (entry && typeof entry.text === 'string') {
      text = entry.text;
      if (Number.isInteger(entry.id) && entry.id > 0) {
        id = entry.id;
      } else if (typeof entry.id === 'string') {
        const parsedId = Number.parseInt(entry.id, 10);
        if (Number.isInteger(parsedId) && parsedId > 0) id = parsedId;
      }
    }

    text = typeof text === 'string' ? text.trim() : '';
    if (!text) return;

    if (id) {
      maxId = Math.max(maxId, id);
      normalized.push({ id, text });
    } else {
      normalized.push({ id: null, text });
    }
  });

  if (!normalized.length && typeof raw.message === 'string' && raw.message.trim()) {
    normalized.push({ id: null, text: raw.message.trim() });
  }

  let nextId = maxId > 0 ? maxId + 1 : 1;
  normalized.forEach(msg => {
    if (!Number.isInteger(msg.id) || msg.id <= 0) {
      msg.id = nextId;
      nextId += 1;
    }
  });

  const messageIds = new Set(normalized.map(msg => msg.id));

  const rawAssignments = Array.isArray(raw.assignments) ? raw.assignments : [];
  const assignments = [];

  rawAssignments.forEach(entry => {
    if (!entry) return;
    const token = typeof entry.token === 'string' ? entry.token.trim() : null;
    const messageIdRaw = entry.messageId ?? entry.message_id ?? entry.message ?? entry.id;
    const messageId = Number.parseInt(messageIdRaw, 10);

    if (!token || !tokenSet.has(token)) return;
    if (!Number.isInteger(messageId) || !messageIds.has(messageId)) return;
    if (assignments.some(existing => existing.token === token)) {
      // keep first mapping for token
      return;
    }
    if (assignments.some(existing => existing.messageId === messageId)) {
      return;
    }

    assignments.push({ token, messageId });
  });

  return {
    tokens,
    channelId: channelId || null,
    messageDelaySec: delay,
    messages: normalized,
    dispatchMode:
      typeof raw.dispatchMode === 'string'
        ? raw.dispatchMode
        : typeof raw.randomize === 'boolean'
        ? raw.randomize
          ? 'random'
          : 'sequential'
        : 'random',
    assignments,
  };
}

function applyChatterConfigUpdate(updater) {
  const wasRunning = typeof chatterManager?.isRunning === 'function' && chatterManager.isRunning();
  if (wasRunning) {
    chatterManager.stop();
  }

  const current = state.config?.chatter
    ? {
        ...state.config.chatter,
        tokens: [...state.config.chatter.tokens],
        messages: state.config.chatter.messages.map(msg => ({ ...msg })),
        assignments: state.config.chatter.assignments.map(item => ({ ...item })),
      }
    : {
        ...defaultConfig.chatter,
        tokens: [...defaultConfig.chatter.tokens],
        messages: defaultConfig.chatter.messages.map(msg => ({ ...msg })),
        assignments: defaultConfig.chatter.assignments.map(item => ({ ...item })),
      };

  updater(current);

  state.config.chatter = sanitizeChatterConfig(current);
  chatterManager.configure(state.config.chatter);
  saveConfig();

  if (wasRunning && chatterManager.isConfigured()) {
    chatterManager.start();
    logger.confirm('Chatter restarted with updated configuration.');
  }
}

const TokenManager = {
  load() {
    if (!fs.existsSync(TOKEN_FILE)) return [];
    const fileContent = fs.readFileSync(TOKEN_FILE, 'utf-8');
    const tokens = fileContent
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const unique = Array.from(new Set(tokens)).sort();
    if (unique.length !== tokens.length) {
      fs.writeFileSync(TOKEN_FILE, unique.join('\n'));
      logger.confirm(`Removed ${tokens.length - unique.length} duplicate tokens.`);
    }
    return unique;
  },

  save(tokens) {
    const unique = Array.from(new Set(tokens.filter(Boolean)));
    fs.writeFileSync(TOKEN_FILE, unique.sort().join('\n'));
  },

  async validate(tokens) {
    const valid = [];
    const invalid = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      try {
        await axios.get('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: token },
        });
        logger.confirm(`TOKEN ${i + 1} is valid.`);
        valid.push(token);
      } catch (error) {
        if (error.response && error.response.status === 401) {
          logger.confirm(`TOKEN ${i + 1} is invalid.`);
        } else {
          logger.error(`Error checking token ${i + 1}`, error);
        }
        invalid.push(token);
      }
    }

    return { valid, invalid };
  },
};

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  has(token) {
    return this.sessions.has(token);
  }

  get(token) {
    return this.sessions.get(token);
  }

  all() {
    return Array.from(this.sessions.values());
  }

  create(token) {
    const client = new Client();
    const session = {
      token,
      client,
      ready: false,
      reconnectAttempts: 0,
      voice: {
        state: 'idle',
        guildId: null,
        channelId: null,
      },
    };

    this.sessions.set(token, session);
    return session;
  }

  destroy(token) {
    const session = this.sessions.get(token);
    if (!session) return;

    try {
      session.client.destroy();
    } catch (err) {
      // ignore
    }

    this.sessions.delete(token);
  }

  destroyAll() {
    this.sessions.forEach((_, token) => this.destroy(token));
  }
}

class OnlinePresenceManager {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  start(tokens) {
    tokens.forEach((token, index) => {
      let session = this.sessionManager.get(token);
      if (!session) {
        session = this.sessionManager.create(token);
        this._wireSession(session, index);
      }

      const { client } = session;

      if (client?.ws?.status === 0 && session.ready) {
        try {
          client.user.setStatus('dnd');
        } catch (err) {
          logger.error(`Failed to set status for ${client.user?.tag || formatToken(token)}`, err);
        }
        return;
      }

      client.login(token).catch(err => {
        logger.error(`Login failed for token ${index + 1}`, err);
      });
    });
  }

  _wireSession(session, index) {
    const { client, token } = session;

    client.once('ready', () => {
      session.ready = true;
      logger.confirm(`Token ${index + 1} online as ${client.user.tag}`);
      try {
        client.user.setStatus('dnd');
      } catch (err) {
        logger.error(`Failed to set status for ${client.user.tag}`, err);
      }
    });

    client.on('error', err => {
      logger.error(`Client error for token ${index + 1}`, err);
    });
  }
}

class VoiceConnector {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.active = false;
  }

  toggle(tokens, guildId, vcId) {
    if (!tokens.length) {
      logger.confirm('No tokens available. Use option 2 to manage tokens first.');
      return;
    }
    if (!guildId || !vcId) {
      logger.confirm('Set Guild ID and VC ID first (option 3).');
      return;
    }

    if (this.active) {
      logger.confirm('Leaving VC...');
      this.stop();
    } else {
      logger.confirm('Joining VC...');
      this.start(tokens, guildId, vcId);
    }
  }

  start(tokens, guildId, vcId) {
    this.stop();
    this.active = true;

    tokens.forEach(token => {
      let session = this.sessionManager.get(token);
      if (!session) {
        session = this.sessionManager.create(token);
        onlineManager._wireSession(session, 0);
      }

      session.voice.guildId = guildId;
      session.voice.channelId = vcId;
      session.voice.state = 'connecting';

      session.client.once('ready', () => {
        this._joinVoice(session);
      });

      if (session.ready) {
        this._joinVoice(session);
      } else {
        session.client.login(token).catch(err => {
          console.error(`Login failed for voice token ${formatToken(token)}: ${err.message}`);
        });
      }
    });
  }

  stop() {
    this.active = false;
    this.sessionManager.all().forEach(session => {
      if (session.voice.state !== 'idle') {
        this._sendVoiceUpdate(session, null);
        session.voice.state = 'idle';
        logger.confirm(`[VOICE] ${session.client.user?.tag || formatToken(session.token)} left VC`);
      }
    });
  }

  ensureOnExit(tokens, guildId, vcId) {
    if (this.active) return;
    if (!tokens.length || !guildId || !vcId) return;
    logger.confirm('Starting VC joiner...');
    this.start(tokens, guildId, vcId);
  }

  _joinVoice(session) {
    const { client, voice } = session;
    const guild = client.guilds.cache.get(voice.guildId);
    if (!guild) {
      logger.confirm(`[VOICE] Guild not cached for ${client.user?.tag || formatToken(session.token)}.`);
      return;
    }

    const channel = guild.channels.cache.get(voice.channelId);
    if (!channel) {
      logger.confirm(`[VOICE] Channel not cached for ${client.user?.tag || formatToken(session.token)}.`);
      return;
    }

    voice.state = 'joining';
    this._sendVoiceUpdate(session, voice.channelId);
    logger.confirm(`${client.user?.tag || formatToken(session.token)} requested VC join.`);
  }

  _sendVoiceUpdate(session, channelId) {
    const { client, voice } = session;
    const guild = client.guilds.cache.get(voice.guildId);
    if (!guild) return;
    const shardId = guild.shardId ?? 0;
    const shard = client.ws?.shards?.get?.(shardId) || client.ws?.shards?.first?.();
    if (!shard) {
      logger.confirm(`[VOICE] No shard available for ${client.user?.tag || formatToken(session.token)}.`);
      return;
    }

    shard.send({
      op: 4,
      d: {
        guild_id: voice.guildId,
        channel_id: channelId,
        self_mute: false,
        self_deaf: false,
      },
    });

    try {
      client.user.setStatus('dnd');
    } catch (err) {
      logger.error(`Failed to set status for ${client.user?.tag || formatToken(session.token)}`, err);
    }
  }
}

class ChatterManager {
  constructor() {
    this.config = null;
    this.sessions = [];
    this.timer = null;
    this.active = false;
  }

  configure(config) {
    this.config = sanitizeChatterConfig(config);
  }

  isRunning() {
    return this.active;
  }

  isConfigured() {
    return (
      this.config &&
      Array.isArray(this.config.tokens) &&
      this.config.tokens.length >= 2 &&
      this.config.channelId &&
      Array.isArray(this.config.messages) &&
      this.config.messages.length > 0 &&
      Number.isFinite(Number(this.config.messageDelaySec))
    );
  }

  start() {
    if (!this.isConfigured()) {
      logger.notify('Chatter is not configured. Use option 5 to set it up.');
      return;
    }

    this.stop();
    logger.confirm('Chatter starting...');
    const { tokens, channelId, messageDelaySec, messages, dispatchMode, assignments = [] } = this.config;
    const intervalMs = Math.max(0, Number(messageDelaySec)) * 1000;
    let messageIndex = 0;
    let tokenIndex = 0;
    let assignmentIndex = 0;
    const messageMap = new Map(messages.map(msg => [msg.id, msg]));

    tokens.forEach((token, index) => {
      const client = new Client();
      const session = { client, token, ready: false, channel: null };
      this.sessions.push(session);

      client.once('ready', async () => {
        logger.info(`[Chatter ${index + 1}] Logged in as ${client.user.tag}`);
        try {
          session.channel = await client.channels.fetch(channelId);
          session.ready = true;
          logger.info(`[Chatter ${index + 1}] Ready to send messages.`);
        } catch (err) {
          logger.error(`[Chatter ${index + 1}] Channel fetch failed`, err);
        }
      });

      client.on('error', err => {
        logger.error(`[Chatter ${index + 1}] Client error`, err);
      });

      client.login(token).catch(err => {
        logger.error(`[Chatter ${index + 1}] Login failed`, err);
      });
    });

    const tick = async () => {
      const readySessions = this.sessions.filter(session => session.ready && session.channel);
      if (!readySessions.length) return;

      let session;
      let message;

      const activeAssignments = assignments
        .map(item => ({ ...item }))
        .filter(item => messageMap.has(item.messageId) && readySessions.some(s => s.token === item.token));

      if (dispatchMode === 'assigned') {
        if (!activeAssignments.length) {
          return;
        }
        const current = activeAssignments[assignmentIndex % activeAssignments.length];
        assignmentIndex = (assignmentIndex + 1) % activeAssignments.length;
        message = messageMap.get(current.messageId);
        session = readySessions.find(s => s.token === current.token);
        if (!session || !message) return;
      } else if (activeAssignments.length) {
        const current = activeAssignments[assignmentIndex % activeAssignments.length];
        assignmentIndex = (assignmentIndex + 1) % activeAssignments.length;
        message = messageMap.get(current.messageId);
        session = readySessions.find(s => s.token === current.token);
        if (!session || !message) return;
      } else if (dispatchMode === 'random') {
        session = readySessions[Math.floor(Math.random() * readySessions.length)];
        message = messages[Math.floor(Math.random() * messages.length)];
      } else {
        session = readySessions[tokenIndex % readySessions.length];
        message = messages[messageIndex % messages.length];
        tokenIndex = (tokenIndex + 1) % readySessions.length;
        if (tokenIndex === 0) {
          messageIndex = (messageIndex + 1) % messages.length;
        }
      }

      if (!message || !message.text) return;

      try {
        await session.channel.send(message.text);
        logger.info(
          `[Chatter] Sent message ${message.id} using ${session.client.user?.tag || formatToken(session.token)}`,
        );
      } catch (err) {
        logger.error(
          `[Chatter] Send error for ${session.client.user?.tag || formatToken(session.token)}`,
          err,
        );
      }
    };

    const effectiveInterval = intervalMs === 0 ? 500 : intervalMs;
    this.timer = setInterval(tick, effectiveInterval || 500);

    this.active = true;
  }

  stop() {
    this.sessions.forEach(({ client }) => {
      try {
        client.destroy();
      } catch (err) {
        // ignore
      }
    });
    this.sessions = [];
    const wasActive = this.active;
    this.active = false;
    if (wasActive) {
      logger.confirm('Chatter stopped.');
    }
  }
}

const sessionManager = new SessionManager();
const onlineManager = new OnlinePresenceManager(sessionManager);
const voiceConnector = new VoiceConnector(sessionManager);
const chatterManager = new ChatterManager();

async function handleLoginOnline() {
  if (!state.tokens.length) {
    console.log('No tokens loaded. Use option 2 to manage tokens first.');
    await pause();
    return;
  }

  onlineManager.start(state.tokens);
  await pause('Tokens are now online. Press enter to continue.');
}

async function handleManageTokens() {
  state.tokens = TokenManager.load();

  const { valid } = await TokenManager.validate(state.tokens);
  state.tokens = valid;
  TokenManager.save(state.tokens);

  if (!state.tokens.length) {
    console.log('No valid tokens found.');
  } else {
    console.log('Current valid tokens:');
    state.tokens.forEach((token, index) => {
      console.log(`${index + 1}: ${formatToken(token)}`);
    });
  }

  const addMore = (await ask('Add more tokens? (y/n): ')).trim().toLowerCase();
  if (addMore === 'y') {
    const newTokens = [];
    while (true) {
      const token = await ask('Enter new token (0 to finish): ');
      if (token === '0') break;
      if (token.trim()) newTokens.push(token.trim());
    }

    if (newTokens.length) {
      const { valid: newValid } = await TokenManager.validate(newTokens);
      if (newValid.length) {
        state.tokens = Array.from(new Set([...state.tokens, ...newValid]));
        TokenManager.save(state.tokens);
        console.log('New tokens added.');
      }
    }
  }

  if (state.tokens.length) {
    const remove = await ask('Remove tokens by numbers (comma-separated, 0 to skip): ');
    if (remove !== '0') {
      const indexes = parseIndexes(remove, state.tokens.length);
      if (indexes.length) {
        indexes.forEach(index => state.tokens.splice(index, 1));
        TokenManager.save(state.tokens);
        console.log('Tokens removed.');
      } else {
        console.log('No valid selection made.');
      }
    }
  }
}

async function handleGuildAndVc() {
  const currentGuild = state.config.guildId || 'not set';
  const currentVc = state.config.vcId || 'not set';

  const guildInput = await ask(`Enter Guild ID (current: ${currentGuild}, leave blank to keep): `);
  const vcInput = await ask(`Enter VC ID (current: ${currentVc}, leave blank to keep): `);

  if (guildInput && guildInput.trim()) {
    state.config.guildId = guildInput.trim();
  }
  if (vcInput && vcInput.trim()) {
    state.config.vcId = vcInput.trim();
  }

  saveConfig();
  console.log(`Guild ID: ${state.config.guildId || 'not set'}, VC ID: ${state.config.vcId || 'not set'}`);
}

async function handleJoinServer() {
  if (!state.tokens.length) {
    console.log('No tokens available. Use option 2 to manage tokens first.');
    await pause();
    return;
  }

  const inviteLink = await ask('Enter guild invite link: ');
  const code = inviteLink.split('/').pop()?.split('?')[0];

  if (!code) {
    console.log('Invalid invite link.');
    await pause();
    return;
  }

  let successCount = 0;
  let failureCount = 0;
  let solver = null;
  if (state.config.anticaptchaKey) {
    solver = new AntiCaptcha(state.config.anticaptchaKey);
  }

  for (let i = 0; i < state.tokens.length; i += 1) {
    const token = state.tokens[i];
    try {
      const response = await axios.post(`https://discord.com/api/v10/invites/${code}`, {}, {
        headers: { Authorization: token },
      });
      successCount += 1;
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;

      if (status === 400 && data?.captcha_key && solver) {
        // Attempt to solve captcha
        try {
          console.log(`Solving captcha for token ${i + 1}...`);
          const result = await solver.hcaptcha(data.captcha_sitekey, 'https://discord.com', {
            rqdata: data.captcha_rqdata,
          });
          const captchaKey = result.solution.text;

          // Retry join with captcha
          await axios.post(`https://discord.com/api/v10/invites/${code}`, {
            captcha_key: captchaKey,
            captcha_rqdata: data.captcha_rqdata,
            captcha_rqtoken: data.captcha_rqtoken,
          }, {
            headers: { Authorization: token },
          });
          successCount += 1;
          console.log(`Token ${i + 1} joined after solving captcha.`);
        } catch (captchaErr) {
          failureCount += 1;
          console.error(`Token ${i + 1} captcha solve failed: ${captchaErr.message}`);
        }
      } else {
        failureCount += 1;
        const detail = status ? `${status} ${JSON.stringify(data)}` : err.message;
        console.error(`Token ${i + 1} failed: ${detail}`);
      }
    }
  }

  console.log(`Join summary: ${successCount} succeeded, ${failureCount} failed.`);
  await pause();
}

async function handleChatterMenu() {
  await showChatterMenu();
}

async function showChatterMenu() {
  let exit = false;
  while (!exit) {
    const config = state.config.chatter;
    const metaLines = [
      `Tokens: ${config.tokens.length || 0}`,
      `Channel ID: ${config.channelId || 'not set'}`,
      `Delay: ${config.messageDelaySec}s`,
      `Messages: ${config.messages.length}`,
      `Assignments: ${config.assignments.length}`,
      `Dispatch Mode: ${config.dispatchMode}`,
    ];

    renderAdaptiveMenu({
      title: 'Chatter Menu',
      metaLines,
      options: [
        { key: '1', label: 'Manage tokens' },
        { key: '2', label: 'Check tokens in guild' },
        { key: '3', label: 'Set message delay (seconds)' },
        { key: '4', label: 'Dispatch mode (Random / Order / Assigned)' },
        { key: '5', label: 'Messages config' },
        { key: '6', label: 'Token-message assignments' },
      ],
      columns: 1,
      exitLabel: '[0] BACK',
    });

    const choice = (await ask('Select option: ')).trim();
    switch (choice) {
      case '1':
        await showChatterTokensMenu();
        break;
      case '2':
        await checkChatterTokensInGuild();
        break;
      case '3':
        await configureChatterDelay();
        break;
      case '4':
        await configureChatterDispatchMode();
        break;
      case '5':
        await showMessageConfigMenu();
        break;
      case '6':
        await manageChatterAssignments();
        break;
      case '0':
        exit = true;
        break;
      default:
        logger.confirm('Invalid option.');
        await pause();
    }
  }
}

async function showChatterTokensMenu() {
  let exit = false;
  while (!exit) {
    renderAdaptiveMenu({
      title: 'Chatter Tokens Menu',
      options: [
        { key: '1', label: 'List tokens' },
        { key: '2', label: 'Add tokens' },
        { key: '3', label: 'Remove tokens' },
        { key: '4', label: 'Set channel ID' },
      ],
      columns: 1,
      exitLabel: '[0] BACK',
    });

    const choice = (await ask('Select option: ')).trim();
    switch (choice) {
      case '1':
        await listChatterTokens();
        break;
      case '2':
        await addChatterTokens();
        break;
      case '3':
        await removeChatterTokens();
        break;
      case '4':
        await setChatterChannelId();
        break;
      case '0':
        exit = true;
        break;
      default:
        logger.confirm('Invalid option.');
        await pause();
    }
  }
}

async function listChatterTokens() {
  const tokens = state.config.chatter.tokens;
  if (!tokens.length) {
    logger.confirm('No chatter tokens configured.');
  } else {
    emitLines([
      'Chatter tokens:',
      ...tokens.map((token, index) => `${index + 1}: ${formatToken(token)}`),
    ]);
  }
  await pause();
}

async function addChatterTokens() {
  const newTokens = [];
  while (true) {
    const token = await ask('Enter chatter token (0 to finish): ');
    if (token === '0') break;
    const trimmed = token.trim();
    if (trimmed) newTokens.push(trimmed);
  }

  if (!newTokens.length) {
    logger.confirm('No tokens added.');
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    config.tokens = Array.from(new Set([...config.tokens, ...newTokens]));
  });
  logger.confirm(`Added ${newTokens.length} chatter token(s). Total now: ${state.config.chatter.tokens.length}.`);
  await pause();
}

async function removeChatterTokens() {
  const tokens = state.config.chatter.tokens;
  if (!tokens.length) {
    logger.confirm('No chatter tokens to remove.');
    await pause();
    return;
  }

  emitLines(tokens.map((token, index) => `${index + 1}: ${formatToken(token)}`));
  const selection = await ask('Remove tokens by numbers (comma-separated, 0 to cancel): ');
  if (selection === '0') {
    logger.confirm('No tokens removed.');
    await pause();
    return;
  }

  const indexes = parseIndexes(selection, tokens.length);
  if (!indexes.length) {
    logger.confirm('No valid selection made.');
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    indexes.forEach(idx => config.tokens.splice(idx, 1));
  });
  logger.confirm('Selected chatter tokens removed.');
  await pause();
}

async function setChatterChannelId() {
  const current = state.config.chatter.channelId || 'not set';
  const input = await ask(`Enter chatter channel ID (current: ${current}): `);
  const trimmed = input.trim();

  if (!trimmed) {
    logger.confirm(`Chatter channel remains: ${state.config.chatter.channelId || 'not set'}.`);
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    const lower = trimmed.toLowerCase();
    if (['clear', 'none', 'null', '0'].includes(lower)) {
      config.channelId = null;
    } else {
      config.channelId = trimmed;
    }
  });
  logger.confirm(`Chatter channel set to: ${state.config.chatter.channelId || 'not set'}.`);
  await pause();
}

async function handleSetChatterChannel() {
  await setChatterChannelId();
}

async function checkChatterTokensInGuild() {
  const tokens = state.config.chatter.tokens;
  if (!tokens.length) {
    console.log('No chatter tokens configured.');
    await pause();
    return;
  }

  const guildId = (await ask('Enter Guild ID to check: ')).trim();
  if (!guildId) {
    console.log('Guild ID is required.');
    await pause();
    return;
  }

  const present = [];
  const missing = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    try {
      await axios.get(`https://discord.com/api/v10/guilds/${guildId}/members/@me`, {
        headers: { Authorization: token },
      });
      present.push({ index: i, token });
    } catch (err) {
      const status = err.response?.status;
      const detail = status ? `${status} ${JSON.stringify(err.response?.data)}` : err.message;
      missing.push({ index: i, token, detail });
    }
  }

  if (present.length) {
    console.log('Tokens that ARE in the guild:');
    present.forEach(entry => {
      console.log(`[${entry.index + 1}] ${formatToken(entry.token)}`);
    });
  } else {
    console.log('No chatter tokens are currently in the guild.');
  }

  if (missing.length) {
    console.log('Tokens NOT in the guild:');
    missing.forEach(entry => {
      console.log(`[${entry.index + 1}] ${formatToken(entry.token)} -> ${entry.detail}`);
    });
  }

  await pause();
}

async function configureChatterDelay() {
  const current = state.config.chatter.messageDelaySec;
  const input = await ask(`Enter message delay in seconds (current: ${current}): `);
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    console.log('Invalid delay. Please enter a number >= 0.');
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    config.messageDelaySec = Math.max(0, Math.round(value));
  });
  console.log(`Message delay set to ${state.config.chatter.messageDelaySec}s.`);
  await pause();
}

async function configureChatterDispatchMode() {
  const current = state.config.chatter.dispatchMode || 'random';
  const choices = [
    { key: '1', mode: 'random', label: 'Random (random token + random message)' },
    { key: '2', mode: 'sequential', label: 'Order (rotate tokens/messages)' },
    { key: '3', mode: 'assigned', label: 'Assigned only (use token-message mappings)' },
  ];

  renderAdaptiveMenu({
    title: 'Chatter Dispatch Mode',
    metaLines: [`Current mode: ${current}`],
    options: choices.map(item => ({ key: item.key, label: item.label })),
    columns: 1,
    exitLabel: '[0] BACK',
  });

  const choice = (await ask('Select mode: ')).trim();
  if (choice === '0') {
    return;
  }

  const selected = choices.find(item => item.key === choice);
  if (!selected) {
    logger.confirm('Invalid mode selected.');
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    config.dispatchMode = selected.mode;
  });

  logger.confirm(`Chatter dispatch mode set to: ${selected.mode}.`);
  await pause();
}

async function toggleChatterRandomMode() {
  const current = state.config.chatter.randomize;
  applyChatterConfigUpdate(config => {
    config.randomize = !current;
  });
  console.log(`Random mode is now ${state.config.chatter.randomize ? 'enabled (random token/message)' : 'disabled (rotating order)'}.`);
  await pause();
}

async function manageChatterAssignments() {
  const tokens = state.config.chatter.tokens;
  const messages = state.config.chatter.messages;
  if (!tokens.length || !messages.length) {
    console.log('Assignments require tokens and messages. Add those first.');
    await pause();
    return;
  }

  console.log('Chatter tokens:');
  tokens.forEach((token, index) => {
    console.log(`${index + 1}: ${formatToken(token)}`);
  });
  printChatterAssignments();
  printChatterMessages();

  console.log('Enter assignments as "<token> <messageId>".');
  console.log('Use the same token+message to remove an existing mapping.');
  console.log('Use the same token with a different message ID to update the mapping.');
  console.log('Type 0 to finish.');

  const messageMap = new Map(messages.map(msg => [msg.id, msg]));

  while (true) {
    const input = await ask('Assignment: ');
    if (input === null || input === undefined) break;
    const trimmed = input.trim();
    if (trimmed === '0') break;
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      console.log('Provide token and message ID separated by space.');
      continue;
    }

    const tokenInput = parts[0].trim();
    const messageIdInput = parts[1].trim();
    let tokenValue = tokenInput;

    if (!tokens.includes(tokenValue)) {
      const numeric = Number.parseInt(tokenInput, 10);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= tokens.length) {
        tokenValue = tokens[numeric - 1];
      }
    }

    if (!tokens.includes(tokenValue)) {
      console.log('Token not part of chatter tokens. Use index or full token.');
      continue;
    }

    const messageId = Number.parseInt(messageIdInput, 10);
    if (!Number.isInteger(messageId) || !messageMap.has(messageId)) {
      console.log('Message ID not found.');
      continue;
    }

    const currentAssignments = state.config.chatter.assignments;
    const existingEntry = currentAssignments.find(item => item.token === tokenValue);
    const exactMatch = existingEntry?.messageId === messageId;
    const messageAlreadyTaken = currentAssignments.find(item => item.messageId === messageId && item.token !== tokenValue);

    if (messageAlreadyTaken) {
      console.log(`Message ${messageId} already assigned to another token. Remove that first.`);
      continue;
    }

    if (exactMatch) {
      applyChatterConfigUpdate(config => {
        config.assignments = config.assignments.filter(item => !(item.token === tokenValue && item.messageId === messageId));
      });
      console.log('Assignment removed.');
    } else {
      applyChatterConfigUpdate(config => {
        const filtered = config.assignments.filter(item => item.token !== tokenValue);
        config.assignments = filtered;
        config.assignments.push({ token: tokenValue, messageId });
      });
      console.log(`Assignment set: ${formatToken(tokenValue)} -> message ${messageId}.`);
    }

    printChatterAssignments();
  }

  await pause();
}

async function showMessageConfigMenu() {
  let exit = false;
  while (!exit) {
    console.log('\nChatter Messages Menu:');
    console.log('1: List messages');
    console.log('2: Remove message');
    console.log('3: Add message');
    console.log('0: Back');

    const choice = await ask('Select option: ');
    switch (choice) {
      case '1':
        await listChatterMessages();
        break;
      case '2':
        await removeChatterMessage();
        break;
      case '3':
        await addChatterMessage();
        break;
      case '0':
        exit = true;
        break;
      default:
        console.log('Invalid option.');
    }
  }
}

function printChatterMessages() {
  const messages = state.config.chatter.messages;
  if (!messages.length) {
    console.log('No chatter messages configured.');
    return false;
  }

  console.log('Chatter messages:');
  messages.forEach(message => {
    console.log(`[${message.id}] ${message.text}`);
  });
  return true;
}

async function listChatterMessages() {
  printChatterMessages();
  await pause();
}

function printChatterAssignments() {
  const { assignments, messages } = state.config.chatter;
  if (!assignments.length) {
    console.log('No chatter assignments configured.');
    return false;
  }

  const messageMap = new Map(messages.map(message => [message.id, message.text]));
  console.log('Chatter assignments:');
  assignments.forEach((assignment, index) => {
    const text = messageMap.get(assignment.messageId) || '(message missing)';
    console.log(`${index + 1}: ${formatToken(assignment.token)} -> [${assignment.messageId}] ${text}`);
  });
  return true;
}

async function removeChatterMessage() {
  const messages = state.config.chatter.messages;
  if (!messages.length) {
    console.log('No chatter messages to remove.');
    await pause();
    return;
  }

  printChatterMessages();
  const input = await ask('Enter message ID to remove (0 to cancel): ');
  if (input === '0') {
    console.log('No messages removed.');
    await pause();
    return;
  }

  const id = Number.parseInt(input, 10);
  if (!Number.isInteger(id) || id <= 0) {
    console.log('Invalid message ID.');
    await pause();
    return;
  }

  const exists = messages.some(message => message.id === id);
  if (!exists) {
    console.log(`Message with ID ${id} not found.`);
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    config.messages = config.messages.filter(message => message.id !== id);
  });
  console.log(`Message ${id} removed.`);
  await pause();
}

async function addChatterMessage() {
  const input = await ask('Enter new message (leave blank to cancel): ');
  const text = input.trim();
  if (!text) {
    console.log('No message added.');
    await pause();
    return;
  }

  applyChatterConfigUpdate(config => {
    config.messages = config.messages || [];
    config.messages.push({ id: null, text });
  });

  const added = state.config.chatter.messages[state.config.chatter.messages.length - 1];
  console.log(`Added message [${added.id}]: ${added.text}`);
  await pause();
}

async function handleToggleChatter() {
  if (!chatterManager.isConfigured()) {
    console.log('Chatter is not configured. Use option 5 to configure tokens/messages first.');
    await pause();
    return;
  }

  if (chatterManager.isRunning()) {
    chatterManager.stop();
    console.log('Chatter stopped.');
  } else {
    chatterManager.start();
    console.log('Chatter started.');
  }

  await pause();
}

async function handleVoiceToggle() {
  voiceConnector.toggle(state.tokens, state.config.guildId, state.config.vcId);
  await pause();
}

async function handleLeaveServer() {
  if (!state.tokens.length) {
    console.log('No tokens available. Use option 2 to manage tokens first.');
    await pause();
    return;
  }

  const guild = await ask('Enter Guild ID to leave: ');
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < state.tokens.length; i += 1) {
    const token = state.tokens[i];
    try {
      await axios.delete(`https://discord.com/api/v10/users/@me/guilds/${guild}`, {
        headers: { Authorization: token },
      });
      successCount += 1;
    } catch (err) {
      failureCount += 1;
      const code = err.response?.status;
      const data = err.response?.data;
      const detail = code ? `${code} ${JSON.stringify(data)}` : err.message;
      console.error(`Token ${i + 1} failed: ${detail}`);
    }
  }

  console.log(`Leave summary: ${successCount} succeeded, ${failureCount} failed.`);
  await pause();
}

async function handleListTokens() {
  const originalTokens = TokenManager.load();
  if (!originalTokens.length) {
    console.log('No tokens found.');
    await pause();
    return;
  }

  const { valid, invalid } = await TokenManager.validate(originalTokens);
  state.tokens = valid;

  if (!invalid.length && !valid.length) {
    console.log('No tokens found.');
    await pause();
    return;
  }

  console.log('Tokens:');
  invalid.forEach((token, index) => console.log(`${index + 1}: ${formatToken(token)} (INVALID)`));
  valid.forEach((token, index) => console.log(`${invalid.length + index + 1}: ${formatToken(token)} (VALID)`));

  if (invalid.length) {
    const remove = await ask('Remove invalid tokens by numbers (comma-separated, 0 to skip): ');
    if (remove !== '0') {
      const indexes = parseIndexes(remove, invalid.length);
      if (indexes.length) {
        const remainingInvalid = invalid.filter((_, idx) => !indexes.includes(idx));
        const updatedTokens = [...remainingInvalid, ...valid];
        TokenManager.save(updatedTokens);
        state.tokens = valid;
        console.log('Invalid tokens removed.');
      } else {
        console.log('No invalid tokens removed.');
      }
    } else {
      TokenManager.save([...invalid, ...valid]);
      state.tokens = valid;
    }
  } else {
    TokenManager.save(valid);
    state.tokens = valid;
    console.log('No invalid tokens found.');
  }

  await pause();
}

const menuOptions = [
  { key: '1', label: 'Login and online tokens', action: handleLoginOnline },
  { key: '2', label: 'Manage tokens', action: handleManageTokens },
  { key: '3', label: 'Guild ID and VC ID', action: handleGuildAndVc },
  { key: '4', label: 'Join server', action: handleJoinServer },
  { key: '5', label: 'Chatter config', action: handleChatterMenu },
  { key: '6', label: 'Join/Leave VC', action: handleVoiceToggle },
  { key: '7', label: 'Leave server', action: handleLeaveServer },
  { key: '8', label: 'List tokens', action: handleListTokens },
  { key: '9', label: 'Toggle chatter', action: handleToggleChatter },
  { key: '10', label: 'Set chatter channel', action: handleSetChatterChannel },
];

async function mainMenu() {
  state.tokens = TokenManager.load();
  logger.confirm(`Loaded ${state.tokens.length} tokens from tokens.txt`);

  let exitRequested = false;
  while (!exitRequested) {
    const metaLines = [
      `Tokens Loaded: ${state.tokens.length}`,
      `Guild ID: ${state.config.guildId || 'not set'}`,
      `VC ID: ${state.config.vcId || 'not set'}`,
      `Chatter Mode: ${state.config.chatter?.dispatchMode || 'random'}`,
    ];

    renderAdaptiveMenu({
      title: '> VC HAVIC <',
      metaLines,
      options: menuOptions.map(option => ({ key: option.key, label: option.label })),
      columns: 2,
      exitLabel: '[0] EXIT',
    });

    const choice = (await ask('Select option: ')).trim();
    if (choice === '0') {
      exitRequested = true;
      continue;
    }

    const option = menuOptions.find(item => item.key === choice);
    if (!option) {
      logger.confirm('Invalid option.');
      await pause();
      continue;
    }

    await option.action();
  }

  rl.close();

  voiceConnector.ensureOnExit(state.tokens, state.config.guildId, state.config.vcId);
}

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Cleaning up...');
  rl.close();
  voiceConnector.stop();
  chatterManager.stop();
  onlineManager.stop();
  process.exit(0);
});

(async () => {
  state.config = loadConfig();
  if (state.config.chatter) {
    chatterManager.configure(state.config.chatter);
  }
  await mainMenu();
})();
