import { describe, expect, test } from 'bun:test';
import { runCapture, sanitize } from './capture';

const DUMMY_BOT_TOKEN = 'MTIzNDU2Nzg5MDEy.ABCDEF.abcdefghij123456789012345678';
const DUMMY_CHANNEL_ID = '9876543210';
const FAKE_PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeBaseDeps() {
  const posts: { url: string; init: RequestInit; body: FormData }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];

  return {
    posts,
    sleeps,
    logs,
    deps: {
      capture: async (_options: { format: 'png' | 'jpg'; screen?: string }) => Buffer.from(FAKE_PNG_BYTES),
      listDisplays: async () => [{ id: '\\\\.\\DISPLAY1' }, { id: '\\\\.\\DISPLAY2' }],
      post: (async (url: string | URL | Request, init?: RequestInit) => {
        posts.push({ url: String(url), init: init!, body: init?.body as FormData });
        return new Response('', { status: 204 });
      }) as unknown as typeof fetch,
      env: {
        DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN,
        DISCORD_CHANNEL_ID: DUMMY_CHANNEL_ID,
        TIMEZONE: 'Asia/Jakarta',
        SCREENSHOT_FORMAT: 'png',
        DISCORD_MESSAGE_PREFIX: 'Test capture',
        DISCORD_MESSAGE_BODY: 'PIC: <@1324595214119211070>',
      },
      now: () => new Date('2024-05-18T09:00:00+07:00'),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: (msg: string) => {
        logs.push(msg);
      },
    },
  };
}

