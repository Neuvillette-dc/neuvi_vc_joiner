
# MADMAXX VC Botokay

> **Educational Discord selfbot tool for voice channels and chatter.**  
> UI and flows modified by **neuviii**.

This project lets you:

- Run multiple Discord user tokens as a single "VC bot".
- Keep tokens online and join/leave a target voice channel.
- Run a configurable chatter system with per-token message control.
- Drive everything from an adaptive Unicode terminal menu.

All runtime logs and errors are written to `chutiya.log`.

---

## Feature Checklist (what this build does)

- **Token management**
  - Load/save tokens from `tokens.txt` with deduplication.
  - Validate tokens via the Discord API and mark invalid ones.
  - Interactive add/remove tokens from the main menu.

- **Config & persistence**
  - `config.json` stores:
    - `guildId`, `vcId` (target server / voice channel).
    - `anticaptchaKey` (for invite captcha solving).
    - `chatter` block: tokens, channelId, messageDelaySec, messages, dispatchMode, assignments.
  - Config changes are saved immediately and chatter restarts when needed.

- **Dynamic terminal menu UI**
  - Global header: centered `MADMAXX` and top-right `modified by neuviii`.
  - Outer double border and inner single border rendered with Unicode.
  - Menus auto-size to the current terminal width.
  - Main menu options (two-column layout) include:
    - Login & online tokens.
    - Token management.
    - Guild/VC ID config.
    - Join server via invite (with AntiCaptcha support).
    - Chatter config submenu.
    - Join/Leave VC.
    - Leave server.
    - List tokens.
    - Toggle chatter.
    - Set chatter channel.

- **Voice connector**
  - Uses `discord.js-selfbot-v13` sessions per token.
  - Joins/leaves a single target voice channel for all tokens.
  - Keeps state per token and can re-send voice state updates.

- **Chatter system**
  - Dedicated `ChatterManager` with its own sessions.
  - Requires at least 2 chatter tokens, a channel ID and 1+ messages.
  - Supports 3 dispatch modes via `config.chatter.dispatchMode`:
    - `random` – random token + random message.
    - `sequential` – rotating tokens/messages in order.
    - `assigned` – only uses explicit token→message assignments.
  - Zero or custom delay supported (`messageDelaySec`, with safe minimum interval).
  - Messages have numeric IDs and can be listed/added/removed from a submenu.

- **Per-token message assignments**
  - Each assignment is `{ token, messageId }`.
  - A message ID can only be assigned to one token at a time.
  - A token can only have one active message assignment.
  - Menu flow:
    - Show chatter tokens and current assignments.
    - Accept input as `<token or index> <messageId>`.
    - Same token + message again removes the mapping.
    - Same token + new messageId updates the mapping.
  - In `assigned` mode, chatter uses only these mappings; otherwise they are prioritized when present.

- **AntiCaptcha invite solver**
  - Optional `anticaptchaKey` in `config.json`.
  - On joining server via invite:
    - Normal join attempt for each token.
    - If captcha is required and key is set, the script sends the captcha to AntiCaptcha and retries join.

- **Logging**
  - `logger.info / error / confirm / notify` write structured lines to `chutiya.log`.
  - Console output is minimized to confirmations, prompts, and the menu UI.

---

## Setup

### Requirements

- **Node.js** (LTS or newer).
- A machine to run the script (local, VPS, RDP, etc.).
- **Discord user tokens** (for educational/testing purposes only).

### Installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Put your user tokens into `tokens.txt`, one per line.

3. (Optional) Edit `config.json` to pre-fill:
   - `guildId`, `vcId` – target server and voice channel.
   - `anticaptchaKey` – your AntiCaptcha API key.

4. Run the bot:

   ```bash
   node index.js
   ```

---

## Using the Menus

On start you’ll see the MADMAXX header and an adaptive bordered menu:

- Use number keys to select options.
- `[0] EXIT` closes the app from the main menu.
- The **Chatter config** submenu lets you:
  - Manage chatter tokens and channel.
  - Set message delay.
  - Configure dispatch mode (Random / Order / Assigned).
  - Manage messages and token-message assignments.

All details of your configuration are persisted in `config.json` so the next run continues where you left off.

---

## Disclaimer

This project is for **educational purposes only**. Automating Discord user accounts (selfbots) violates the Discord Terms of Service. Use this code at your own risk.

