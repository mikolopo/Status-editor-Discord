# Statuseditor

[![BetterDiscord Plugin](https://img.shields.io/badge/BetterDiscord-Plugin-blue.svg?style=for-the-badge)](https://betterdiscord.app/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)

A production-ready, beautiful, and feature-rich status and custom activity manager for **BetterDiscord**. Manage presence presets, design custom activities, configure stream links, and set up dynamic text cycling without writing a single line of raw JSON.

---

## ✨ Features

- **🎨 Modern Interactive UI**: A dark-themed settings panel with color-coded, glowing preset cards (Online, Idle, Do Not Disturb, Invisible, and Purple Streaming).
- **📝 Form-based Configurations**: Custom inputs for Activity Type, Activity Name, Details, State, and Application ID.
- **🔄 Text Cycling (Rotation)**: Enter multiple details or state lines to cycle through them automatically at a configurable interval.
- **🚀 Bulletproof Status Syncing**: Employs **5 redundant fallback methods** to sync presence settings safely, bypassing recent Discord client changes.
- **🛡️ Conflict Prevention**: Smart presence handler automatically handles streaming type overrides to prevent standard status indicators from turning purple.
- **💡 Inline Tutorials**: Helpful badges, guidelines, and visual guides located directly near the input fields to assist you.

---

## 📦 Installation

1. **Download the Plugin**:
   Download the [Statuseditor.plugin.js](Statuseditor.plugin.js) file.
2. **Move to Plugins Folder**:
   Copy the file into your BetterDiscord plugins folder.
   - **Windows**: `%appdata%\BetterDiscord\plugins`
   - **macOS**: `~/Library/Application Support/BetterDiscord/plugins`
   - **Linux**: `~/.config/BetterDiscord/plugins`
3. **Enable the Plugin**:
   Open Discord, go to **User Settings > BetterDiscord > Plugins**, and toggle on **Statuseditor**.
4. **Configure**:
   Click the gear icon next to the plugin to open the settings dashboard and customize your presence!

---

## 🛠️ Configuration Details

### 1. Presence Status Preset
Choose your core online indicator dot. Selecting **Purple Streaming** adds the streaming activity status badge to your profile.

### 2. Custom Activity
Enable custom presence activity to display standard activities (Playing, Listening, Watching, Competing) alongside your online indicator. If **Streaming** is chosen, you can provide a valid Twitch or YouTube URL.

### 3. Application ID (Client ID)
Provide a custom Discord Developer Application Client ID to display application-specific icons and assets. If left empty, the plugin generates clean custom status presence without linking to an app.

### 4. Text Cycling
Enter text lines separated by newlines in the details and state text areas. Toggle **Enable Text Cycling** and set an interval (in milliseconds) to cycle your profile activity texts automatically.

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