describe('runCapture', () => {
  test('end-to-end success uploads multipart payload with content and screenshot bytes', async () => {
    const { deps, posts, logs } = makeBaseDeps();
    await runCapture(deps);

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`https://discord.com/api/v10/channels/${DUMMY_CHANNEL_ID}/messages`);
    expect(posts[0].init.headers).toEqual({ Authorization: `Bot ${DUMMY_BOT_TOKEN}` });
    const formData = posts[0].body;
    expect(formData).toBeInstanceOf(FormData);

    const payloadRaw = formData.get('payload_json') as string;
    expect(payloadRaw).toBeDefined();
    const payload = JSON.parse(payloadRaw);
    expect(payload.content).toBe('\nTest capture\nPIC: <@1324595214119211070>\nTime: 18 May 2024, 09:00:00 GMT+7');
    expect(payload.content).not.toContain('PC:');
    expect(payload.allowed_mentions).toEqual({ parse: ['users'] });

    const file = formData.get('files[0]') as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('image/png');
    const arrayBuffer = await file.arrayBuffer();
    expect(new Uint8Array(arrayBuffer)).toEqual(FAKE_PNG_BYTES);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Screenshot uploaded successfully\.$/);
  });
  test('omits body line when DISCORD_MESSAGE_BODY is empty or unset', async () => {
    const { deps, posts } = makeBaseDeps();
    delete deps.env.DISCORD_MESSAGE_BODY;
    await runCapture(deps);
    const payload = JSON.parse(posts[0].body.get('payload_json') as string);
    expect(payload.content).toBe('\nTest capture\nTime: 18 May 2024, 09:00:00 GMT+7');
  });


  test('passes selected display screen ID to capture function', async () => {
    const { deps } = makeBaseDeps();
    deps.env.SCREENSHOT_DISPLAY = '2';
    let capturedScreen: string | undefined;
    deps.capture = async (options: { format: 'png' | 'jpg'; screen?: string }) => {
      capturedScreen = options.screen;
      return Buffer.from(FAKE_PNG_BYTES);
    };

    await runCapture(deps);

    expect(capturedScreen).toBe('\\\\.\\DISPLAY2');
  });

  test('429 rate limit retries once using retry_after delay with fresh FormData', async () => {
    const { deps, posts, sleeps } = makeBaseDeps();
    let calls = 0;
    deps.post = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), init: init!, body: init?.body as FormData });
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ retry_after: 0.5, message: 'You are being rate limited.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;

    await runCapture(deps);

    expect(calls).toBe(2);
    expect(posts).toHaveLength(2);
    expect(posts[0].body).not.toBe(posts[1].body);
    expect(sleeps).toEqual([500]);
  });

  test('500 server error retries once with 1 second delay', async () => {
    const { deps, posts, sleeps } = makeBaseDeps();
    let calls = 0;
    deps.post = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), init: init!, body: init?.body as FormData });
      calls++;
      if (calls === 1) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await runCapture(deps);

    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  test('400 client error fails immediately without retry', async () => {
    const { deps, sleeps } = makeBaseDeps();
    let calls = 0;
    deps.post = (async () => {
      calls++;
      return new Response(JSON.stringify({ message: 'Cannot send empty message' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(runCapture(deps)).rejects.toThrow('Discord upload failed: HTTP 400');
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  test('scrubs bot token on error response and network failures', async () => {
    const { deps } = makeBaseDeps();
    deps.post = (async () => {
      return new Response(`Error connecting with ${DUMMY_BOT_TOKEN}`, { status: 403 });
    }) as unknown as typeof fetch;

    await expect(runCapture(deps)).rejects.toThrow(
      'Discord upload failed: HTTP 403\nError connecting with [REDACTED]'
    );

    deps.post = (async () => {
      throw new Error(`fetch failed with ${DUMMY_BOT_TOKEN}`);
    }) as unknown as typeof fetch;

    await expect(runCapture(deps)).rejects.toThrow(
      'Discord upload failed: fetch failed with [REDACTED]'
    );
  });

  test('fails validation before capture on missing or invalid configuration', async () => {
    let captureCalled = false;
    const capture = async () => {
      captureCalled = true;
      return Buffer.from(FAKE_PNG_BYTES);
    };

    const emptyEnvDeps = { ...makeBaseDeps().deps, capture, env: {} };
    await expect(runCapture(emptyEnvDeps)).rejects.toThrow('DISCORD_BOT_TOKEN is required');

    const missingChanDeps = {
      ...makeBaseDeps().deps,
      capture,
      env: { DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN },
    };
    await expect(runCapture(missingChanDeps)).rejects.toThrow('Valid DISCORD_CHANNEL_ID is required');

    const invalidChanDeps = {
      ...makeBaseDeps().deps,
      capture,
      env: { DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN, DISCORD_CHANNEL_ID: 'not-a-number' },
    };
    await expect(runCapture(invalidChanDeps)).rejects.toThrow('Valid DISCORD_CHANNEL_ID is required');

    const invalidFmtDeps = {
      ...makeBaseDeps().deps,
      capture,
      env: { DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN, DISCORD_CHANNEL_ID: DUMMY_CHANNEL_ID, SCREENSHOT_FORMAT: 'bmp' },
    };
    await expect(runCapture(invalidFmtDeps)).rejects.toThrow("Invalid SCREENSHOT_FORMAT: must be 'png' or 'jpg'");

    const invalidTzDeps = {
      ...makeBaseDeps().deps,
      capture,
      env: { DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN, DISCORD_CHANNEL_ID: DUMMY_CHANNEL_ID, TIMEZONE: 'Mars/Phobos' },
    };
    await expect(runCapture(invalidTzDeps)).rejects.toThrow('Invalid TIMEZONE: Mars/Phobos');

    const invalidDisplayDeps = {
      ...makeBaseDeps().deps,
      capture,
      listDisplays: async () => [{ id: '\\\\.\\DISPLAY1' }],
      env: { DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN, DISCORD_CHANNEL_ID: DUMMY_CHANNEL_ID, SCREENSHOT_DISPLAY: '3' },
    };
    await expect(runCapture(invalidDisplayDeps)).rejects.toThrow(
      'Invalid SCREENSHOT_DISPLAY: index 3 exceeds 1 available display(s)'
    );

    const nonNumericDisplayDeps = {
      ...makeBaseDeps().deps,
      capture,
      env: { DISCORD_BOT_TOKEN: DUMMY_BOT_TOKEN, DISCORD_CHANNEL_ID: DUMMY_CHANNEL_ID, SCREENSHOT_DISPLAY: 'abc' },
    };
    await expect(runCapture(nonNumericDisplayDeps)).rejects.toThrow(
      'Invalid SCREENSHOT_DISPLAY: must be a positive integer (1-based index)'
    );
    expect(captureCalled).toBe(false);
  });

  test('reports empty or failed capture errors', async () => {
    const emptyBufDeps = {
      ...makeBaseDeps().deps,
      capture: async () => Buffer.alloc(0),
    };
    await expect(runCapture(emptyBufDeps)).rejects.toThrow('Capture failed: screenshot buffer is empty');

    const throwBufDeps = {
      ...makeBaseDeps().deps,
      capture: async () => {
        throw new Error('Screen capture subsystem failure');
      },
    };
    await expect(runCapture(throwBufDeps)).rejects.toThrow('Capture failed: Screen capture subsystem failure');
  });

  test('targets channel messages endpoint for thread or channel snowflake', async () => {
    const { deps, posts } = makeBaseDeps();
    deps.env.DISCORD_CHANNEL_ID = '123456789012345678';

    await runCapture(deps);

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://discord.com/api/v10/channels/123456789012345678/messages');
  });
});

describe('sanitize', () => {
  test('replaces secret cleanly and handles edge cases', () => {
    expect(sanitize('some error', 'mySecret')).toBe('some error');
    expect(sanitize('failed mySecret here', 'mySecret')).toBe('failed [REDACTED] here');
    expect(sanitize('text', undefined)).toBe('text');
    expect(sanitize('', 'x')).toBe('');
  });
});
