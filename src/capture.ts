import screenshot from 'screenshot-desktop';

export interface CaptureDeps {
  capture?: (options: { format: 'png' | 'jpg'; screen?: string }) => Promise<Buffer>;
  listDisplays?: () => Promise<Array<{ id: string }>>;
  post?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export function sanitize(text: string, secret?: string): string {
  if (!text) return '';
  if (secret && secret.trim().length > 0) {
    return text.replaceAll(secret.trim(), '[REDACTED]');
  }
  return text;
}

function formatLogTimestamp(d: Date): string {
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const hr = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const se = String(d.getSeconds()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${da} ${hr}:${mi}:${se}`;
}

function extractRetryAfterMs(res: Response, bodyText: string): number {
  try {
    const data = JSON.parse(bodyText);
    if (typeof data.retry_after === 'number' && Number.isFinite(data.retry_after) && data.retry_after >= 0) {
      return Math.ceil(data.retry_after * 1000);
    }
  } catch {}

  const header = res.headers.get('Retry-After');
  if (header) {
    const sec = parseFloat(header);
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.ceil(sec * 1000);
    }
  }

  return 1000;
}

// ponytail: 1-based display index selection; add per-display cropping when partial-screen region capture needed.
export async function runCapture(deps: CaptureDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken || botToken.trim().length === 0) {
    throw new Error('DISCORD_BOT_TOKEN is required');
  }

  const channelId = env.DISCORD_CHANNEL_ID?.trim();
  if (!channelId || !/^\d+$/.test(channelId)) {
    throw new Error('Valid DISCORD_CHANNEL_ID is required');
  }

  const endpoint = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const rawFormat = (env.SCREENSHOT_FORMAT || 'png').toLowerCase();
  if (rawFormat !== 'png' && rawFormat !== 'jpg') {
    throw new Error("Invalid SCREENSHOT_FORMAT: must be 'png' or 'jpg'");
  }
  const format: 'png' | 'jpg' = rawFormat;

  const timezone = env.TIMEZONE || 'Asia/Jakarta';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new Error(`Invalid TIMEZONE: ${timezone}`);
  }

  const prefix = env.DISCORD_MESSAGE_PREFIX !== undefined ? env.DISCORD_MESSAGE_PREFIX.trim() : 'Screen capture';
  const body = (env.DISCORD_MESSAGE_BODY ?? '').trim();

  const rawDisplay = env.SCREENSHOT_DISPLAY?.trim();
  let screenId: string | undefined;
  if (rawDisplay && rawDisplay.length > 0) {
    const displayIndex = parseInt(rawDisplay, 10);
    if (!Number.isInteger(displayIndex) || displayIndex < 1) {
      throw new Error(`Invalid SCREENSHOT_DISPLAY: must be a positive integer (1-based index)`);
    }
    const listFn = deps.listDisplays ?? screenshot.listDisplays;
    const displays = await listFn();
    if (displayIndex > displays.length) {
      throw new Error(`Invalid SCREENSHOT_DISPLAY: index ${displayIndex} exceeds ${displays.length} available display(s)`);
    }
    screenId = String(displays[displayIndex - 1].id);
  }

  const captureFn = deps.capture ?? screenshot;
  let buffer: Buffer;
  try {
    buffer = await captureFn({ format, ...(screenId ? { screen: screenId } : {}) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Capture failed: ${msg}`);
  }

  if (!buffer || buffer.length === 0) {
    throw new Error('Capture failed: screenshot buffer is empty');
  }

  const nowFn = deps.now ?? (() => new Date());
  const postFn = deps.post ?? fetch;
  const sleepFn = deps.sleep ?? (async (ms: number) => { await Bun.sleep(ms); });
  const logFn = deps.log ?? console.log;

  const captureDate = nowFn();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  const displayTime = formatter.format(captureDate);
  const parts: string[] = [];
  if (prefix.length > 0) parts.push(prefix);
  if (body.length > 0) parts.push(body);
  parts.push(`Time: ${displayTime}`);
  const content = '\n' + parts.join('\n');
  // ponytail: allowed_mentions parses only users; add 'roles' when role mentions needed.
  const payloadJson = JSON.stringify({ content, allowed_mentions: { parse: ['users'] } });
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const formData = new FormData();
    formData.append('payload_json', payloadJson);
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
    formData.append('files[0]', blob, `screenshot.${format}`);

    try {
      const res = await postFn(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken.trim()}` },
        body: formData,
      });
      if (res.ok) {
        logFn(`[${formatLogTimestamp(nowFn())}] Screenshot uploaded successfully.`);
        return;
      }

      const bodyText = await res.text().catch(() => '');
      const isRetryable = res.status === 429 || [500, 502, 503, 504].includes(res.status);

      if (attempt === 1 && isRetryable) {
        const delayMs = res.status === 429 ? extractRetryAfterMs(res, bodyText) : 1000;
        await sleepFn(delayMs);
        continue;
      }

      const cleanBody = sanitize(bodyText, botToken.trim());
      const detail = cleanBody.length > 0 ? `\n${cleanBody}` : '';
      throw new Error(`Discord upload failed: HTTP ${res.status}${detail}`);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Discord upload failed: HTTP')) {
        throw err;
      }

      if (attempt === 1) {
        await sleepFn(1000);
        continue;
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      const cleanMsg = sanitize(rawMsg, botToken.trim());
      throw new Error(`Discord upload failed: ${cleanMsg}`);
    }
  }
}

if (import.meta.main) {
  runCapture().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exitCode = 1;
  });
}
