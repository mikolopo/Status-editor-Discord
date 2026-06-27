# Statuseditor (v2.0.0)

**Statuseditor** is a powerful BetterDiscord plugin that allows you to fully customize your Discord presence and manage your profile widgets through an interactive interface.

---

## Key Features

- **Presence Controls**: Easily switch between Online, Idle, Do Not Disturb, Invisible, and Streaming presets.
- **Activity Customizer**: Change your activity type (Playing, Listening, Watching, Competing), name, details, state, and application ID.
- **Presence Cycling**: Cycle through multiple custom text lines (details/state) at a specified interval.
- **Profile Widget Editor**: Dynamically configure your Discord Developer Profile Widget (surfaces like *Widget Top*, *Widget Bottom*, *Mini Profile*, etc.) directly from Discord settings.
- **Built-in System Variables**:
  - `lol_stats` (**League of Legends Live Companion**): Automatically tracks your League of Legends game state (Lobby, Queue, Champ Select) by reading local Riot client logs, and fetches your champion, real-time KDA, and game time during matches.
  - `In_Call` (**Voice Channel Tracker**): Displays your current voice channel status in English (e.g. `🔊 General (My Server)` or `Not in Call 🛌`) with instant refresh upon joining or leaving calls.
  - `Spotify_song`: Displays the current playing song from Spotify.
  - `minutes_since_formatted` / `minutes_since`: Calculates the time elapsed since a custom target date (e.g. your age).
  - `discord_wasted`: Tracks your total time spent in Discord voice channels.
- **Custom Scripting (JS/URL)**: Add your own variables using custom JavaScript scripts or JSON API endpoints.

---

## Setup Guide (Profile Widget)

To use the **Profile Widget Editor**, you need to set up a Discord Developer Application. Follow these steps:

### 1. Create a Discord Application
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give it a name.
3. In the **Bot** tab, click **Add Bot** (if not already created).
4. Copy your **Application ID** (Client ID) and **Bot Token**.

### 2. Configure the Activity Widget
1. In your application settings, navigate to **Rich Presence** -> **Activity Widget**.
2. Enable the widget.
3. Copy the **Configuration ID** (Config ID).
4. (Optional) Go to **Rich Presence** -> **Art Assets** to upload images you want to display in your widget.

### 3. Link to the Plugin
1. Open Discord Settings -> **Plugins** -> **Statuseditor** -> Click **Settings**.
2. Enter your **App ID**, **Bot Token**, and **Config ID**.
3. Click **Save** to apply.

---

## Using the Widget Editor

Once configured, you can load and edit your widget layouts directly in the plugin settings:

1. Click **Load from Discord** to fetch your current widget layouts.
2. Use the tabs (*Widget Top*, *Widget Bottom*, *Mini Profile*, etc.) to select the surface you want to edit.
3. For each field, you can choose:
   - **Static Text**: Type your own custom text.
   - **System/Custom Variable**: Select a variable from the dropdown (e.g., `lol_stats`, `In_Call`, `Spotify_song`).
   - **Assets**: Select uploaded graphic assets for image fields.
4. Click **Save to Portal** to upload your design to the Discord Developer Portal.
5. Enable **Auto Sync Widget** to automatically push live updates to your profile.

---

## How the League of Legends Live Companion Works

The `lol_stats` variable is completely secure and operates locally on your machine:
- **Zero-network LCU tracking**: It reads the local Riot Games client logs (`C:/Riot Games/League of Legends/Logs/LeagueClient Logs`) to instantly detect your game state (Lobby, Queue, Champ Select, etc.). It does not make local network requests to the League Client Ux, avoiding SSL certificate issues and process sandboxing blocks.
- **Live Match Stats**: During a live match (`InProgress`), it queries the local game client API on port 2999 via HTTPS (using a built-in self-signed certificate bypass) to retrieve your active champion, KDA, and elapsed match time.
- **Automatic Refresh**: Updates are throttled to match your configured widget sync interval to prevent Discord API rate limits (429 errors).

---

## Installation

1. Download the [Statuseditor.plugin.js](Statuseditor.plugin.js) file.
2. Paste it into your BetterDiscord plugins directory:
   - **Windows**: `%appdata%\BetterDiscord\plugins`
   - **macOS**: `~/Library/Application Support/BetterDiscord/plugins`
   - **Linux**: `~/.config/BetterDiscord/plugins`
3. Enable the plugin in your Discord settings.

---

## License

MIT
