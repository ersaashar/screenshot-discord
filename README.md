# Screen Capture to Discord

One-shot Windows desktop screenshot utility built with [Bun](https://bun.sh). Captures the primary display and uploads the image to a Discord channel via the Discord Bot API. Designed to run on a schedule via Windows Task Scheduler (e.g., at 09:00, 13:00, and 17:00 daily) without maintaining a resident daemon, bot connection, or database.

## Prerequisites

- Windows 10 or Windows 11
- [Bun](https://bun.sh) runtime (v1.0+)
- Microsoft .NET Framework 4.5+ (pre-installed on Windows 10/11, required by `screenshot-desktop` helper)
- Discord bot with `Send Messages` and `Attach Files` permissions in target channel (also `Send Messages in Threads` if targeting a thread)

## Security & Privacy Warning

> **IMPORTANT PRIVACY NOTICE**  
> Desktop capture captures the entire visible primary screen at the scheduled moment. This may include sensitive information such as passwords, chat conversations, emails, API keys, terminal sessions, or confidential customer data.  
> - Use only on authorized workstations.  
> - Ensure the target Discord channel has strict access controls and appropriate permissions.  
> - Keep `.env` out of version control and rotate the bot token via Discord Developer Portal immediately if compromised.

## Quick Start

1. Install dependencies:
   ```cmd
   bun install
   ```

2. Copy the example environment configuration:
   ```cmd
   copy .env.example .env
   ```

3. Configure bot credentials in `.env`:
   - Go to [Discord Developer Portal](https://discord.com/developers/applications), select your application -> **Bot**, and reset/copy your token.
   - Right-click target channel or thread in Discord -> **Copy Channel ID** (enable Developer Mode in Discord Settings -> App Settings -> Advanced if not visible).
   - Set in `.env`:
     ```env
     DISCORD_BOT_TOKEN=your_bot_token_here
     DISCORD_CHANNEL_ID=123456789012345678
     ```

4. Test capture manually:
   ```cmd
   bun run capture
   ```

## Configuration

Settings are loaded automatically by Bun from `.env` in the working directory:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | **Yes** | *(none)* | Discord bot token from Developer Portal. Never committed. |
| `DISCORD_CHANNEL_ID` | **Yes** | *(none)* | Destination Discord channel or thread snowflake ID. |
| `TIMEZONE` | No | `Asia/Jakarta` | IANA timezone string used to format the time displayed in Discord messages. |
| `SCREENSHOT_FORMAT` | No | `png` | Image format: `png` or `jpg`. |
| `SCREENSHOT_DISPLAY` | No | *(primary)* | 1-based display index. Omit to capture primary display. Run `bun run displays` to list connected displays. |
| `CAPTURE_SCHEDULE` | No | `0 9,13,17 * * *` | Cron expression (5-field: minute hour dom month dow). Controls Windows Task Scheduler triggers created by `register-task.ps1`. |
| `DISCORD_MESSAGE_PREFIX` | No | `Screen capture` | Header text preceding the timestamp in Discord message. |
| `DISCORD_MESSAGE_BODY` | No | *(none)* | Free-text line inserted between prefix and timestamp. Supports Discord mentions, e.g. `PIC: <@USER_ID>` to tag users. |

> **Note on Timezones:** The `TIMEZONE` variable controls how the date and time string is formatted inside the Discord message. Scheduled execution times configured in Windows Task Scheduler always evaluate against the local system clock.

### Expected Discord Output

When triggered, the utility posts a multipart message to Discord:

Screen capture
PIC: <@1324595214119211070>
Time: 18 May 2024, 09:00:00 GMT+7
[screenshot.png attached]

Console logs a single status line on completion:
```text
[2024-05-18 09:00:00] Screenshot uploaded successfully.
```

## Scheduling with Windows Task Scheduler

### Option A: Automated PowerShell Script

Run the registration script from PowerShell in the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-task.ps1
```

The script registers a task named `Screen Capture to Discord` configured for the current interactive user with triggers parsed from `CAPTURE_SCHEDULE` in `.env` (defaults to 09:00, 13:00, and 17:00 daily). If a task with that name already exists, the script aborts without overwriting.

To remove an existing task before re-registering:
```powershell
Unregister-ScheduledTask -TaskName "Screen Capture to Discord" -Confirm:$false
```

### Option B: Manual GUI Configuration

1. Press `Win + R`, type `taskschd.msc`, and press **Enter**.
2. In the right pane, click **Create Task...** (do not use *Create Basic Task*).
3. **General** tab:
   - Name: `Screen Capture to Discord`
   - Under *Security options*, choose **Run only when user is logged on**.
4. **Triggers** tab:
   - Click **New...**, set *Begin the task* to **On a schedule**, choose **Daily**, set start time to `09:00:00`, click **OK**.
   - Repeat for `13:00:00` and `17:00:00`.
5. **Actions** tab:
   - Click **New...**, set *Action* to **Start a program**.
   - **Program/script**: Full path to `bun.exe` (run `where.exe bun` in terminal to find path, typically `C:\Users\<user>\.bun\bin\bun.exe`).
   - **Add arguments**: `run src/capture.ts`
   - **Start in**: Full path to this repository root (e.g., `C:\Users\<user>\projects\screen-capture-discord`).
6. **Conditions** tab:
   - On laptops: Uncheck **Start the task only if the computer is on AC power** if captures should run on battery power.
7. Click **OK** to save.

### Verification & Testing

- View registered triggers:
  ```powershell
  (Get-ScheduledTask -TaskName "Screen Capture to Discord").Triggers
  ```
- Run task on demand (while logged on):
  ```powershell
  Start-ScheduledTask -TaskName "Screen Capture to Discord"
  ```
- Check execution results in Task Scheduler:
  - Open `taskschd.msc`, locate the task in Task Scheduler Library, and inspect **Last Run Result** (`0x0` indicates success) and the **History** tab.

## Architecture & Technical Notes

- **Interactive Desktop Requirement**: Windows screen capture requires an active interactive desktop session. When a workstation is locked, in sleep mode, disconnected from Remote Desktop (RDP), or running under a non-interactive service account, screen capture APIs will capture blank, black, or desktop lock screens.
- **Under the Hood**: `screenshot-desktop` utilizes a bundled C# helper that is compiled on first use via the .NET Framework compiler and executes as a subprocess. The helper saves a temporary image to the system temp directory and reads it back into memory. The Node/Bun layer reads the buffer and creates an in-memory `Blob`/`FormData` payload without creating additional disk files.
- **No Resident Daemon**: Windows Task Scheduler manages invocation, sleep/wake behavior, and timing precision without keeping a resident Node/Bun process running continuously in memory.
- **Retry Handling**: Network timeouts, Discord 429 rate limits, and 5xx server errors are retried once automatically with appropriate backoff before exiting. 4xx client errors fail immediately. Bot tokens are scrubbed from all console errors to prevent credential leakage.

## Troubleshooting

- **`DISCORD_BOT_TOKEN is required`**: Ensure `.env` exists in the repository working directory and contains a non-empty `DISCORD_BOT_TOKEN`.
- **`Valid DISCORD_CHANNEL_ID is required`**: Ensure `DISCORD_CHANNEL_ID` is set to a valid numeric channel or thread snowflake ID.
- **`Discord upload failed: HTTP 403`**: Bot lacks required permissions in target channel. Ensure `Send Messages` and `Attach Files` are granted (and `Send Messages in Threads` if targeting a thread).
- **`Invalid TIMEZONE: ...`**: Provide a valid IANA timezone string in `.env` (e.g., `UTC`, `America/New_York`, `Asia/Jakarta`).
- **`Invalid SCREENSHOT_FORMAT: must be 'png' or 'jpg'`**: Set `SCREENSHOT_FORMAT=png` or `SCREENSHOT_FORMAT=jpg`.
- **Blank or black screenshot in Discord**: Ensure the workstation is unlocked and the user session is active when the scheduled task fires.
- **`bun.exe` not found**: Verify Bun is installed and located in your system `PATH` or specify the absolute path in Task Scheduler.
- **Task does not run on battery**: Open task properties in Task Scheduler, go to **Conditions**, and uncheck *Start the task only if the computer is on AC power*.
- **`Invalid SCREENSHOT_DISPLAY: index N exceeds...`**: Run `bun run displays` to see available display indices and set a valid `SCREENSHOT_DISPLAY` value.
