/**
 * @name Statuseditor
 * @version 2.0.0
 * @description Discord status and custom activity editor.
 * @author Mikolopo
 * @website https://github.com/mikolopo/Status-editor-Discord
 */

let nativeFs = null;
try {
  nativeFs = require("fs");
} catch (e) {
  console.error("Statuseditor: Failed to load native fs module:", e);
}

module.exports = class Statuseditor {
  constructor(meta) {
    this.meta = meta;

    this.defaultSettings = {
      status: "streaming",
      activityName: "Streaming",
      activityType: 1,
      streamUrl: "https://www.twitch.tv/discord",
      details: "Just vibing",
      state: "In the zone",
      steps: [
        { details: "Just vibing", state: "In the zone" },
        { details: "Chilling", state: "AFK" },
        { details: "Coding", state: "Busy" }
      ],
      cycleEnabled: false,
      cycleInterval: 5000,
      applicationId: "",
      enableCustomActivity: true,
      widgetAppId: "",
      widgetBotToken: "",
      widgetConfigId: "",
      widgetSurfaces: null,
      widgetAutoSync: false,
      widgetSyncInterval: 15,
      targetDate: "",
      totalCallMinutes: 0,
      customVariables: []
    };

    const saved = BdApi.Data.load("Statuseditor", "settings");
    this.settings = saved ? { ...this.defaultSettings, ...saved } : { ...this.defaultSettings };

    if (saved && (saved.detailsRotation || saved.stateRotation) && (!saved.steps || saved.steps.length === 0)) {
      const detailsList = saved.detailsRotation || [];
      const stateList = saved.stateRotation || [];
      const maxLength = Math.max(detailsList.length, stateList.length);
      const migratedSteps = [];
      for (let i = 0; i < Math.min(10, maxLength); i++) {
        migratedSteps.push({
          details: detailsList[i] || "",
          state: stateList[i] || ""
        });
      }
      this.settings.steps = migratedSteps.length > 0 ? migratedSteps : this.defaultSettings.steps;
    }

    this.cycleTimer = null;
    this.cycleIndex = 0;
    this.widgetSyncTimer = null;
    this.callTrackingTimer = null;
  }

  saveSettings() {
    BdApi.Data.save("Statuseditor", "settings", this.settings);
  }

  start() {
    this.patch();

    if (this.settings.status !== "streaming") {
      this.updatePresenceStatus(this.settings.status);
    } else {
      this.updatePresenceStatus("online");
    }

    if (this.settings.cycleEnabled) {
      this.startCycle();
    }

    if (this.settings.widgetAutoSync) {
      this.startWidgetSync();
    }

    this.startCallTracking();

    // Subscribe to voice channel and Spotify activity changes for instant widget updates
    const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
    if (FluxDispatcher) {
      this.handleVoiceChannelSelectBound = this.handleVoiceChannelSelect.bind(this);
      this.handleLocalActivityUpdateBound = this.handleLocalActivityUpdate.bind(this);
      
      FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", this.handleVoiceChannelSelectBound);
      FluxDispatcher.subscribe("LOCAL_ACTIVITY_UPDATE", this.handleLocalActivityUpdateBound);
    }

    // Expose instance globally for custom scripts
    window.statusEditorInstance = this;

    BdApi.UI.showToast("Status Editor: Activated", { type: "success" });
  }

  stop() {
    this.stopCycle();
    this.stopWidgetSync();
    this.stopCallTracking();

    // Unsubscribe from event listeners
    const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
    if (FluxDispatcher) {
      if (this.handleVoiceChannelSelectBound) {
        FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", this.handleVoiceChannelSelectBound);
      }
      if (this.handleLocalActivityUpdateBound) {
        FluxDispatcher.unsubscribe("LOCAL_ACTIVITY_UPDATE", this.handleLocalActivityUpdateBound);
      }
    }

    if (this.voiceTimeout) clearTimeout(this.voiceTimeout);
    if (this.spotifyTimeout) clearTimeout(this.spotifyTimeout);

    // Clean up global instance
    delete window.statusEditorInstance;

    BdApi.Patcher.unpatchAll("Statuseditor");
    BdApi.UI.showToast("Status Editor: Deactivated", { type: "info" });
  }

  handleVoiceChannelSelect() {
    if (this.voiceTimeout) clearTimeout(this.voiceTimeout);
    this.voiceTimeout = setTimeout(() => this.pushWidget(true), 1500);
  }

  handleLocalActivityUpdate() {
    const LocalActivityStore = BdApi.Webpack.getStore("LocalActivityStore");
    const activeSpotify = (LocalActivityStore?.getActivities() || []).find(a => a.name === "Spotify");
    const currentId = activeSpotify ? activeSpotify.sync_id : null;
    
    if (currentId !== this.lastSongId) {
      this.lastSongId = currentId;
      if (this.spotifyTimeout) clearTimeout(this.spotifyTimeout);
      this.spotifyTimeout = setTimeout(() => this.pushWidget(true), 1500);
    }
  }

  getVoiceStatus() {
    try {
      const SelectedChannelStore = BdApi.Webpack.getStore("SelectedChannelStore");
      const ChannelStore = BdApi.Webpack.getStore("ChannelStore");
      const GuildStore = BdApi.Webpack.getStore("GuildStore");

      const voiceChannelId = SelectedChannelStore?.getVoiceChannelId();
      if (!voiceChannelId) return "No Call";

      const channel = ChannelStore?.getChannel(voiceChannelId);
      if (!channel) return "In Call";

      const guild = GuildStore?.getGuild(channel.guild_id);
      return `📞 ${channel.name}` + (guild ? ` (${guild.name})` : " (DM)");
    } catch (e) {
      console.error("Statuseditor: Error getting voice status:", e);
      return "Voice Error";
    }
  }

  getSpotifySong() {
    try {
      const LocalActivityStore = BdApi.Webpack.getStore("LocalActivityStore");
      const spotify = (LocalActivityStore?.getActivities() || []).find(a => a.name === "Spotify");
      if (!spotify) return "Not playing";
      
      this.lastSongId = spotify.sync_id;
      return `🎧 ${spotify.details} - ${spotify.state}`;
    } catch (e) {
      console.error("Statuseditor: Error getting Spotify song:", e);
      return "Spotify Error";
    }
  }

  patch() {
    const LocalActivityStore = BdApi.Webpack.getStore("LocalActivityStore");
    const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
    const UserStore = BdApi.Webpack.getStore("UserStore");
    const userId = UserStore?.getCurrentUser()?.id;

    if (!LocalActivityStore) {
      console.error("Statuseditor: LocalActivityStore not found!");
      return;
    }

    BdApi.Patcher.after("Statuseditor", LocalActivityStore, "getActivities", (_, __, ret) => {
      const act = this.buildActivity();
      const nameToFilter = act ? act.name : this.settings.activityName;
      const filtered = (ret || []).filter(a => a.name !== nameToFilter && a.name !== "Streaming" && a.name !== "\u2800");
      if (!act) return filtered;
      return [...filtered, act];
    });

    if (LocalActivityStore.getAllActivities && userId) {
      BdApi.Patcher.after("Statuseditor", LocalActivityStore, "getAllActivities", (_, __, ret) => {
        const act = this.buildActivity();
        const nameToFilter = act ? act.name : this.settings.activityName;
        const userActivities = ret[userId] || [];
        const filtered = userActivities.filter(a => a.name !== nameToFilter && a.name !== "Streaming" && a.name !== "\u2800");
        return {
          ...ret,
          [userId]: act ? [...filtered, act] : filtered
        };
      });
    }

    const act = this.buildActivity();
    FluxDispatcher?.dispatch({
      type: "LOCAL_ACTIVITY_UPDATE",
      socketId: "Statuseditor",
      activity: act
    });
  }

  buildActivity() {
    try {
      const isStreaming = this.settings.status === "streaming";

      if (!isStreaming && !this.settings.enableCustomActivity) {
        return null;
      }

      const activity = {
        name: (this.settings.activityName && this.settings.activityName.trim()) ? this.settings.activityName : "\u2800",
        type: isStreaming ? 1 : (parseInt(this.settings.activityType) === 1 ? 0 : parseInt(this.settings.activityType)),
        flags: 1
      };

      if (this.settings.applicationId) {
        activity.application_id = this.settings.applicationId;
      }

      if (activity.type === 1) {
        activity.url = this.settings.streamUrl || "https://www.twitch.tv/discord";
      }

      let detailsText = "";
      let stateText = "";

      if (this.settings.cycleEnabled && this.settings.steps && this.settings.steps.length > 0) {
        const currentStep = this.settings.steps[this.cycleIndex % this.settings.steps.length];
        detailsText = currentStep?.details || "";
        stateText = currentStep?.state || "";
      } else {
        detailsText = this.settings.details || "";
        stateText = this.settings.state || "";
      }

      activity.details = detailsText.trim() ? detailsText : "\u2800";
      activity.state = stateText.trim() ? stateText : "\u2800";

      return activity;
    } catch (e) {
      console.error("Statuseditor: Error building activity:", e);
      return {
        name: "Streaming",
        type: 1,
        url: "https://www.twitch.tv/discord",
        details: "Error building activity",
        state: "Check Settings",
        application_id: "0",
        flags: 1
      };
    }
  }

  async getLolStats() {
    try {
      const lockpath = "C:/Riot Games/League of Legends/lockfile";
      if (!nativeFs || !nativeFs.existsSync(lockpath)) {
        return "Game Off 💤";
      }

      // Find the latest log file to read the gameflow phase
      const logDir = "C:/Riot Games/League of Legends/Logs/LeagueClient Logs";
      if (!nativeFs.existsSync(logDir)) {
        return "LoL: Client Running 🎮";
      }

      const files = nativeFs.readdirSync(logDir);
      const logFiles = files.filter(f => f.endsWith(".log") && f.includes("LeagueClient"));
      if (logFiles.length === 0) {
        return "LoL: Client Running 🎮";
      }

      // Sort alphabetically - since Riot uses ISO timestamps, the last file is always the newest
      logFiles.sort();
      const latestFile = logFiles[logFiles.length - 1];

      const logPath = logDir + "/" + latestFile;
      const logContent = nativeFs.readFileSync(logPath, "utf-8");

      // Find the last gameflow phase logged
      const matches = [...logContent.matchAll(/GameflowMonitor: marking (\w+) phase/g)];
      let phase = "None";
      if (matches.length > 0) {
        phase = matches[matches.length - 1][1];
      }

      if (!phase || phase === "None") return "LoL: Main Menu 🎮";
      if (phase === "Lobby") return "LoL: In Lobby 🏆";
      if (phase === "Matchmaking") return "LoL: In Queue 🔍";
      if (phase === "ReadyCheck") return "LoL: Match Ready! ⚡";
      if (phase === "ChampSelect") return "LoL: Champ Select 🎴";
      if (phase === "GameStart") return "LoL: Loading Match... ⚔️";

      if (phase === "InProgress" || phase === "Reconnect") {
        try {
          // Fetch live game stats via HTTPS (port 2999) - passing rejectUnauthorized directly to bypass SSL
          const gameRes = await BdApi.Net.fetch("https://127.0.0.1:2999/liveclientdata/allgamedata", {
            rejectUnauthorized: false
          });
          if (gameRes.ok) {
            const gameData = await gameRes.json();
            const activePlayerName = gameData.activePlayer?.summonerName;
            const me = gameData.allPlayers?.find(p => 
              p.summonerName && activePlayerName && 
              p.summonerName.toLowerCase().replace(/\s+/g, "") === activePlayerName.toLowerCase().replace(/\s+/g, "")
            );
            
            if (me) {
              const champion = me.championName;
              const scores = me.scores || {};
              console.log("Statuseditor LoL: Player scores object:", scores);
              
              const cs = scores.creepScore !== undefined ? scores.creepScore : (scores.creepscore !== undefined ? scores.creepscore : 0);
              const gameTimeSec = gameData.gameData?.gameTime || 0;
              const gameTimeMin = Math.floor(gameTimeSec / 60);

              return `🎮 ${champion} (${scores.kills}/${scores.deaths}/${scores.assists}) | CS: ${cs} | ⏱️ ${gameTimeMin}m`;
            }
          }
        } catch (e) {
          // Fallback if port 2999 is not responding or blocked
          return "LoL: In Game ⚔️";
        }
        return "LoL: In Game ⚔️";
      }

      return `LoL: ${phase}`;
    } catch (e) {
      console.error("Statuseditor LoL: Error:", e);
      return "Game Off 💤";
    }
  }

  getModuleFunction(filter, name) {
    try {
      const module = BdApi.Webpack.getModule((m) => {
        try {
          if (!m) return false;
          if (typeof m[name] === "function") return true;
          if (m.default && typeof m.default[name] === "function") return true;
          return filter(m);
        } catch {
          return false;
        }
      });
      if (module) {
        if (typeof module[name] === "function") return module[name].bind(module);
        if (module.default && typeof module.default[name] === "function") return module.default[name].bind(module.default);
      }
    } catch (e) {
      console.warn(`Statuseditor: getModuleFunction failed for ${name}:`, e);
    }
    return null;
  }

  getHTTPModule() {
    try {
      const HTTP = BdApi.Webpack.getModule((m) => {
        if (!m) return false;
        const check = (obj) => {
          return (
            typeof obj.get === "function" &&
            typeof obj.post === "function" &&
            typeof obj.put === "function" &&
            typeof obj.patch === "function" &&
            (typeof obj.del === "function" || typeof obj.delete === "function")
          );
        };
        return check(m) || (m.default && check(m.default));
      });
      if (HTTP) {
        return HTTP.patch ? HTTP : HTTP.default;
      }
    } catch (e) {
      console.warn("Statuseditor: getHTTPModule failed:", e);
    }
    return null;
  }

  getToken() {
    let token = null;
    try {
      window.webpackChunkdiscord_app.push([[Symbol()], {}, o => {
        for (let e of Object.values(o.c)) {
          try {
            if (!e.exports || e.exports === window) continue;
            if (e.exports?.getToken) {
              token = e.exports.getToken();
              if (token) break;
            }
            for (let oKey in e.exports) {
              if (e.exports?.[oKey]?.getToken && "IntlMessagesProxy" !== e.exports[oKey][Symbol.toStringTag]) {
                token = e.exports[oKey].getToken();
                if (token) break;
              }
            }
          } catch {}
          if (token) break;
        }
      }]);
      window.webpackChunkdiscord_app.pop();
    } catch (err) {
      console.error("Statuseditor: Token extraction error:", err);
    }
    return token;
  }

  updatePresenceStatus(status) {
    if (!status || status === "streaming") return;

    try {
      const updateStatus = this.getModuleFunction(
        (m) => m?.updateStatus || m?.default?.updateStatus,
        "updateStatus"
      );
      if (updateStatus) {
        updateStatus(status);
        console.log(`Statuseditor: Set status to "${status}" via updateStatus`);
        return;
      }
    } catch (e) {
      console.warn("Statuseditor: Method 1 (updateStatus) failed:", e);
    }

    try {
      const updateRemoteProfileSettings = this.getModuleFunction(
        (m) => m?.updateRemoteProfileSettings || m?.default?.updateRemoteProfileSettings,
        "updateRemoteProfileSettings"
      );
      if (updateRemoteProfileSettings) {
        updateRemoteProfileSettings({ status: { value: status } });
        console.log(`Statuseditor: Set status to "${status}" via updateRemoteProfileSettings`);
        return;
      }
    } catch (e) {
      console.warn("Statuseditor: Method 2 (updateRemoteProfileSettings) failed:", e);
    }

    try {
      const token = this.getToken();
      if (token) {
        window.fetch("/api/v9/users/@me/settings", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": token
          },
          body: JSON.stringify({ status: status })
        }).then(async res => {
          if (res.ok) {
            console.log(`Statuseditor: Set status to "${status}" via fetch`);
          } else {
            console.warn(`Statuseditor: fetch failed with status ${res.status}:`, await res.text());
          }
        }).catch(err => {
          console.warn("Statuseditor: fetch request failed:", err);
        });
        return;
      }
    } catch (e) {
      console.warn("Statuseditor: Method 3 (fetch PATCH) failed:", e);
    }

    try {
      const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
      if (FluxDispatcher) {
        FluxDispatcher.dispatch({
          type: "USER_SETTINGS_PROTO_UPDATE",
          settings: {
            status: { value: status }
          }
        });
        console.log(`Statuseditor: Dispatched status "${status}" directly to FluxDispatcher`);
        return;
      }
    } catch (e) {
      console.error("Statuseditor: Method 4 (FluxDispatcher) failed:", e);
    }

    try {
      const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
      if (FluxDispatcher) {
        FluxDispatcher.dispatch({
          type: "USER_SETTINGS_UPDATE",
          settings: {
            status: status
          }
        });
        console.log(`Statuseditor: Dispatched status "${status}" directly to FluxDispatcher (Legacy)`);
        return;
      }
    } catch (e) {
      console.error("Statuseditor: Method 5 (FluxDispatcher Legacy) failed:", e);
    }

    BdApi.UI.showToast("Status Editor: Could not update presence status", { type: "error" });
  }

  startCycle() {
    this.stopCycle();
    const interval = Math.max(1000, this.settings.cycleInterval || 5000);

    const update = () => {
      const act = this.buildActivity();
      const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
      FluxDispatcher?.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        socketId: "Statuseditor",
        activity: act
      });
    };

    update();

    this.cycleTimer = setInterval(() => {
      this.cycleIndex++;
      update();
    }, interval);
  }

  stopCycle() {
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  applySettings() {
    this.saveSettings();

    this.stopCycle();
    BdApi.Patcher.unpatchAll("Statuseditor");

    this.patch();

    if (this.settings.status !== "streaming") {
      this.updatePresenceStatus(this.settings.status);
    } else {
      this.updatePresenceStatus("online");
    }

    if (this.settings.cycleEnabled) {
      this.startCycle();
    } else {
      const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
      const act = this.buildActivity();
      FluxDispatcher?.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        socketId: "Statuseditor",
        activity: act
      });
    }

    this.stopWidgetSync();
    if (this.settings.widgetAutoSync) {
      this.startWidgetSync();
    }
  }

  startWidgetSync() {
    this.stopWidgetSync();
    if (!this.settings.widgetAppId || !this.settings.widgetBotToken) return;
    
    // Convert minutes to milliseconds (minimum 1 minute)
    const intervalMs = Math.max(1, this.settings.widgetSyncInterval || 15) * 60 * 1000;
    
    this.pushWidget(true); // Initial push silently
    this.widgetSyncTimer = setInterval(() => {
      this.pushWidget(true);
    }, intervalMs);
  }

  stopWidgetSync() {
    if (this.widgetSyncTimer) {
      clearInterval(this.widgetSyncTimer);
      this.widgetSyncTimer = null;
    }
  }

  startCallTracking() {
    this.stopCallTracking();
    this.callTrackingTimer = setInterval(() => {
      try {
        const UserStore = BdApi.Webpack.getStore("UserStore");
        const VoiceStateStore = BdApi.Webpack.getStore("VoiceStateStore");
        const userId = UserStore?.getCurrentUser()?.id;
        if (userId && VoiceStateStore) {
          const state = VoiceStateStore.getVoiceStateForUser(userId);
          if (state && state.channelId) {
            this.settings.totalCallMinutes = (this.settings.totalCallMinutes || 0) + 1;
            this.saveSettings();
            
            const callMinDisplay = document.getElementById("sc-call-min-display");
            if (callMinDisplay) {
              callMinDisplay.textContent = this.settings.totalCallMinutes + " minutes tracked";
            }
          }
        }
      } catch (e) {
        console.warn("Statuseditor: Error tracking call minutes", e);
      }
    }, 60000);
  }

  stopCallTracking() {
    if (this.callTrackingTimer) {
      clearInterval(this.callTrackingTimer);
      this.callTrackingTimer = null;
    }
  }

  async pushWidget(silent = false) {
    if (!this.settings.widgetAppId || !this.settings.widgetBotToken) {
      if (!silent) BdApi.UI.showToast("Widget Setup Incomplete: Missing App ID or Bot Token", { type: "error" });
      return;
    }
    try {
      const UserStore = BdApi.Webpack.getStore("UserStore");
      const userId = UserStore?.getCurrentUser()?.id;
      if (!userId) { if (!silent) BdApi.UI.showToast("Could not get current User ID", { type: "error" }); return; }

      const formatMins = (m) => {
        const y = Math.floor(m / 525960), d = Math.floor((m % 525960) / 1440), h = Math.floor((m % 1440) / 60);
        let p = []; if (y > 0) p.push(y + "yr"); if (d > 0) p.push(d + "day"); p.push(h + "h");
        return p.join(" ") || "0h";
      };

      let minsSince = 0;
      if (this.settings.targetDate) {
        const t = new Date(this.settings.targetDate).getTime();
        if (!isNaN(t)) minsSince = Math.floor((Date.now() - t) / 60000);
      }
      const callMins = this.settings.totalCallMinutes || 0;

      // Find all dynamic variables and their presentation types from the surfaces
      const dynamicFields = [];
      const varNames = new Set();
      const presentationTypes = {};

      if (this.settings.widgetSurfaces) {
        const traverse = (obj) => {
          if (!obj || typeof obj !== "object") return;
          if (obj.value_type === "data" && typeof obj.value === "string" && obj.value) {
            varNames.add(obj.value);
            if (obj.presentation_type) {
              presentationTypes[obj.value] = obj.presentation_type;
            }
          }
          for (const k in obj) {
            if (obj.hasOwnProperty(k)) traverse(obj[k]);
          }
        };
        traverse(this.settings.widgetSurfaces);
      } else {
        // Fallback defaults
        varNames.add("minutes_since");
        varNames.add("discord_wasted");
        presentationTypes["minutes_since"] = "number";
        presentationTypes["discord_wasted"] = "text";
      }

      // Helper to resolve variable values asynchronously
      const resolveVariable = async (name) => {
        if (name === "minutes_since" || name === "minutes_since_formatted") return minsSince;
        if (name === "discord_wasted" || name === "discord_wasted_formatted") return callMins;
        if (name === "lol_stats") return await this.getLolStats();
        if (name === "In_Call") return this.getVoiceStatus();
        if (name === "Spotify_song") return this.getSpotifySong();

        const cv = (this.settings.customVariables || []).find(v => v.name === name);
        if (!cv) return "";

        if (cv.type === "js") {
          try {
            // Compile as AsyncFunction and inject native Node.js fs and child_process modules (mocked as null due to sandbox)
            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            const fn = new AsyncFunction("fs", "child_process", "BdApi", cv.code);
            return await fn(nativeFs, null, BdApi);
          } catch (e) {
            console.error(`Statuseditor: Custom JS variable ${name} error:`, e);
            return "JS Error";
          }
        } else if (cv.type === "url") {
          try {
            const res = await window.fetch(cv.code);
            if (res.ok) {
              const data = await res.json();
              if (cv.jsonPath) {
                const path = cv.jsonPath.replace(/^\$\.?/, "").split(".");
                let obj = data;
                for (const key of path) {
                  if (obj && obj[key] !== undefined) obj = obj[key];
                  else return "Not Found";
                }
                return obj;
              }
              return typeof data === "object" ? JSON.stringify(data) : data;
            }
            return `HTTP ${res.status}`;
          } catch (e) {
            return "Fetch Error";
          }
        }
        return cv.code || ""; // static text
      };

      for (const name of varNames) {
        const presType = presentationTypes[name] || "text";
        const val = await resolveVariable(name);

        if (presType === "number") {
          const numVal = Number(val);
          dynamicFields.push({ type: 2, name, value: isNaN(numVal) ? 0 : numVal });
        } else {
          let stringVal;
          if ((name === "minutes_since_formatted" || name === "discord_wasted_formatted") && typeof val === "number") {
            stringVal = formatMins(val);
          } else {
            stringVal = String(val);
          }
          dynamicFields.push({ type: 1, name, value: stringVal });
        }
      }

      const payload = {
        username: "StatuseditorWidget",
        data: { dynamic: dynamicFields }
      };

      const url = `https://discord.com/api/v9/applications/${this.settings.widgetAppId}/users/${userId}/identities/0/profile`;
      const response = await BdApi.Net.fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bot ${this.settings.widgetBotToken}`, "User-Agent": "DiscordBot (https://github.com/discord/discord-api-docs, 1.0.0)" },
        body: JSON.stringify(payload)
      });
      if (response.ok) { if (!silent) BdApi.UI.showToast("Widget data pushed!", { type: "success" }); }
      else { const t = await response.text(); if (!silent) BdApi.UI.showToast(`Push failed: ${response.status}`, { type: "error" }); console.error("Widget Push Error:", t); }
    } catch (e) { console.error("Widget Error:", e); if (!silent) BdApi.UI.showToast("Error pushing widget.", { type: "error" }); }
  }

  getUserToken() {
    const AuthStore = BdApi.Webpack.getStore("AuthenticationStore");
    if (AuthStore && typeof AuthStore.getToken === "function") {
      const t = AuthStore.getToken();
      if (t) return t;
    }
    const tokenModule = BdApi.Webpack.getModule(m => m?.default?.getToken);
    if (tokenModule && tokenModule.default && typeof tokenModule.default.getToken === "function") {
      return tokenModule.default.getToken();
    }
    return null;
  }

  async fetchWidgetConfig() {
    const token = this.getUserToken();
    if (!token) {
      console.error("Statuseditor: Failed to get user token");
      return null;
    }
    if (!this.settings.widgetAppId || !this.settings.widgetConfigId) {
      console.error("Statuseditor: Missing App ID or Config ID in settings");
      return null;
    }
    try {
      // Method 1: Get configs list for the application
      const urlApp = `https://discord.com/api/v9/applications/${this.settings.widgetAppId}/widget-configs`;
      console.log("Statuseditor: Trying to fetch from:", urlApp);
      let res = await window.fetch(urlApp, {
        headers: { "Authorization": token }
      });
      
      let configs = [];
      if (res.ok) {
        configs = await res.json();
      } else {
        console.warn(`Statuseditor: Fetch from ${urlApp} failed (${res.status}). Trying developer fallback...`);
        // Method 2: Fallback to all developer configs
        const urlDev = `https://discord.com/api/v9/widget-configs/developer`;
        res = await window.fetch(urlDev, {
          headers: { "Authorization": token }
        });
        if (res.ok) {
          const devData = await res.json();
          // The dev endpoint might return a map or array
          if (devData && typeof devData === "object") {
            configs = Array.isArray(devData) ? devData : Object.values(devData);
          }
        }
      }

      if (!res.ok) {
        console.error("Statuseditor: Both fetch methods failed");
        return null;
      }

      // Find the config with the matching ID
      const targetConfig = configs.find(c => c.config_id === this.settings.widgetConfigId || c.id === this.settings.widgetConfigId);
      if (targetConfig) {
        console.log("Statuseditor: Successfully found widget config:", targetConfig);
        return targetConfig;
      }

      console.error("Statuseditor: Could not find config with ID", this.settings.widgetConfigId, "in fetched configs:", configs);
      return null;
    } catch (e) {
      console.error("Statuseditor: Fetch widget config exception:", e);
      return null;
    }
  }

  async pushWidgetConfig() {
    if (!this.settings.widgetAppId || !this.settings.widgetConfigId) {
      BdApi.UI.showToast("Missing App ID or Config ID!", { type: "error" }); return;
    }
    try {
      const token = this.getUserToken();
      if (!token) { BdApi.UI.showToast("Could not get user token!", { type: "error" }); return; }

      const surfaces = this.settings.widgetSurfaces;
      if (!surfaces) { BdApi.UI.showToast("Load the config first!", { type: "warning" }); return; }

      const url = `https://discord.com/api/v9/applications/${this.settings.widgetAppId}/widget-configs/${this.settings.widgetConfigId}`;
      const res = await window.fetch(url, {
        method: "PATCH",
        headers: { "Authorization": token, "Content-Type": "application/json" },
        body: JSON.stringify({ surfaces })
      });
      if (res.ok) {
        BdApi.UI.showToast("Config saved to portal!", { type: "success" });
        this.pushWidget(true);
      } else {
        const errText = await res.text();
        console.error("Widget Config Error:", errText);
        try {
          const errObj = JSON.parse(errText);
          if (errText.includes("WIDGET_CONFIG_MISSING_ASSET")) {
            BdApi.UI.showToast("Error: The selected layout requires a graphic asset! Add it in the Developer Portal (Rich Presence -> Art Assets) and select the correct name in the plugin.", { type: "error", timeout: 8000 });
          } else if (errObj.errors) {
            const getErrorMsg = (obj) => {
              if (typeof obj === "string") return obj;
              if (Array.isArray(obj)) return obj.map(getErrorMsg).join(", ");
              if (obj._errors) return obj._errors.map(x => x.message).join(", ");
              for (const k in obj) {
                const msg = getErrorMsg(obj[k]);
                if (msg) return `${k}: ${msg}`;
              }
              return null;
            };
            const msg = getErrorMsg(errObj.errors);
            BdApi.UI.showToast(`Save error: ${msg || errObj.message}`, { type: "error", timeout: 6000 });
          } else {
            BdApi.UI.showToast(`Save error: ${errObj.message || res.status}`, { type: "error" });
          }
        } catch (e) {
          BdApi.UI.showToast("Error saving configuration: " + res.status, { type: "error" });
        }
      }
    } catch (e) { BdApi.UI.showToast("Error saving config", { type: "error" }); console.error(e); }
  }

  async loadWidgetEditorInto(container) {
    container.innerHTML = `<div style="text-align:center;padding:20px;opacity:.6">⏳ Loading configuration from Discord...</div>`;
    const config = await this.fetchWidgetConfig();
    container.innerHTML = "";

    if (!config || !config.surfaces) {
      container.innerHTML = `<div style="text-align:center;padding:16px;color:#ed4245;">Error fetching configuration. Check App ID and Config ID.</div>`;
      return;
    }

    this.settings.widgetSurfaces = JSON.parse(JSON.stringify(config.surfaces));
    this.saveSettings();

    this.renderWidgetEditor(container, config.resolved_assets || []);
  }

  renderWidgetEditor(container, resolvedAssets, activeTabKey = null) {
    container.innerHTML = "";

    const SURFACE_LABELS = {
      widget_top: "Widget Top",
      widget_bottom: "Widget Bottom",
      mini_profile: "Mini Profile",
      add_widget_preview: "Add Widget Preview",
      activity_accessory: "Activity Accessory"
    };

    const LAYOUT_OPTIONS = {
      widget_bottom: [
        { value: "widget_bottom_stats", label: "Stats Grid (6 stats)" },
        { value: "widget_bottom_progress", label: "Progress Bar" },
        { value: "widget_bottom_collection", label: "Collection" }
      ],
      widget_top: [
        { value: "widget_top_contained", label: "Contained Image + Title" }
      ],
      mini_profile: [
        { value: "mini_profile_hero_stat", label: "Hero Stat + Image" }
      ],
      add_widget_preview: [
        { value: "add_widget_preview_contained", label: "Contained Image" }
      ],
      activity_accessory: [
        { value: "activity_accessory_stat", label: "Stat Text" }
      ]
    };

    const LAYOUT_TEMPLATES = {
      widget_bottom: {
        widget_bottom_stats: {
          layout: "widget_bottom_stats",
          components: {
            stat_1: { fields: { label: { value_type: "custom_string", presentation_type: "text", value: "" }, value: { value_type: "custom_string", presentation_type: "text", value: "" } } },
            stat_2: { fields: { label: { value_type: "custom_string", presentation_type: "text", value: "" }, value: { value_type: "custom_string", presentation_type: "text", value: "" } } },
            stat_3: { fields: { label: { value_type: "custom_string", presentation_type: "text", value: "" }, value: { value_type: "custom_string", presentation_type: "text", value: "" } } },
            stat_4: { fields: { label: { value_type: "custom_string", presentation_type: "text", value: "" }, value: { value_type: "custom_string", presentation_type: "text", value: "" } } },
            stat_5: { fields: { label: { value_type: "custom_string", presentation_type: "text", value: "" }, value: { value_type: "custom_string", presentation_type: "text", value: "" } } },
            stat_6: { fields: { label: { value_type: "custom_string", presentation_type: "text", value: "" }, value: { value_type: "custom_string", presentation_type: "text", value: "" } } }
          }
        },
        widget_bottom_progress: {
          layout: "widget_bottom_progress",
          components: {
            progress: {
              fields: {
                label: { value_type: "custom_string", presentation_type: "text", value: "Progress:" },
                value: { value_type: "data", presentation_type: "number", value: "minutes_since" },
                max_value: { value_type: "custom_string", presentation_type: "number", value: "100" }
              }
            }
          }
        },
        widget_bottom_collection: {
          layout: "widget_bottom_collection",
          components: {
            collection: {
              fields: {
                items: { value_type: "custom_string", presentation_type: "text", value: "Item 1, Item 2, Item 3" }
              }
            }
          }
        }
      },
      widget_top: {
        widget_top_contained: {
          layout: "widget_top_contained",
          components: {
            title: { fields: { text: { value_type: "custom_string", presentation_type: "text", value: "Title" } } },
            contained_image: { fields: { image: { value_type: "application_asset", presentation_type: "image", value: "" } } }
          }
        }
      },
      mini_profile: {
        mini_profile_hero_stat: {
          layout: "mini_profile_hero_stat",
          components: {
            stat: { fields: { text: { value_type: "data", presentation_type: "text", value: "" } } },
            hero_image: { fields: { image: { value_type: "application_asset", presentation_type: "image", value: "" } } }
          }
        }
      },
      add_widget_preview: {
        add_widget_preview_contained: {
          layout: "add_widget_preview_contained",
          components: {
            contained_image: { fields: { image: { value_type: "application_asset", presentation_type: "image", value: "" } } }
          }
        }
      },
      activity_accessory: {
        activity_accessory_stat: {
          layout: "activity_accessory_stat",
          components: {
            stat: { fields: { text: { value_type: "data", presentation_type: "text", value: "" } } }
          }
        }
      }
    };

    const DATA_OPTIONS = [
      { value: "", label: "-- Static Text --" },
      { value: "minutes_since_formatted", label: "Time Elapsed (Formatted: 20yr 5day 3h)" },
      { value: "minutes_since", label: "Time Elapsed (Total Minutes)" },
      { value: "discord_wasted_formatted", label: "Discord Call Time (Formatted: 1day 7h)" },
      { value: "discord_wasted", label: "Discord Call Time (Total Minutes)" },
      { value: "lol_stats", label: "League of Legends Live Companion 🎮" },
      { value: "In_Call", label: "Voice Call Status 📞" },
      { value: "Spotify_song", label: "Spotify Current Song 🎧" }
    ];

    (this.settings.customVariables || []).forEach(v => {
      if (v.name) DATA_OPTIONS.push({ value: v.name, label: `Custom: ${v.name}` });
    });

    const ASSET_OPTIONS = (resolvedAssets || []).map(a => ({ value: a.id || a.name, label: a.name || a.id }));

    // Tab system
    const tabBar = document.createElement("div");
    tabBar.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;";
    const tabContents = {};

    const surfaces = this.settings.widgetSurfaces || {};
    const surfaceKeys = Object.keys(surfaces).sort((a,b) => {
      const order = ["widget_top","widget_bottom","mini_profile","add_widget_preview","activity_accessory"];
      return order.indexOf(a) - order.indexOf(b);
    });

    if (surfaceKeys.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:12px;opacity:.5">No surfaces to render.</div>`;
      return;
    }

    let activeTab = activeTabKey && surfaceKeys.includes(activeTabKey) ? activeTabKey : surfaceKeys[0];

    const activateTab = (key) => {
      activeTab = key;
      Object.entries(tabContents).forEach(([k, el]) => { el.style.display = k === key ? "block" : "none"; });
      tabBar.querySelectorAll(".we-tab").forEach(btn => {
        btn.style.background = btn.dataset.key === key ? "#5865f2" : "rgba(255,255,255,.08)";
      });
    };

    surfaceKeys.forEach(surfKey => {
      const btn = document.createElement("button");
      btn.className = "we-tab";
      btn.dataset.key = surfKey;
      btn.textContent = SURFACE_LABELS[surfKey] || surfKey;
      btn.style.cssText = "padding:5px 12px;border:none;border-radius:6px;cursor:pointer;color:#fff;font-size:12px;font-weight:600;background:rgba(255,255,255,.08);";
      btn.onclick = () => activateTab(surfKey);
      tabBar.appendChild(btn);

      const surfData = surfaces[surfKey];
      const content = document.createElement("div");
      content.style.display = "none";
      tabContents[surfKey] = content;

      // Layout Selector Dropdown
      const layoutRow = document.createElement("div");
      layoutRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.08);";
      layoutRow.innerHTML = `<span style="font-size:12px;color:#949ba4;min-width:50px;">Layout:</span>`;
      
      const layoutSel = document.createElement("select");
      layoutSel.classList.add("sc-input");
      layoutSel.style.cssText = "margin:0;padding:4px 8px;font-size:12px;max-width:200px;cursor:pointer;";
      
      const opts = LAYOUT_OPTIONS[surfKey] || [{ value: surfData.layout, label: surfData.layout }];
      opts.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value; o.textContent = opt.label;
        if (surfData.layout === opt.value) o.selected = true;
        layoutSel.appendChild(o);
      });

      layoutSel.onchange = () => {
        const newLayout = layoutSel.value;
        if (LAYOUT_TEMPLATES[surfKey] && LAYOUT_TEMPLATES[surfKey][newLayout]) {
          this.settings.widgetSurfaces[surfKey] = JSON.parse(JSON.stringify(LAYOUT_TEMPLATES[surfKey][newLayout]));
          this.saveSettings();
          this.renderWidgetEditor(container, resolvedAssets, activeTab);
        } else {
          BdApi.UI.showToast("No template defined for this layout in the plugin.", { type: "warning" });
        }
      };

      layoutRow.appendChild(layoutSel);
      content.appendChild(layoutRow);

      // Render components
      const components = surfData.components || {};
      Object.entries(components).forEach(([compKey, compData]) => {
        const compBox = document.createElement("div");
        compBox.style.cssText = "background:rgba(255,255,255,.04);border-radius:8px;padding:12px;margin-bottom:8px;";
        compBox.innerHTML = `<div style="font-size:11px;font-weight:700;color:#949ba4;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">${compKey}</div>`;

        const fields = compData.fields || {};
        Object.entries(fields).forEach(([fieldKey, fieldData]) => {
          const fieldRow = document.createElement("div");
          fieldRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";

          const fieldLabel = document.createElement("span");
          fieldLabel.style.cssText = "font-size:12px;color:#b5bac1;min-width:70px;";
          fieldLabel.textContent = fieldKey + ":";
          fieldRow.appendChild(fieldLabel);

          if (fieldData.presentation_type === "image") {
            const sel = document.createElement("select");
            sel.classList.add("sc-input");
            sel.style.cssText = "flex:1;margin:0;padding:5px 8px;font-size:12px;";
            if (ASSET_OPTIONS.length > 0) {
              ASSET_OPTIONS.forEach(opt => {
                const o = document.createElement("option");
                o.value = opt.value; o.textContent = opt.label;
                if (fieldData.value === opt.value) o.selected = true;
                sel.appendChild(o);
              });
            } else {
              const inp = document.createElement("input");
              inp.type = "text"; inp.classList.add("sc-input");
              inp.style.cssText = "flex:1;margin:0;padding:5px 8px;font-size:12px;";
              inp.value = fieldData.value || "";
              inp.placeholder = "Asset key";
              inp.oninput = () => { this.settings.widgetSurfaces[surfKey].components[compKey].fields[fieldKey].value = inp.value; };
              fieldRow.appendChild(inp); compBox.appendChild(fieldRow); return;
            }
            sel.onchange = () => { this.settings.widgetSurfaces[surfKey].components[compKey].fields[fieldKey].value = sel.value; };
            fieldRow.appendChild(sel);
          } else {
            // Universal field container: dropdown + conditional input
            const fieldCol = document.createElement("div");
            fieldCol.style.cssText = "flex:1;display:flex;flex-direction:column;gap:4px;";

            const sel = document.createElement("select");
            sel.classList.add("sc-input");
            sel.style.cssText = "margin:0;padding:5px 8px;font-size:12px;cursor:pointer;";
            DATA_OPTIONS.forEach(opt => {
              const o = document.createElement("option");
              o.value = opt.value; o.textContent = opt.label;
              if (fieldData.value_type === "data" && fieldData.value === opt.value) o.selected = true;
              sel.appendChild(o);
            });
            
            // If it's a custom string, select the static text option
            const staticOpt = document.createElement("option");
            staticOpt.value = ""; staticOpt.textContent = "-- Static Text --";
            if (fieldData.value_type !== "data") staticOpt.selected = true;
            sel.insertBefore(staticOpt, sel.firstChild);

            // Handle custom unknown data values
            if (fieldData.value_type === "data" && !DATA_OPTIONS.find(x => x.value === fieldData.value)) {
              const customOpt = document.createElement("option");
              customOpt.value = fieldData.value || ""; customOpt.textContent = `(custom: ${fieldData.value || ""})`;
              customOpt.selected = true;
              sel.appendChild(customOpt);
            }

            const inp = document.createElement("input");
            inp.type = "text"; inp.classList.add("sc-input");
            inp.style.cssText = "margin:0;padding:5px 8px;font-size:12px;";
            inp.value = fieldData.value_type !== "data" ? (fieldData.value || "") : "";
            inp.placeholder = fieldKey === "label" ? "Enter label..." : "Enter text...";

            // Toggle input visibility based on source selection
            const updateVisibility = () => {
              if (sel.value === "") {
                inp.style.display = "block";
              } else {
                inp.style.display = "none";
              }
            };

            sel.onchange = () => {
              const v = sel.value;
              if (v === "") {
                fieldData.value_type = "custom_string";
                fieldData.value = inp.value;
                fieldData.presentation_type = "text";
              } else {
                fieldData.value_type = "data";
                fieldData.value = v;
                // Automatically set presentation_type based on selection
                if (v === "minutes_since_formatted" || v === "discord_wasted_formatted" || !["minutes_since", "discord_wasted"].includes(v)) {
                  fieldData.presentation_type = "text";
                } else {
                  fieldData.presentation_type = "number";
                }
              }
              updateVisibility();
              this.saveSettings();
            };

            inp.oninput = () => {
              if (fieldData.value_type !== "data") {
                fieldData.value = inp.value;
                this.saveSettings();
              }
            };

            updateVisibility();
            fieldCol.appendChild(sel);
            fieldCol.appendChild(inp);
            fieldRow.appendChild(fieldCol);
          }

          compBox.appendChild(fieldRow);
        });
        content.appendChild(compBox);
      });

      container.appendChild(content);
    });

    container.insertBefore(tabBar, container.firstChild);
    activateTab(activeTab);
  }

  getSettingsPanel() {
    const panel = document.createElement("div");
    panel.classList.add("sc-panel");

    const style = document.createElement("style");
    style.textContent = `
      .sc-panel {
        color: #dbdee1;
        font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
        padding: 28px;
        background: #2b2d31;
        border-radius: 14px;
        max-width: 880px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.25);
      }
      .sc-header {
        margin-bottom: 28px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 20px;
      }
      .sc-title {
        color: #f2f3f5;
        font-size: 26px;
        font-weight: 700;
        margin-bottom: 8px;
        letter-spacing: 0.3px;
      }
      .sc-subtitle {
        color: #949ba4;
        font-size: 15px;
      }
      
      .sc-tutorial-box {
        background: rgba(88, 101, 242, 0.06);
        border: 1px solid rgba(88, 101, 242, 0.2);
        border-radius: 10px;
        padding: 18px 22px;
        margin-bottom: 28px;
        font-size: 14px;
        line-height: 1.6;
        color: #dbdee1;
      }
      .sc-tutorial-title {
        font-weight: 700;
        color: #5865f2;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 16px;
      }
      
      .sc-status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 14px;
        margin-bottom: 28px;
      }
      .sc-status-card {
        background: #1e1f22;
        border: 1px solid #3f4147;
        border-radius: 10px;
        padding: 20px 14px;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
      }
      .sc-status-card:hover {
        border-color: #4f545c;
        transform: translateY(-2px);
        background: #232428;
      }
      .sc-status-card.selected {
        background: #232428;
      }
      .sc-status-card.selected.online {
        border-color: #23a55a;
        box-shadow: 0 0 12px rgba(35, 165, 90, 0.25);
      }
      .sc-status-card.selected.idle {
        border-color: #f0b232;
        box-shadow: 0 0 12px rgba(240, 178, 50, 0.25);
      }
      .sc-status-card.selected.dnd {
        border-color: #f23f43;
        box-shadow: 0 0 12px rgba(242, 63, 67, 0.25);
      }
      .sc-status-card.selected.invisible {
        border-color: #80848e;
        box-shadow: 0 0 12px rgba(128, 132, 142, 0.25);
      }
      .sc-status-card.selected.streaming {
        border-color: #a855f7;
        box-shadow: 0 0 12px rgba(168, 85, 247, 0.35);
      }

      .sc-dot {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        margin: 0 auto 12px auto;
        display: block;
      }
      .sc-dot.online { background: #23a55a; }
      .sc-dot.idle { background: #f0b232; }
      .sc-dot.dnd { background: #f23f43; }
      .sc-dot.invisible { background: #80848e; }
      .sc-dot.streaming { background: #a855f7; }

      .sc-status-label {
        font-size: 14px;
        font-weight: 600;
        color: #f2f3f5;
      }

      .sc-section {
        background: #1e1f22;
        border-radius: 10px;
        padding: 24px;
        margin-bottom: 24px;
        border: 1px solid #3f4147;
      }
      .sc-section-title {
        font-size: 14px;
        font-weight: 700;
        text-transform: uppercase;
        color: #949ba4;
        margin-bottom: 22px;
        letter-spacing: 0.5px;
        border-left: 3px solid #5865f2;
        padding-left: 10px;
      }
      .sc-form-group {
        margin-bottom: 24px;
      }
      .sc-form-group:last-child {
        margin-bottom: 0;
      }
      .sc-label-container {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      .sc-label {
        font-size: 13px;
        font-weight: 700;
        color: #b5bac1;
        text-transform: uppercase;
      }
      
      .sc-field-desc {
        font-size: 13px;
        color: #949ba4;
        margin-top: 8px;
        line-height: 1.5;
      }

      .sc-input, .sc-select, .sc-textarea {
        width: 100%;
        background: #111214;
        border: 1px solid #3f4147;
        border-radius: 8px;
        padding: 12px 16px;
        color: #dbdee1;
        font-family: inherit;
        font-size: 15px;
        box-sizing: border-box;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .sc-input:focus, .sc-select:focus, .sc-textarea:focus {
        border-color: #5865f2;
        box-shadow: 0 0 0 2px rgba(88, 101, 242, 0.15);
        outline: none;
      }
      .sc-textarea {
        resize: vertical;
        min-height: 100px;
      }

      .sc-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }

      .sc-toggle-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #111214;
        padding: 14px 18px;
        border-radius: 8px;
        border: 1px solid #3f4147;
        margin-bottom: 20px;
      }
      .sc-toggle-label {
        font-size: 14px;
        font-weight: 600;
        color: #dbdee1;
      }
      
      .sc-switch {
        position: relative;
        display: inline-block;
        width: 48px;
        height: 26px;
      }
      .sc-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .sc-slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: #4e5058;
        transition: .2s;
        border-radius: 26px;
      }
      .sc-slider:before {
        position: absolute;
        content: "";
        height: 20px;
        width: 20px;
        left: 3px;
        bottom: 3px;
        background-color: #f2f3f5;
        transition: .2s;
        border-radius: 50%;
      }
      input:checked + .sc-slider {
        background-color: #23a55a;
      }
      input:checked + .sc-slider:before {
        transform: translateX(22px);
      }

      .sc-actions {
        display: flex;
        justify-content: flex-end;
        gap: 16px;
        margin-top: 28px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        padding-top: 20px;
      }
      .sc-btn {
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: background-color 0.15s, transform 0.1s;
      }
      .sc-btn:active {
        transform: scale(0.97);
      }
      .sc-btn-primary {
        background: #5865f2;
        color: white;
      }
      .sc-btn-primary:hover {
        background: #4752c4;
      }
      .sc-btn-secondary {
        background: #4e5058;
        color: white;
      }
      .sc-btn-secondary:hover {
        background: #6d6f78;
      }
      .sc-btn-danger {
        background: rgba(242, 63, 67, 0.1);
        color: #f23f43;
        border: 1px solid rgba(242, 63, 67, 0.3);
      }
      .sc-btn-danger:hover {
        background: rgba(242, 63, 67, 0.2);
      }
      
      .sc-badge {
        background: rgba(240, 178, 50, 0.1);
        color: #f0b232;
        border: 1px solid rgba(240, 178, 50, 0.3);
        border-radius: 4px;
        padding: 2px 8px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
      }
      
      .sc-step-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
        background: #111214;
        padding: 10px;
        border-radius: 6px;
        border: 1px solid #3f4147;
      }
      .sc-step-num {
        font-size: 12px;
        font-weight: 700;
        color: #5865f2;
        min-width: 50px;
      }
      .sc-step-inputs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        flex-grow: 1;
      }
      .sc-btn-sm {
        padding: 6px 12px;
        font-size: 12px;
      }
      .sc-steps-container {
        margin-top: 16px;
      }
      .sc-steps-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
    `;
    panel.appendChild(style);

    const header = document.createElement("div");
    header.classList.add("sc-header");

    const title = document.createElement("h1");
    title.classList.add("sc-title");
    title.textContent = "Status Editor";
    header.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.classList.add("sc-subtitle");
    subtitle.textContent = "Manage status and custom activities.";
    header.appendChild(subtitle);

    panel.appendChild(header);

    const presetSection = document.createElement("div");
    presetSection.classList.add("sc-section");
    presetSection.innerHTML = `<div class="sc-section-title">Presence Status Preset</div>`;

    const grid = document.createElement("div");
    grid.classList.add("sc-status-grid");

    const statuses = [
      { id: "online", label: "Online" },
      { id: "idle", label: "Idle" },
      { id: "dnd", label: "Do Not Disturb" },
      { id: "invisible", label: "Invisible" },
      { id: "streaming", label: "Purple Streaming" }
    ];

    statuses.forEach(st => {
      const card = document.createElement("div");
      card.classList.add("sc-status-card", st.id);
      if (this.settings.status === st.id) {
        card.classList.add("selected");
      }

      const dot = document.createElement("span");
      dot.classList.add("sc-dot", st.id);
      card.appendChild(dot);

      const label = document.createElement("div");
      label.classList.add("sc-status-label");
      label.textContent = st.label;
      card.appendChild(label);

      card.onclick = () => {
        grid.querySelectorAll(".sc-status-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        this.settings.status = st.id;

        if (st.id === "streaming") {
          activitySection.style.display = "block";
          streamUrlGroup.style.display = "block";
        } else {
          if (customActivityCheck.checked) {
            activitySection.style.display = "block";
            if (activityTypeSelect.value === "1") {
              streamUrlGroup.style.display = "block";
            } else {
              streamUrlGroup.style.display = "none";
            }
          } else {
            activitySection.style.display = "none";
          }
        }
      };

      grid.appendChild(card);
    });

    presetSection.appendChild(grid);

    const customActivityToggle = document.createElement("div");
    customActivityToggle.classList.add("sc-toggle-container");

    const toggleLabel = document.createElement("span");
    toggleLabel.classList.add("sc-toggle-label");
    toggleLabel.textContent = "Enable Custom Presence Activity";
    customActivityToggle.appendChild(toggleLabel);

    const switchLabel = document.createElement("label");
    switchLabel.classList.add("sc-switch");

    const customActivityCheck = document.createElement("input");
    customActivityCheck.type = "checkbox";
    customActivityCheck.checked = this.settings.enableCustomActivity;
    customActivityCheck.onchange = () => {
      this.settings.enableCustomActivity = customActivityCheck.checked;

      if (this.settings.status === "streaming" || customActivityCheck.checked) {
        activitySection.style.display = "block";
      } else {
        activitySection.style.display = "none";
      }
    };

    switchLabel.appendChild(customActivityCheck);
    const slider = document.createElement("span");
    slider.classList.add("sc-slider");
    switchLabel.appendChild(slider);
    customActivityToggle.appendChild(switchLabel);
    presetSection.appendChild(customActivityToggle);

    panel.appendChild(presetSection);

    const activitySection = document.createElement("div");
    activitySection.classList.add("sc-section");
    activitySection.innerHTML = `<div class="sc-section-title">Activity Configuration</div>`;

    if (this.settings.status !== "streaming" && !this.settings.enableCustomActivity) {
      activitySection.style.display = "none";
    }

    const actRow = document.createElement("div");
    actRow.classList.add("sc-row");

    const nameGroup = document.createElement("div");
    nameGroup.classList.add("sc-form-group");
    nameGroup.innerHTML = `
      <div class="sc-label-container">
        <span class="sc-label">Activity Name</span>
      </div>
    `;
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.classList.add("sc-input");
    nameInput.value = this.settings.activityName;
    nameInput.placeholder = "";
    nameInput.oninput = () => {
      this.settings.activityName = nameInput.value;
    };
    nameGroup.appendChild(nameInput);
    actRow.appendChild(nameGroup);

    const typeGroup = document.createElement("div");
    typeGroup.classList.add("sc-form-group");
    typeGroup.innerHTML = `
      <div class="sc-label-container">
        <span class="sc-label">Activity Type</span>
      </div>
    `;
    const activityTypeSelect = document.createElement("select");
    activityTypeSelect.classList.add("sc-select");
    const types = [
      { val: "0", text: "Playing" },
      { val: "1", text: "Streaming" },
      { val: "2", text: "Listening" },
      { val: "3", text: "Watching" },
      { val: "5", text: "Competing" }
    ];
    types.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.val;
      opt.textContent = t.text;
      if (this.settings.activityType.toString() === t.val) {
        opt.selected = true;
      }
      activityTypeSelect.appendChild(opt);
    });
    activityTypeSelect.onchange = () => {
      this.settings.activityType = parseInt(activityTypeSelect.value);
      if (activityTypeSelect.value === "1") {
        streamUrlGroup.style.display = "block";
      } else {
        streamUrlGroup.style.display = "none";
      }
    };
    typeGroup.appendChild(activityTypeSelect);
    actRow.appendChild(typeGroup);

    activitySection.appendChild(actRow);

    const streamUrlGroup = document.createElement("div");
    streamUrlGroup.classList.add("sc-form-group");
    streamUrlGroup.innerHTML = `
      <div class="sc-label-container">
        <span class="sc-label">Streaming URL</span>
        <span class="sc-badge">Required for Purple Status</span>
      </div>
    `;
    if (this.settings.status !== "streaming" && this.settings.activityType !== 1) {
      streamUrlGroup.style.display = "none";
    }
    const streamInput = document.createElement("input");
    streamInput.type = "text";
    streamInput.classList.add("sc-input");
    streamInput.value = this.settings.streamUrl;
    streamInput.placeholder = "";
    streamInput.oninput = () => {
      this.settings.streamUrl = streamInput.value;
    };
    streamUrlGroup.appendChild(streamInput);
    activitySection.appendChild(streamUrlGroup);

    const appIdGroup = document.createElement("div");
    appIdGroup.classList.add("sc-form-group");
    appIdGroup.style.marginTop = "16px";
    appIdGroup.innerHTML = `
      <div class="sc-label-container">
        <span class="sc-label">Application ID (Client ID)</span>
      </div>
    `;
    const appIdInput = document.createElement("input");
    appIdInput.type = "text";
    appIdInput.classList.add("sc-input");
    appIdInput.value = this.settings.applicationId || "";
    appIdInput.placeholder = "";
    appIdInput.oninput = () => {
      this.settings.applicationId = appIdInput.value;
    };
    appIdGroup.appendChild(appIdInput);
    const appIdDesc = document.createElement("div");
    appIdDesc.classList.add("sc-field-desc");
    appIdDesc.textContent = "If left empty, the custom activity will only be visible to you locally.";
    appIdGroup.appendChild(appIdDesc);
    activitySection.appendChild(appIdGroup);

    panel.appendChild(activitySection);

    const rotationSection = document.createElement("div");
    rotationSection.classList.add("sc-section");
    rotationSection.innerHTML = `<div class="sc-section-title">Text Rotation & Static Status</div>`;

    const staticInputsRow = document.createElement("div");
    staticInputsRow.classList.add("sc-row");

    const detailsGroup = document.createElement("div");
    detailsGroup.classList.add("sc-form-group");
    detailsGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Static Details</span></div>`;
    const detailsInput = document.createElement("input");
    detailsInput.type = "text";
    detailsInput.classList.add("sc-input");
    detailsInput.value = this.settings.details || "";
    detailsInput.placeholder = "";
    detailsInput.oninput = () => {
      this.settings.details = detailsInput.value;
    };
    detailsGroup.appendChild(detailsInput);
    const detailsDesc = document.createElement("div");
    detailsDesc.classList.add("sc-field-desc");
    detailsDesc.textContent = "Details: First description line below activity name.";
    detailsGroup.appendChild(detailsDesc);
    staticInputsRow.appendChild(detailsGroup);

    const stateGroup = document.createElement("div");
    stateGroup.classList.add("sc-form-group");
    stateGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Static State</span></div>`;
    const stateInput = document.createElement("input");
    stateInput.type = "text";
    stateInput.classList.add("sc-input");
    stateInput.value = this.settings.state || "";
    stateInput.placeholder = "";
    stateInput.oninput = () => {
      this.settings.state = stateInput.value;
    };
    stateGroup.appendChild(stateInput);
    const stateDesc = document.createElement("div");
    stateDesc.classList.add("sc-field-desc");
    stateDesc.textContent = "State: Second description line below details.";
    stateGroup.appendChild(stateDesc);
    staticInputsRow.appendChild(stateGroup);

    rotationSection.appendChild(staticInputsRow);

    const cycleToggle = document.createElement("div");
    cycleToggle.classList.add("sc-toggle-container");
    cycleToggle.style.marginTop = "16px";

    const cycleToggleLabel = document.createElement("span");
    cycleToggleLabel.classList.add("sc-toggle-label");
    cycleToggleLabel.textContent = "Enable Text Cycling";
    cycleToggle.appendChild(cycleToggleLabel);

    const cycleSwitchLabel = document.createElement("label");
    cycleSwitchLabel.classList.add("sc-switch");

    const cycleCheck = document.createElement("input");
    cycleCheck.type = "checkbox";
    cycleCheck.checked = this.settings.cycleEnabled;
    cycleCheck.onchange = () => {
      this.settings.cycleEnabled = cycleCheck.checked;
    };

    cycleSwitchLabel.appendChild(cycleCheck);
    const cycleSlider = document.createElement("span");
    cycleSlider.classList.add("sc-slider");
    cycleSwitchLabel.appendChild(cycleSlider);
    cycleToggle.appendChild(cycleSwitchLabel);
    rotationSection.appendChild(cycleToggle);

    const intervalGroup = document.createElement("div");
    intervalGroup.classList.add("sc-form-group");
    intervalGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Cycle Interval (ms)</span></div>`;

    const intervalInput = document.createElement("input");
    intervalInput.type = "number";
    intervalInput.classList.add("sc-input");
    intervalInput.value = this.settings.cycleInterval || 5000;
    intervalInput.min = "1000";
    intervalInput.step = "1000";
    intervalInput.oninput = () => {
      this.settings.cycleInterval = Math.max(1000, parseInt(intervalInput.value) || 5000);
    };
    intervalGroup.appendChild(intervalInput);
    rotationSection.appendChild(intervalGroup);

    const stepsContainer = document.createElement("div");
    stepsContainer.classList.add("sc-steps-container");

    const renderSteps = () => {
      stepsContainer.innerHTML = "";

      const stepsHeader = document.createElement("div");
      stepsHeader.classList.add("sc-steps-header");
      stepsHeader.innerHTML = `<span class="sc-label">Text Rotation Steps (${this.settings.steps.length}/10)</span>`;

      const addBtn = document.createElement("button");
      addBtn.classList.add("sc-btn", "sc-btn-secondary", "sc-btn-sm");
      addBtn.textContent = "+ Add Step";
      if (this.settings.steps.length >= 10) {
        addBtn.disabled = true;
      }
      addBtn.onclick = (e) => {
        e.preventDefault();
        if (this.settings.steps.length < 10) {
          this.settings.steps.push({ details: "", state: "" });
          renderSteps();
        }
      };
      stepsHeader.appendChild(addBtn);
      stepsContainer.appendChild(stepsHeader);

      this.settings.steps.forEach((step, idx) => {
        const row = document.createElement("div");
        row.classList.add("sc-step-row");

        const num = document.createElement("span");
        num.classList.add("sc-step-num");
        num.textContent = `Step ${idx + 1}`;
        row.appendChild(num);

        const inputsDiv = document.createElement("div");
        inputsDiv.classList.add("sc-step-inputs");

        const detInput = document.createElement("input");
        detInput.type = "text";
        detInput.classList.add("sc-input");
        detInput.value = step.details || "";
        detInput.placeholder = "Details text...";
        detInput.oninput = () => {
          step.details = detInput.value;
        };

        const stInput = document.createElement("input");
        stInput.type = "text";
        stInput.classList.add("sc-input");
        stInput.value = step.state || "";
        stInput.placeholder = "State text...";
        stInput.oninput = () => {
          step.state = stInput.value;
        };

        inputsDiv.appendChild(detInput);
        inputsDiv.appendChild(stInput);
        row.appendChild(inputsDiv);

        const delBtn = document.createElement("button");
        delBtn.classList.add("sc-btn", "sc-btn-danger", "sc-btn-sm");
        delBtn.textContent = "Remove";
        if (this.settings.steps.length <= 1) {
          delBtn.disabled = true;
        }
        delBtn.onclick = (e) => {
          e.preventDefault();
          if (this.settings.steps.length > 1) {
            this.settings.steps.splice(idx, 1);
            renderSteps();
          }
        };
        row.appendChild(delBtn);

        stepsContainer.appendChild(row);
      });
    };

    renderSteps();
    rotationSection.appendChild(stepsContainer);

    panel.appendChild(rotationSection);

    const widgetSection = document.createElement("div");
    widgetSection.classList.add("sc-section");
    widgetSection.innerHTML = `<div class="sc-section-title">🎨 Discord Widget Editor</div>`;

    // Credentials
    const widgetCredsRow = document.createElement("div");
    widgetCredsRow.classList.add("sc-row");
    const wAppGroup = document.createElement("div"); wAppGroup.classList.add("sc-form-group");
    wAppGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Application ID</span></div>`;
    const wAppInput = document.createElement("input");
    wAppInput.type = "text"; wAppInput.classList.add("sc-input");
    wAppInput.value = this.settings.widgetAppId || "";
    wAppInput.placeholder = "e.g. 1520473081284530257";
    wAppInput.oninput = () => { this.settings.widgetAppId = wAppInput.value; };
    wAppGroup.appendChild(wAppInput); widgetCredsRow.appendChild(wAppGroup);

    const wTokenGroup = document.createElement("div"); wTokenGroup.classList.add("sc-form-group");
    wTokenGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Bot Token</span></div>`;
    const wTokenInput = document.createElement("input");
    wTokenInput.type = "password"; wTokenInput.classList.add("sc-input");
    wTokenInput.value = this.settings.widgetBotToken || "";
    wTokenInput.placeholder = "Bot token for authorization";
    wTokenInput.oninput = () => { this.settings.widgetBotToken = wTokenInput.value; };
    wTokenGroup.appendChild(wTokenInput); widgetCredsRow.appendChild(wTokenGroup);
    widgetSection.appendChild(widgetCredsRow);

    // Config ID
    const wConfigGroup = document.createElement("div"); wConfigGroup.classList.add("sc-form-group"); wConfigGroup.style.marginTop = "10px";
    wConfigGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Widget Config ID</span><span style="font-size:11px;opacity:.5;margin-left:8px;">(numer z URL /widget-configs/NUMER)</span></div>`;
    const wConfigInput = document.createElement("input");
    wConfigInput.type = "text"; wConfigInput.classList.add("sc-input");
    wConfigInput.value = this.settings.widgetConfigId || "";
    wConfigInput.placeholder = "e.g. 1520474760562348042";
    wConfigInput.oninput = () => { this.settings.widgetConfigId = wConfigInput.value; };
    wConfigGroup.appendChild(wConfigInput); widgetSection.appendChild(wConfigGroup);

    // Auto-sync toggle
    const wAutoSyncToggle = document.createElement("div"); wAutoSyncToggle.classList.add("sc-toggle-container"); wAutoSyncToggle.style.marginTop = "16px";
    const wAutoSyncLabel = document.createElement("span"); wAutoSyncLabel.classList.add("sc-toggle-label"); wAutoSyncLabel.textContent = "Enable Auto-Sync Widget";
    wAutoSyncToggle.appendChild(wAutoSyncLabel);
    const wAutoSyncSwitchLabel = document.createElement("label"); wAutoSyncSwitchLabel.classList.add("sc-switch");
    const wAutoSyncCheck = document.createElement("input"); wAutoSyncCheck.type = "checkbox"; wAutoSyncCheck.checked = this.settings.widgetAutoSync;
    wAutoSyncCheck.onchange = () => { this.settings.widgetAutoSync = wAutoSyncCheck.checked; };
    wAutoSyncSwitchLabel.appendChild(wAutoSyncCheck);
    const wAutoSyncSlider = document.createElement("span"); wAutoSyncSlider.classList.add("sc-slider");
    wAutoSyncSwitchLabel.appendChild(wAutoSyncSlider); wAutoSyncToggle.appendChild(wAutoSyncSwitchLabel);
    widgetSection.appendChild(wAutoSyncToggle);

    const wIntervalGroup = document.createElement("div"); wIntervalGroup.classList.add("sc-form-group");
    wIntervalGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Sync Interval (minutes)</span><span class="sc-badge">Min 1</span></div>`;
    const wIntervalInput = document.createElement("input"); wIntervalInput.type = "number"; wIntervalInput.classList.add("sc-input");
    wIntervalInput.value = this.settings.widgetSyncInterval || 15; wIntervalInput.min = "1";
    wIntervalInput.oninput = () => { this.settings.widgetSyncInterval = Math.max(1, parseInt(wIntervalInput.value) || 15); };
    wIntervalGroup.appendChild(wIntervalInput); widgetSection.appendChild(wIntervalGroup);

    // Tracked time - Target date
    const wDynSection = document.createElement("div"); wDynSection.style.marginTop = "16px";
    wDynSection.innerHTML = `<div style="font-size:13px;font-weight:600;color:#b5bac1;margin-bottom:10px;">⏱️ Tracked Time (for dynamic data fields)</div>`;
    const wDynRow = document.createElement("div"); wDynRow.classList.add("sc-row");
    const wBdGroup = document.createElement("div"); wBdGroup.classList.add("sc-form-group");
    wBdGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Life Start Date</span></div>`;
    const wBdInput = document.createElement("input"); wBdInput.type = "datetime-local"; wBdInput.classList.add("sc-input");
    wBdInput.value = this.settings.targetDate || "";
    wBdInput.onchange = () => { this.settings.targetDate = wBdInput.value; };
    wBdGroup.appendChild(wBdInput); wDynRow.appendChild(wBdGroup);
    const wCallGroup = document.createElement("div"); wCallGroup.classList.add("sc-form-group");
    wCallGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Discord Call Minutes</span></div>`;
    const wCallContent = document.createElement("div"); wCallContent.style.cssText = "display:flex;gap:8px;align-items:center;";
    const wCallMinDisplay = document.createElement("div"); wCallMinDisplay.id = "sc-call-min-display";
    wCallMinDisplay.style.cssText = "color:#dbdee1;font-size:13px;min-width:60px;"; wCallMinDisplay.textContent = (this.settings.totalCallMinutes || 0) + " min";
    const wCallResetBtn = document.createElement("button"); wCallResetBtn.classList.add("sc-btn", "sc-btn-danger"); wCallResetBtn.style.cssText = "padding:6px 12px;white-space:nowrap;";
    wCallResetBtn.textContent = "Reset";
    wCallResetBtn.onclick = () => { this.settings.totalCallMinutes = 0; this.saveSettings(); wCallMinDisplay.textContent = "0 min"; BdApi.UI.showToast("Call minutes reset!", { type: "info" }); };
    wCallContent.appendChild(wCallMinDisplay); wCallContent.appendChild(wCallResetBtn);
    wCallGroup.appendChild(wCallContent); wDynRow.appendChild(wCallGroup);
    wDynSection.appendChild(wDynRow); widgetSection.appendChild(wDynSection);


    // === CUSTOM VARIABLES SECTION (STANDALONE) ===
    const customVarsSection = document.createElement("div");
    customVarsSection.classList.add("sc-section");
    customVarsSection.style.marginTop = "20px";
    customVarsSection.innerHTML = `
      <div class="sc-section-title">📜 Custom Scripts & Variables</div>
      <div class="sc-tutorial-box">
        <div class="sc-tutorial-title">Menedżer własnych skryptów i zapytań API</div>
        Tutaj możesz tworzyć własne zmienne. Dowolna zmienna dodana w tej sekcji automatycznie pojawi się w edytorze widgetów jako źródło danych.
      </div>
    `;

    const cvHeader = document.createElement("div");
    cvHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;margin-top:10px;";
    cvHeader.innerHTML = `<div style="font-size:13px;font-weight:700;color:#f2f3f5;">Zdefiniowane Zmienne</div>`;

    const addCvBtn = document.createElement("button");
    addCvBtn.classList.add("sc-btn", "sc-btn-secondary", "sc-btn-sm");
    addCvBtn.style.padding = "4px 10px";
    addCvBtn.style.fontSize = "11px";
    addCvBtn.textContent = "+ Add Variable";
    addCvBtn.onclick = (e) => {
      e.preventDefault();
      this.settings.customVariables = this.settings.customVariables || [];
      this.settings.customVariables.push({ name: "my_var", type: "static", code: "Hello", jsonPath: "" });
      this.saveSettings();
      renderCustomVars();
      if (this.settings.widgetSurfaces) {
        this.renderWidgetEditor(editorBody, this.currentResolvedAssets || []);
      }
    };
    cvHeader.appendChild(addCvBtn);
    customVarsSection.appendChild(cvHeader);

    const cvContainer = document.createElement("div");
    cvContainer.style.cssText = "display:flex;flex-direction:column;gap:8px;";
    customVarsSection.appendChild(cvContainer);

    const renderCustomVars = () => {
      cvContainer.innerHTML = "";
      const vars = this.settings.customVariables || [];
      if (vars.length === 0) {
        cvContainer.innerHTML = `<div style="text-align:center;font-size:12px;opacity:.4;padding:10px 0;">Brak własnych zmiennych. Kliknij "+ Add Variable" aby stworzyć pierwszą.</div>`;
        return;
      }
      vars.forEach((v, idx) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;flex-direction:column;gap:8px;background:rgba(0,0,0,0.18);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.03);margin-bottom:6px;";

        const topRow = document.createElement("div");
        topRow.style.cssText = "display:flex;gap:12px;align-items:flex-end;";

        // Name group
        const nameGroup = document.createElement("div");
        nameGroup.style.cssText = "flex:1;display:flex;flex-direction:column;gap:4px;";
        nameGroup.innerHTML = `<span style="font-size:11px;font-weight:600;color:#949ba4;">Nazwa zmiennej</span>`;
        const nameInput = document.createElement("input");
        nameInput.type = "text"; nameInput.classList.add("sc-input");
        nameInput.style.cssText = "margin:0;padding:6px 10px;font-size:12px;";
        nameInput.value = v.name || "";
        nameInput.placeholder = "np. moja_zmienna";
        nameInput.oninput = () => {
          v.name = nameInput.value.trim().replace(/[^a-zA-Z0-9_]/g, "");
          this.saveSettings();
          if (this.settings.widgetSurfaces) {
            this.renderWidgetEditor(editorBody, this.currentResolvedAssets || []);
          }
        };
        nameGroup.appendChild(nameInput);
        topRow.appendChild(nameGroup);

        // Type group
        const typeGroup = document.createElement("div");
        typeGroup.style.cssText = "width:150px;display:flex;flex-direction:column;gap:4px;";
        typeGroup.innerHTML = `<span style="font-size:11px;font-weight:600;color:#949ba4;">Typ źródła</span>`;
        const typeSel = document.createElement("select");
        typeSel.classList.add("sc-input");
        typeSel.style.cssText = "margin:0;padding:5px 10px;font-size:12px;cursor:pointer;";
        [
          { value: "static", label: "Static Text" },
          { value: "js", label: "JavaScript Code" },
          { value: "url", label: "Fetch JSON URL" }
        ].forEach(opt => {
          const o = document.createElement("option");
          o.value = opt.value; o.textContent = opt.label;
          if (v.type === opt.value) o.selected = true;
          typeSel.appendChild(o);
        });
        typeSel.onchange = () => {
          v.type = typeSel.value;
          this.saveSettings();
          renderCustomVars();
          if (this.settings.widgetSurfaces) {
            this.renderWidgetEditor(editorBody, this.currentResolvedAssets || []);
          }
        };
        typeGroup.appendChild(typeSel);
        topRow.appendChild(typeGroup);

        // Remove button
        const rmBtn = document.createElement("button");
        rmBtn.classList.add("sc-btn", "sc-btn-danger");
        rmBtn.style.cssText = "padding:6px 12px;font-size:12px;height:32px;align-self:flex-end;margin-bottom:1px;";
        rmBtn.textContent = "Remove";
        rmBtn.onclick = (e) => {
          e.preventDefault();
          this.settings.customVariables.splice(idx, 1);
          this.saveSettings();
          renderCustomVars();
          if (this.settings.widgetSurfaces) {
            this.renderWidgetEditor(editorBody, this.currentResolvedAssets || []);
          }
        };
        topRow.appendChild(rmBtn);
        row.appendChild(topRow);

        // Detail Row (Code/URL input)
        const detailRow = document.createElement("div");
        detailRow.style.cssText = "display:flex;flex-direction:column;gap:6px;";

        const codeLabel = document.createElement("span");
        codeLabel.style.cssText = "font-size:11px;font-weight:600;color:#949ba4;";
        if (v.type === "static") {
          codeLabel.textContent = "Stała Wartość Tekstowa";
        } else if (v.type === "js") {
          codeLabel.textContent = "Skrypt JavaScript (musi zwracać wartość)";
        } else if (v.type === "url") {
          codeLabel.textContent = "Adres URL zapytania API (JSON)";
        }
        detailRow.appendChild(codeLabel);

        const codeInput = document.createElement("textarea");
        codeInput.classList.add("sc-textarea");
        codeInput.style.cssText = "font-family:monospace;font-size:11px;min-height:50px;padding:8px;margin:0;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.05);border-radius:6px;";
        codeInput.value = v.code || "";
        if (v.type === "static") {
          codeInput.placeholder = "Wpisz statyczny tekst...";
        } else if (v.type === "js") {
          codeInput.placeholder = "np. return BdApi.Webpack.getStore('UserStore').getCurrentUser().username;";
        } else if (v.type === "url") {
          codeInput.placeholder = "np. https://api.myip.com lub inny JSON API URL...";
        }
        codeInput.oninput = () => { v.code = codeInput.value; this.saveSettings(); };
        detailRow.appendChild(codeInput);

        if (v.type === "url") {
          const jpLabel = document.createElement("span");
          jpLabel.style.cssText = "font-size:11px;font-weight:600;color:#949ba4;margin-top:2px;";
          jpLabel.textContent = "Ścieżka JSONPath do wartości (opcjonalnie)";
          detailRow.appendChild(jpLabel);

          const jpInput = document.createElement("input");
          jpInput.type = "text"; jpInput.classList.add("sc-input");
          jpInput.style.cssText = "margin:0;padding:6px 10px;font-size:11px;";
          jpInput.value = v.jsonPath || "";
          jpInput.placeholder = "np. ip lub dane.kraj.nazwa (puste wyśle cały obiekt JSON)";
          jpInput.oninput = () => { jpInput.value = jpInput.value.trim(); v.jsonPath = jpInput.value; this.saveSettings(); };
          detailRow.appendChild(jpInput);
        }

        row.appendChild(detailRow);
        cvContainer.appendChild(row);
      });
    };

    renderCustomVars();

    // === DYNAMIC WIDGET EDITOR ===
    const wEditorSection = document.createElement("div"); wEditorSection.style.marginTop = "20px";
    const editorHeader = document.createElement("div"); editorHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;";
    editorHeader.innerHTML = `<div style="font-size:14px;font-weight:700;color:#f2f3f5;">🖊️ Widget Layout Editor</div>`;
    const loadEditorBtn = document.createElement("button"); loadEditorBtn.classList.add("sc-btn", "sc-btn-primary"); loadEditorBtn.style.cssText = "padding:6px 14px;font-size:12px;";
    loadEditorBtn.textContent = "⟳ Load from Discord";
    loadEditorBtn.onclick = () => {
      this.settings.widgetAppId = wAppInput.value;
      this.settings.widgetConfigId = wConfigInput.value;
      this.saveSettings();
      if (!this.settings.widgetAppId || !this.settings.widgetConfigId) {
        BdApi.UI.showToast("Uzupelnij App ID i Config ID!", { type: "error" }); return;
      }
      this.loadWidgetEditorInto(editorBody);
    };
    editorHeader.appendChild(loadEditorBtn); wEditorSection.appendChild(editorHeader);
    const editorBody = document.createElement("div"); editorBody.style.cssText = "background:rgba(0,0,0,.2);border-radius:10px;padding:16px;min-height:60px;";
    editorBody.innerHTML = `<div style="text-align:center;opacity:.45;font-size:13px;padding:16px 0;">Kliknij "⟳ Load from Discord" aby zobaczyc i edytowac layout widgetu</div>`;
    wEditorSection.appendChild(editorBody); widgetSection.appendChild(wEditorSection);
 
    // === ACTION BUTTONS ===
    const wSaveBtn = document.createElement("button"); wSaveBtn.classList.add("sc-btn"); 
    wSaveBtn.style.cssText = "margin-top:14px;width:100%;background:linear-gradient(135deg,#5865f2,#7289da);color:#fff;font-weight:700;font-size:14px;padding:12px;border-radius:8px;border:none;cursor:pointer;";
    wSaveBtn.textContent = "💾 Save Layout to Portal + Push Live Data";
    wSaveBtn.onclick = () => { this.saveSettings(); this.pushWidgetConfig(); };
    widgetSection.appendChild(wSaveBtn);
 
    const wPushBtn = document.createElement("button"); wPushBtn.classList.add("sc-btn", "sc-btn-primary"); wPushBtn.style.cssText = "margin-top:8px;width:100%;";
    wPushBtn.textContent = "↑ Push Live Data Only (fast)";
    wPushBtn.onclick = () => { this.saveSettings(); this.pushWidget(); };
    widgetSection.appendChild(wPushBtn);
 
    const wAddBtn = document.createElement("button"); wAddBtn.classList.add("sc-btn"); wAddBtn.style.cssText = "margin-top:8px;width:100%;background:#43b581;color:white;border:none;cursor:pointer;border-radius:6px;padding:8px;font-weight:600;";
    wAddBtn.textContent = "🔗 Force Add Widget to Profile";
    wAddBtn.onclick = async () => {
      try {
        const appId = this.settings.widgetAppId;
        if (!appId) { BdApi.UI.showToast("App ID nie ustawiony!", {type:"error"}); return; }
        const AuthStore = BdApi.Webpack.getStore("AuthenticationStore");
        const UserStore = BdApi.Webpack.getStore("UserStore");
        const token = AuthStore?.getToken();
        const id = UserStore.getCurrentUser().id;
        let res = await BdApi.Net.fetch("https://discord.com/api/v9/users/" + id + "/profile", { headers: { "Authorization": token } });
        let data = await res.json(); let widgets = data.widgets || [];
        if (widgets.map(x=>x.data?.application_id).includes(appId)) { BdApi.UI.showToast("Widget juz przypietu!", {type:"warning"}); return; }
        widgets.unshift({"data": {"type": "application", "application_id": appId}});
        let put = await BdApi.Net.fetch("https://discord.com/api/v9/users/@me/widgets", { method:"PUT", headers:{"Authorization":token,"Content-Type":"application/json"}, body: JSON.stringify({widgets}) });
        if (!put.ok) { BdApi.UI.showToast("Blad: " + await put.text(), {type:"error"}); return; }
        BdApi.UI.showToast("SUKCES! Widget przypiety! Odswierz (Ctrl+R)", {type:"success"});
      } catch(e) { BdApi.UI.showToast("Blad dodawania widgetu", {type:"error"}); console.error(e); }
    };
    widgetSection.appendChild(wAddBtn);
 
    panel.appendChild(widgetSection);
    panel.appendChild(customVarsSection);

    const actions = document.createElement("div");
    actions.classList.add("sc-actions");

    const resetBtn = document.createElement("button");
    resetBtn.classList.add("sc-btn", "sc-btn-danger");
    resetBtn.textContent = "Reset to Defaults";
    resetBtn.onclick = () => {
      this.settings = { ...this.defaultSettings };
      this.applySettings();

      grid.querySelectorAll(".sc-status-card").forEach(c => {
        c.classList.remove("selected");
        if (c.classList.contains(this.settings.status)) {
          c.classList.add("selected");
        }
      });
      customActivityCheck.checked = this.settings.enableCustomActivity;
      nameInput.value = this.settings.activityName;
      activityTypeSelect.value = this.settings.activityType.toString();
      streamInput.value = this.settings.streamUrl;
      detailsInput.value = this.settings.details || "";
      stateInput.value = this.settings.state || "";
      cycleCheck.checked = this.settings.cycleEnabled;
      intervalInput.value = this.settings.cycleInterval.toString();
      appIdInput.value = this.settings.applicationId || "";
      wAppInput.value = this.settings.widgetAppId || "";
      wTokenInput.value = this.settings.widgetBotToken || "";
      wAutoSyncCheck.checked = this.settings.widgetAutoSync;
      wIntervalInput.value = this.settings.widgetSyncInterval.toString();
      wBdInput.value = this.settings.targetDate || "";
      wCallMinDisplay.textContent = (this.settings.totalCallMinutes || 0) + " min";

      renderSteps();

      if (this.settings.status === "streaming" || customActivityCheck.checked) {
        activitySection.style.display = "block";
      } else {
        activitySection.style.display = "none";
      }
      if (activityTypeSelect.value === "1") {
        streamUrlGroup.style.display = "block";
      } else {
        streamUrlGroup.style.display = "none";
      }

      BdApi.UI.showToast("Settings reset to defaults!", { type: "info" });
    };
    actions.appendChild(resetBtn);

    const applyBtn = document.createElement("button");
    applyBtn.classList.add("sc-btn", "sc-btn-primary");
    applyBtn.textContent = "Apply Settings";
    applyBtn.onclick = () => {
      this.settings.cycleInterval = Math.max(1000, parseInt(intervalInput.value) || 5000);
      this.applySettings();
      BdApi.UI.showToast("Configuration Applied Successfully!", { type: "success" });
    };
    actions.appendChild(applyBtn);

    panel.appendChild(actions);

    return panel;
  }
};
