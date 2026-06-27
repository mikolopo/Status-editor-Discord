/**
 * @name Statuseditor
 * @version 1.0.0
 * @description Discord status and custom activity editor.
 * @author Mikolopo
 * @website https://github.com/mikolopo/Status-editor-Discord
 */

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
      detailsRotation: ["Just vibing", "Chilling", "Coding"],
      stateRotation: ["In the zone", "AFK", "Busy"],
      cycleEnabled: false,
      cycleInterval: 5000,
      applicationId: "",
      enableCustomActivity: true
    };

    const saved = BdApi.Data.load("Statuseditor", "settings");
    this.settings = saved ? { ...this.defaultSettings, ...saved } : { ...this.defaultSettings };

    this.cycleTimer = null;
    this.cycleIndex = 0;
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

    BdApi.UI.showToast("Status Editor: Activated", { type: "success" });
  }

  stop() {
    this.stopCycle();
    BdApi.Patcher.unpatchAll("Statuseditor");
    BdApi.UI.showToast("Status Editor: Deactivated", { type: "info" });
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
      const filtered = (ret || []).filter(a => a.name !== this.settings.activityName && a.name !== "Streaming");
      if (!act) return filtered;
      return [...filtered, act];
    });

    if (LocalActivityStore.getAllActivities && userId) {
      BdApi.Patcher.after("Statuseditor", LocalActivityStore, "getAllActivities", (_, __, ret) => {
        const act = this.buildActivity();
        const userActivities = ret[userId] || [];
        const filtered = userActivities.filter(a => a.name !== this.settings.activityName && a.name !== "Streaming");
        return {
          ...ret,
          [userId]: act ? [...filtered, act] : filtered
        };
      });
    }

    FluxDispatcher?.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null });
  }

  buildActivity() {
    try {
      const isStreaming = this.settings.status === "streaming";

      if (!isStreaming && !this.settings.enableCustomActivity) {
        return null;
      }

      const activity = {
        name: this.settings.activityName || "Streaming",
        type: isStreaming ? 1 : (parseInt(this.settings.activityType) === 1 ? 0 : parseInt(this.settings.activityType)),
        flags: 1
      };

      activity.application_id = this.settings.applicationId || "0";

      if (activity.type === 1) {
        activity.url = this.settings.streamUrl || "https://www.twitch.tv/discord";
      }

      const detailsList = this.settings.detailsRotation || [];
      if (this.settings.cycleEnabled && detailsList.length > 0) {
        activity.details = detailsList[this.cycleIndex % detailsList.length] || "";
      } else {
        activity.details = this.settings.details || "";
      }

      const stateList = this.settings.stateRotation || [];
      if (this.settings.cycleEnabled && stateList.length > 0) {
        activity.state = stateList[this.cycleIndex % stateList.length] || "";
      } else {
        activity.state = this.settings.state || "";
      }

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
      const FluxDispatcher = BdApi.Webpack.getModule(m => m?.dispatch && m?.subscribe);
      FluxDispatcher?.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null });
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
      FluxDispatcher?.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null });
    }
  }

  getSettingsPanel() {
    const panel = document.createElement("div");
    panel.classList.add("sc-panel");

    const style = document.createElement("style");
    style.textContent = `
      .sc-panel {
        color: #dbdee1;
        font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
        padding: 20px;
        background: #2b2d31;
        border-radius: 12px;
        max-width: 680px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
      }
      .sc-header {
        margin-bottom: 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 16px;
      }
      .sc-title {
        color: #f2f3f5;
        font-size: 22px;
        font-weight: 700;
        margin-bottom: 6px;
        letter-spacing: 0.3px;
      }
      .sc-subtitle {
        color: #949ba4;
        font-size: 14px;
      }
      
      .sc-tutorial-box {
        background: rgba(88, 101, 242, 0.06);
        border: 1px solid rgba(88, 101, 242, 0.2);
        border-radius: 8px;
        padding: 14px 18px;
        margin-bottom: 24px;
        font-size: 13px;
        line-height: 1.6;
        color: #dbdee1;
      }
      .sc-tutorial-title {
        font-weight: 700;
        color: #5865f2;
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
      }
      
      .sc-status-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 12px;
        margin-bottom: 24px;
      }
      .sc-status-card {
        background: #1e1f22;
        border: 1px solid #3f4147;
        border-radius: 8px;
        padding: 16px 12px;
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
        width: 12px;
        height: 12px;
        border-radius: 50%;
        margin: 0 auto 10px auto;
        display: block;
      }
      .sc-dot.online { background: #23a55a; }
      .sc-dot.idle { background: #f0b232; }
      .sc-dot.dnd { background: #f23f43; }
      .sc-dot.invisible { background: #80848e; }
      .sc-dot.streaming { background: #a855f7; }

      .sc-status-label {
        font-size: 13px;
        font-weight: 600;
        color: #f2f3f5;
      }

      .sc-section {
        background: #1e1f22;
        border-radius: 8px;
        padding: 18px;
        margin-bottom: 20px;
        border: 1px solid #3f4147;
      }
      .sc-section-title {
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
        color: #949ba4;
        margin-bottom: 18px;
        letter-spacing: 0.5px;
        border-left: 3px solid #5865f2;
        padding-left: 8px;
      }
      .sc-form-group {
        margin-bottom: 20px;
      }
      .sc-form-group:last-child {
        margin-bottom: 0;
      }
      .sc-label-container {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .sc-label {
        font-size: 12px;
        font-weight: 700;
        color: #b5bac1;
        text-transform: uppercase;
      }
      
      .sc-field-desc {
        font-size: 12px;
        color: #949ba4;
        margin-top: 6px;
        line-height: 1.5;
      }

      .sc-input, .sc-select, .sc-textarea {
        width: 100%;
        background: #111214;
        border: 1px solid #3f4147;
        border-radius: 6px;
        padding: 10px 12px;
        color: #dbdee1;
        font-family: inherit;
        font-size: 14px;
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
        min-height: 80px;
      }

      .sc-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }

      .sc-toggle-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #111214;
        padding: 12px 16px;
        border-radius: 6px;
        border: 1px solid #3f4147;
        margin-bottom: 16px;
      }
      .sc-toggle-label {
        font-size: 13px;
        font-weight: 600;
        color: #dbdee1;
      }
      
      .sc-switch {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
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
        border-radius: 24px;
      }
      .sc-slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
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
        transform: translateX(20px);
      }

      .sc-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 24px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        padding-top: 16px;
      }
      .sc-btn {
        padding: 10px 20px;
        border-radius: 6px;
        font-size: 14px;
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
        padding: 2px 6px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
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

    const actFieldsRow = document.createElement("div");
    actFieldsRow.classList.add("sc-row");

    const detailsGroup = document.createElement("div");
    detailsGroup.classList.add("sc-form-group");
    detailsGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Static Details</span></div>`;
    const detailsInput = document.createElement("input");
    detailsInput.type = "text";
    detailsInput.classList.add("sc-input");
    detailsInput.value = this.settings.details;
    detailsInput.placeholder = "";
    detailsInput.oninput = () => {
      this.settings.details = detailsInput.value;
    };
    detailsGroup.appendChild(detailsInput);
    actFieldsRow.appendChild(detailsGroup);

    const stateGroup = document.createElement("div");
    stateGroup.classList.add("sc-form-group");
    stateGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Static State</span></div>`;
    const stateInput = document.createElement("input");
    stateInput.type = "text";
    stateInput.classList.add("sc-input");
    stateInput.value = this.settings.state;
    stateInput.placeholder = "";
    stateInput.oninput = () => {
      this.settings.state = stateInput.value;
    };
    stateGroup.appendChild(stateInput);
    actFieldsRow.appendChild(stateGroup);

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
    activitySection.appendChild(appIdGroup);

    activitySection.appendChild(actFieldsRow);
    panel.appendChild(activitySection);

    const rotationSection = document.createElement("div");
    rotationSection.classList.add("sc-section");
    rotationSection.innerHTML = `<div class="sc-section-title">Text Cycling & Animation</div>`;

    const cycleToggle = document.createElement("div");
    cycleToggle.classList.add("sc-toggle-container");

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

    const rotRow = document.createElement("div");
    rotRow.classList.add("sc-row");

    const rotDetailsGroup = document.createElement("div");
    rotDetailsGroup.classList.add("sc-form-group");
    rotDetailsGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">Details Rotation List</span></div>`;
    const detailsRotArea = document.createElement("textarea");
    detailsRotArea.classList.add("sc-textarea");
    detailsRotArea.value = (this.settings.detailsRotation || []).join("\n");
    detailsRotArea.placeholder = "";
    detailsRotArea.oninput = () => {
      this.settings.detailsRotation = detailsRotArea.value.split("\n").map(x => x.trim()).filter(Boolean);
    };
    rotDetailsGroup.appendChild(detailsRotArea);
    rotRow.appendChild(rotDetailsGroup);

    const rotStateGroup = document.createElement("div");
    rotStateGroup.classList.add("sc-form-group");
    rotStateGroup.innerHTML = `<div class="sc-label-container"><span class="sc-label">State Rotation List</span></div>`;
    const stateRotArea = document.createElement("textarea");
    stateRotArea.classList.add("sc-textarea");
    stateRotArea.value = (this.settings.stateRotation || []).join("\n");
    stateRotArea.placeholder = "";
    stateRotArea.oninput = () => {
      this.settings.stateRotation = stateRotArea.value.split("\n").map(x => x.trim()).filter(Boolean);
    };
    rotStateGroup.appendChild(stateRotArea);
    rotRow.appendChild(rotStateGroup);

    rotationSection.appendChild(rotRow);

    const intervalGroup = document.createElement("div");
    intervalGroup.classList.add("sc-form-group");
    intervalGroup.style.marginTop = "16px";
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

    panel.appendChild(rotationSection);

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
      detailsInput.value = this.settings.details;
      stateInput.value = this.settings.state;
      cycleCheck.checked = this.settings.cycleEnabled;
      detailsRotArea.value = (this.settings.detailsRotation || []).join("\n");
      stateRotArea.value = (this.settings.stateRotation || []).join("\n");
      intervalInput.value = this.settings.cycleInterval.toString();
      appIdInput.value = this.settings.applicationId || "";

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
      this.settings.detailsRotation = detailsRotArea.value.split("\n").map(x => x.trim()).filter(Boolean);
      this.settings.stateRotation = stateRotArea.value.split("\n").map(x => x.trim()).filter(Boolean);
      this.settings.cycleInterval = Math.max(1000, parseInt(intervalInput.value) || 5000);

      this.applySettings();
      BdApi.UI.showToast("Configuration Applied Successfully!", { type: "success" });
    };
    actions.appendChild(applyBtn);

    panel.appendChild(actions);

    return panel;
  }
};
