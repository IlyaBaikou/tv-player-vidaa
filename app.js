(function () {
  "use strict";

  var D = window.TVData;
  var config = window.TV_PLAYER_CONFIG || {};
  var store = D.loadStore();
  var app = document.getElementById("app");
  var video = document.getElementById("player");
  var backdrop = document.getElementById("backdrop");
  var toastNode = document.getElementById("toast");
  var state = {
    screen: "home", loading: false, error: "", playlist: null, channels: [], groups: [],
    channel: null, selectedGroup: "__all__", categoryIndex: 2, channelIndex: 0,
    guideIndex: 0, panel: "hidden", overlay: "", programs: {}, currentByChannel: {},
    searchQuery: "", searchKeyIndex: 0, media: { stack: [], folder: null, index: 0, loading: false, error: "", search: false, searchQuery: "" },
    diagnostics: [], diagnosticConclusion: "Нажмите «Проверить соединение»",
    archiveProgram: null, isArchive: false, playbackUrl: "", playbackStartedAt: 0,
    focusId: "", dialog: null, mobileChannelLimit: 40
  };
  var toastTimer = 0;
  var waitingTimer = 0;
  var stallReloads = 0;
  var lastProgress = { time: 0, at: Date.now() };
  var wakeLock = null;
  var enterDownAt = 0;
  var enterLongHandled = false;
  var renderTimer = 0;
  var playbackBlocked = false;
  var mobileLongPressTimer = 0;
  var mobileLongPressed = false;
  var sourcePairTimer = 0;
  var sourcePairBase = String(config.pairingBaseUrl || "").replace(/\/$/, "");

  function isMobileLayout() {
    return window.matchMedia && window.matchMedia("(max-width: 820px), (pointer: coarse) and (max-device-width: 1024px)").matches;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char];
    });
  }

  function dateLabel() {
    return new Date().toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" });
  }

  function clockLabel() {
    return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function logoHtml(channel, className) {
    if (channel && channel.logo) return '<img class="' + className + '" src="' + esc(channel.logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">';
    return '<div class="' + className + '" style="display:flex;align-items:center;justify-content:center;color:#777;font-weight:700">TV</div>';
  }

  function showToast(message, timeout) {
    toastNode.textContent = message;
    toastNode.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastNode.classList.remove("show"); }, timeout || 3500);
  }

  function persist() { D.saveStore(store); }

  function migrateSources() {
    if (!Array.isArray(store.playlists)) store.playlists = [];
    if (store.sourceSchema !== 3) {
      // Old builds could contain a baked-in or remotely supplied provider URL.
      // Keep only sources that the viewer explicitly added in schema 2.
      if (store.sourceSchema === 2) {
        var active = store.playlists[store.activePlaylist || 0];
        store.playlists = store.playlists.filter(function (item) { return !item.remote; });
        store.activePlaylist = Math.max(0, active && !active.remote ? store.playlists.findIndex(function (item) { return item.url === active.url; }) : 0);
      } else {
        store.playlists = [];
        store.activePlaylist = 0;
      }
      store.sourceSchema = 3;
    }
    persist();
  }

  function activePlaylist() { return store.playlists[store.activePlaylist || 0] || null; }

  function loadActivePlaylist(force) {
    var playlist = activePlaylist();
    if (!playlist) return Promise.reject(new Error("Добавьте IPTV-плейлист"));
    if (!force && state.playlist && state.playlist.url === playlist.url && state.channels.length) return Promise.resolve(state.playlist);
    state.loading = true; state.error = ""; render();
    return D.loadPlaylist(playlist.url).then(function (document) {
      state.playlist = { name: playlist.name || "Телевидение", url: playlist.url, mediaUrl: playlist.mediaUrl || "", epgUrl: document.epgUrl };
      state.channels = document.channels;
      state.groups = unique(document.channels.map(function (channel) { return channel.group; }));
      state.loading = false;
      state.error = "";
      render();
      return state.playlist;
    }).catch(function (error) {
      state.loading = false; state.error = error.message || "Не удалось загрузить плейлист"; render(); throw error;
    });
  }

  function unique(values) {
    var seen = {}; var result = [];
    values.forEach(function (value) { if (!seen[value]) { seen[value] = true; result.push(value); } });
    return result;
  }

  function categories() {
    return [
      { id: "__favorites__", name: "★  Избранные" },
      { id: "__recent__", name: "Недавние" },
      { id: "__all__", name: "Все каналы" }
    ].concat(state.groups.map(function (name) { return { id: name, name: name }; }));
  }

  function filteredChannels() {
    if (state.selectedGroup === "__favorites__") return state.channels.filter(function (item) { return store.favorites.indexOf(item.url) >= 0; });
    if (state.selectedGroup === "__recent__") return recentChannels(10);
    if (state.selectedGroup === "__all__") return state.channels;
    return state.channels.filter(function (item) { return item.group === state.selectedGroup; });
  }

  function recentChannels(limit) {
    var map = {};
    state.channels.forEach(function (channel) { map[channel.url] = channel; });
    return (store.recent || []).map(function (url) { return map[url]; }).filter(Boolean).slice(0, limit || 10);
  }

  function currentFor(channel) {
    return state.currentByChannel[channel.epgId] || D.currentProgram(state.programs[channel.epgId] || []);
  }

  function progressFor(program) {
    if (!program) return 0;
    return Math.max(0, Math.min(100, ((Date.now() - program.start) / Math.max(1, program.end - program.start)) * 100));
  }

  function loadPrograms(channel, quiet) {
    if (!channel || !channel.epgId || state.programs[channel.epgId]) return Promise.resolve(state.programs[channel && channel.epgId] || []);
    return D.loadPrograms(config.epgBaseUrl || "epg", channel.epgId).then(function (programs) {
      state.programs[channel.epgId] = programs;
      state.currentByChannel[channel.epgId] = D.currentProgram(programs);
      if (!quiet) {
        var currentIndex = programs.findIndex(function (program) { return program.start <= Date.now() && program.end > Date.now(); });
        state.guideIndex = Math.max(0, currentIndex);
      }
      scheduleRender();
      return programs;
    }).catch(function (error) {
      if (!quiet) { state.error = error.message; scheduleRender(); }
      return [];
    });
  }

  function hydrateVisiblePrograms(channels) {
    channels.forEach(function (channel) { loadPrograms(channel, true); });
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = 0; render(); }, 80);
  }

  function openTelevision(channel, showMenu) {
    loadActivePlaylist(false).then(function () {
      var target = channel || recentChannels(1)[0] || state.channels[0];
      if (!target) throw new Error("В плейлисте нет каналов");
      state.screen = "viewer";
      state.panel = showMenu === false ? "hidden" : "channels";
      state.overlay = "";
      state.selectedGroup = target.group || "__all__";
      state.categoryIndex = Math.max(0, categories().findIndex(function (item) { return item.id === state.selectedGroup; }));
      var list = filteredChannels();
      state.channelIndex = Math.max(0, list.findIndex(function (item) { return item.id === target.id; }));
      state.focusId = "channel-" + state.channelIndex;
      playChannel(target, false);
    }).catch(function (error) { showToast(error.message || "Не удалось открыть телевидение"); });
  }

  function rememberRecent(channel) {
    store.recent = (store.recent || []).filter(function (url) { return url !== channel.url; });
    store.recent.unshift(channel.url);
    store.recent = store.recent.slice(0, 10);
    persist();
  }

  function setVideoScale() {
    var scale = store.settings.scale || "fit";
    video.style.objectFit = scale === "fill" ? "fill" : scale === "zoom" ? "cover" : "contain";
  }

  function playChannel(channel, keepArchive) {
    if (!channel) return;
    state.channel = channel;
    state.archiveProgram = keepArchive ? state.archiveProgram : null;
    state.isArchive = !!keepArchive;
    state.playbackUrl = keepArchive ? state.playbackUrl : D.normalizeStream(channel.url);
    state.playbackStartedAt = Date.now();
    stallReloads = 0;
    rememberRecent(channel);
    loadPrograms(channel, false);
    setVideoScale();
    video.controls = isMobileLayout();
    backdrop.style.display = "none";
    video.classList.add("visible");
    video.pause();
    video.src = state.playbackUrl;
    video.load();
    var promise = video.play();
    playbackBlocked = false;
    if (promise && promise.catch) promise.catch(function () { playbackBlocked = true; showToast("Нажмите OK для воспроизведения"); });
    requestWakeLock();
    render();
  }

  function playArchive(program) {
    if (!program || program.start > Date.now()) return;
    var url = D.archiveUrl(state.channel, program);
    if (!url) { showToast("Для этой передачи архив недоступен"); return; }
    state.archiveProgram = program;
    state.isArchive = true;
    state.playbackUrl = url;
    state.panel = "hidden";
    state.overlay = "controls";
    playChannel(state.channel, true);
  }

  function goLive() {
    state.archiveProgram = null; state.isArchive = false; state.overlay = "";
    playChannel(state.channel, false);
  }

  function toggleFavorite(channel) {
    var index = store.favorites.indexOf(channel.url);
    if (index >= 0) { store.favorites.splice(index, 1); showToast("Удалено из избранного"); }
    else { store.favorites.unshift(channel.url); showToast("Добавлено в избранное"); }
    persist(); render();
  }

  function render() {
    if (state.screen === "viewer") renderViewer();
    else if (state.screen === "settings") renderSettings();
    else if (state.screen === "media") renderMedia();
    else renderHome();
    if (state.dialog) renderDialog();
    restoreFocus();
  }

  function topbar(active) {
    return '<header class="topbar"><div class="topbar-left"><div class="brand"><div class="brand-mark"><span>TV</span><b>▶</b></div><div class="brand-title">TV Player</div></div>' +
      '<nav class="topbar-nav"><button class="nav-button focusable ' + (active === "home" ? "active" : "") + '" data-action="home" data-focus="nav-home">Главная</button>' +
      '<button class="nav-button focusable ' + (active === "settings" ? "active" : "") + '" data-action="settings" data-focus="nav-settings">Настройки</button></nav></div>' +
      '<div class="topbar-actions">' + (active === "home" && activePlaylist() ? '<button class="pill-button focusable" data-action="add-playlist" data-focus="nav-add">＋ Плейлист</button>' : '') + '<div class="clock">' + clockLabel() + '<small>' + esc(dateLabel()) + '</small></div></div></header>';
  }

  function renderHome() {
    backdrop.style.display = "block"; video.classList.remove("visible");
    var playlist = activePlaylist();
    var recents = recentChannels(5);
    var hero = playlist ? '<button class="hero-card focusable" data-action="open-tv" data-focus="home-tv">' +
      '<div class="hero-icon"><img src="assets/icon.svg" alt=""></div><div class="hero-copy"><h2>' + esc(playlist.name || "Телевидение") + '</h2>' +
      '<p>' + (state.loading ? "Загрузка каналов…" : (state.channels.length ? state.channels.length + " каналов" : "IPTV-плейлист")) + '</p>' +
      '<p class="subtle">• архив до 6 дней</p></div></button>' :
      '<button class="hero-card add focusable" style="grid-column:1/-1" data-action="add-playlist" data-focus="home-add"><div class="plus">＋</div><div class="add-label">Добавить источник</div></button>';
    var media = playlist && playlist.mediaUrl ? '<button class="hero-card media focusable" data-action="open-media" data-focus="home-media"><div class="hero-icon" style="font-size:74px;color:#555">▰</div><div class="hero-copy"><h2>Медиатека</h2><p>Фильмы и сериалы</p><p class="subtle">Категории и поиск</p></div></button>' : '';
    var recentHtml = recents.length ? recents.map(function (channel, index) {
      return '<button class="recent-card focusable" data-action="recent" data-index="' + index + '" data-focus="recent-' + index + '">' + logoHtml(channel, "") + '<span>' + esc(channel.name) + '</span></button>';
    }).join("") : '<div class="empty-recent">Недавние каналы появятся после первого просмотра</div>';
    var playlistSwitch = store.playlists.length > 1 ? '<div class="playlist-switcher">' + store.playlists.map(function (item, index) { return '<button class="playlist-chip focusable ' + (index === store.activePlaylist ? 'active' : '') + '" data-action="select-playlist" data-index="' + index + '" data-focus="playlist-' + index + '">' + esc(item.name || ('Плейлист ' + (index + 1))) + '</button>'; }).join('') + '</div>' : '';
    app.innerHTML = '<section class="screen">' + topbar("home") + '<div class="home-content">' +
      '<h2 class="section-title">Смотреть</h2><div class="hero-row">' + hero + media + '</div>' + playlistSwitch + '<h2 class="section-title">Недавние</h2><div class="recent-row">' + recentHtml + '</div>' +
      (state.error ? '<div class="panel-placeholder">' + esc(state.error) + '</div>' : '') + '</div></section>';
  }

  function renderViewer() {
    var html = '<section class="viewer-screen">';
    if (state.panel !== "hidden") html += '<div class="viewer-gradient"></div>' + renderBrowser();
    else html += '<button class="mobile-player-tap mobile-only" data-action="show-controls" aria-label="Управление">•••</button>';
    if (state.overlay === "search") html += renderSearch();
    else if (state.overlay === "info") html += renderInfo(false);
    else if (state.overlay === "controls") html += renderInfo(true);
    else if (state.overlay === "audio") html += renderAudio();
    html += '</section>';
    app.innerHTML = html;
  }

  function windowSlice(items, selected, count) {
    var start = Math.max(0, Math.min(items.length - count, selected - Math.floor(count / 2)));
    return { start: start, items: items.slice(start, start + count) };
  }

  function renderBrowser() {
    var cats = categories();
    var mobile = isMobileLayout();
    var catWindow = mobile ? { start: 0, items: cats } : windowSlice(cats, state.categoryIndex, 12);
    var list = filteredChannels();
    if (state.channelIndex >= list.length) state.channelIndex = Math.max(0, list.length - 1);
    var isGrid = store.settings.view === "grid";
    var channelWindow = mobile ? { start: 0, items: list.slice(0, Math.max(state.mobileChannelLimit, state.channelIndex + 1)) } : windowSlice(list, state.channelIndex, isGrid ? 12 : 7);
    hydrateVisiblePrograms(channelWindow.items);
    var catHtml = catWindow.items.map(function (item, offset) {
      var index = catWindow.start + offset;
      return '<button class="category focusable ' + (index === state.categoryIndex ? "active" : "") + '" data-action="mobile-category" data-index="' + index + '" data-focus="cat-' + index + '">' + esc(item.name) + '</button>';
    }).join("");
    var channelHtml = channelWindow.items.map(function (channel, offset) {
      var index = channelWindow.start + offset;
      var current = currentFor(channel);
      var favorite = store.favorites.indexOf(channel.url) >= 0;
      return '<button class="channel-card focusable ' + (state.channel && channel.id === state.channel.id ? "active" : "") + '" data-action="mobile-channel" data-index="' + index + '" data-focus="channel-' + index + '">' +
        logoHtml(channel, "channel-logo") + '<div class="channel-copy"><div class="channel-name">' + esc(channel.name) + '</div>' +
        '<div class="channel-program">' + esc(current ? current.title : "Программа загружается…") + '</div>' +
        (current ? '<div class="mini-progress"><b style="width:' + progressFor(current) + '%"></b></div>' : '') + '</div>' +
        (favorite ? '<div class="favorite-star">★</div>' : '') + '</button>';
    }).join("");
    var selected = list[state.channelIndex] || state.channel;
    var guide = selected ? (state.programs[selected.epgId] || []) : [];
    if (guide.length && state.guideIndex >= guide.length) state.guideIndex = guide.length - 1;
    var guideWindow = mobile ? { start: 0, items: guide } : windowSlice(guide, state.guideIndex, 10);
    var guideHtml = guide.length ? guideWindow.items.map(function (program, offset) {
      var index = guideWindow.start + offset;
      var current = program.start <= Date.now() && program.end > Date.now();
      var future = program.start > Date.now();
      return '<button class="program-card focusable ' + (current ? "current " : "") + (future ? "future" : "") + '" data-action="mobile-program" data-index="' + index + '" data-focus="program-' + index + '"><span class="program-time">' + D.formatTime(program.start) + '</span><span class="program-title">' + esc(program.title) + '</span><span class="program-status">' + (current ? "live" : future ? "будет позже" : "▶ архив") + '</span></button>';
    }).join("") : '<div class="panel-placeholder">' + (state.error ? esc(state.error) : "Программа передач загружается…") + '</div>';
    return '<div class="browser-shell"><aside class="categories"><div class="side-clock">' + clockLabel() + '</div><div class="side-date">' + esc(dateLabel()) + '</div>' +
      '<button class="search-entry focusable" data-action="search" data-focus="search-open">⌕  Поиск</button><div class="category-list">' + catHtml + '</div></aside>' +
      '<section class="channel-pane"><div class="pane-handle"></div><div class="' + (isGrid ? "channel-grid" : "channel-list") + '">' + (channelHtml || '<div class="panel-placeholder">В этой категории пока нет каналов</div>') + '</div>' + (mobile && channelWindow.items.length < list.length ? '<button class="mobile-more mobile-only" data-action="mobile-more-channels">Показать ещё каналы</button>' : '') + '</section>' +
      '<section class="guide-pane"><div class="guide-header"><h2>' + esc(selected ? selected.name : "Программа") + '</h2><span class="archive-badge">' + (selected && selected.catchupDays ? "• " + selected.catchupDays + "д. архив" : "без архива") + '</span></div><div class="guide-list">' + guideHtml + '</div></section></div>';
  }

  function renderInfo(controls) {
    var programs = state.channel ? state.programs[state.channel.epgId] || [] : [];
    var program = state.archiveProgram || D.currentProgram(programs);
    var index = program ? programs.indexOf(program) : -1;
    var next = index >= 0 ? programs[index + 1] : null;
    var progress = state.isArchive ? archiveProgress(program) : progressFor(program);
    return '<div class="bottom-sheet"><div class="info-grid"><div><div class="info-channel">' + esc(state.channel ? state.channel.name : "") + '</div>' +
      '<div class="info-title">' + esc(program ? program.title : "Прямой эфир") + '</div><div class="info-meta">' + (program ? D.formatTime(program.start) + ' — ' + D.formatTime(program.end) : "") + (state.isArchive ? " · архив" : " · live") + '</div>' +
      '<div class="info-desc">' + esc(program && program.description ? program.description : "") + '</div></div>' +
      '<div class="next-card"><small>Далее</small><strong>' + esc(next ? next.title : "Программа уточняется") + '</strong><div style="margin-top:9px;color:#adb1bc">' + (next ? D.formatTime(next.start) : "") + '</div></div></div>' +
      (controls ? renderControls(program) : '<div class="controls-row"><button class="control-button focusable" data-action="from-start" data-focus="info-start">▶ С начала</button><button class="control-button live focusable" data-action="live" data-focus="info-live">● Live</button></div>') +
      '<div class="timeline"><b style="width:' + progress + '%"></b></div></div>';
  }

  function archiveProgress(program) {
    if (!program) return 0;
    var duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : program.end - program.start;
    return Math.max(0, Math.min(100, (video.currentTime * 1000 / Math.max(1, duration)) * 100));
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    var h = Math.floor(seconds / 3600); var m = Math.floor((seconds % 3600) / 60); var s = Math.floor(seconds % 60);
    return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function renderControls(program) {
    var duration = Number.isFinite(video.duration) ? video.duration : (program ? (program.end - program.start) / 1000 : 0);
    return '<div class="controls-row"><button class="control-button focusable" data-action="seek-back" data-focus="control-back">−30 сек</button>' +
      '<button class="control-button focusable" data-action="play-pause" data-focus="control-play">' + (video.paused ? "▶ Смотреть" : "Ⅱ Пауза") + '</button>' +
      '<button class="control-button focusable" data-action="seek-forward" data-focus="control-forward">+30 сек</button>' +
      '<button class="control-button focusable" data-action="show-audio" data-focus="control-audio">Аудио</button>' +
      '<button class="control-button live focusable" data-action="live" data-focus="control-live">● Live</button>' +
      '<button class="control-button mobile-only" data-action="close-overlay">Закрыть</button>' +
      '<div style="align-self:center;margin-left:18px;color:#d5d2db;font-size:20px">' + formatDuration(video.currentTime) + ' / ' + formatDuration(duration) + '</div></div>';
  }

  function audioTracks() {
    var tracks = video.audioTracks; var result = [];
    if (tracks && typeof tracks.length === "number") for (var i = 0; i < tracks.length; i += 1) result.push({ index: i, label: tracks[i].label || tracks[i].language || ("Дорожка " + (i + 1)), enabled: !!tracks[i].enabled });
    if (!result.length) result.push({ index: 0, label: "Основная аудиодорожка", enabled: true });
    return result;
  }

  function renderAudio() {
    return '<div class="bottom-sheet audio-sheet"><h1 style="margin:0 0 20px;font-size:27px">Аудиодорожка</h1><div class="audio-list">' + audioTracks().map(function (track) {
      return '<button class="control-button focusable ' + (track.enabled ? "live" : "") + '" data-action="audio" data-index="' + track.index + '" data-focus="audio-' + track.index + '">' + esc(track.label) + '</button>';
    }).join("") + '</div></div>';
  }

  var keyboardChars = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя".split("");
  function searchResults() {
    var query = state.searchQuery.trim().toLowerCase();
    if (!query) return state.channels.slice(0, 14);
    return state.channels.filter(function (channel) { return channel.name.toLowerCase().indexOf(query) >= 0; }).slice(0, 14);
  }

  function channelSearchCards() {
    return searchResults().map(function (channel, index) {
      return '<button class="search-card focusable" data-action="search-result" data-index="' + index + '" data-focus="result-' + index + '">' + logoHtml(channel, "") + '<span>' + esc(channel.name) + '</span></button>';
    }).join("");
  }

  function renderSearch() {
    var keys = keyboardChars.map(function (char, index) { return '<button class="key focusable" data-action="key" data-char="' + char + '" data-focus="key-' + index + '">' + char + '</button>'; }).join("") +
      '<button class="key wide focusable" data-action="space" data-focus="key-space">пробел</button><button class="key wide focusable" data-action="backspace" data-focus="key-back">⌫</button>';
    var results = channelSearchCards();
    return '<div class="overlay"><button class="overlay-close mobile-only" data-action="close-overlay">×</button><div class="search-query"><b>⌕</b><span id="mobileSearchLabel">' + esc(state.searchQuery || "Поиск каналов") + '</span></div><input id="mobileChannelSearch" class="mobile-search-input mobile-only" type="search" inputmode="search" autocomplete="off" placeholder="Название канала" value="' + esc(state.searchQuery) + '"><div class="keyboard">' + keys + '</div><div id="mobileSearchResults" class="search-results">' + results + '</div></div>';
  }

  function renderSettings() {
    backdrop.style.display = "block"; video.classList.remove("visible");
    function choices(key, values) {
      return values.map(function (value) { return '<button class="choice focusable ' + (store.settings[key] === value[0] ? "selected" : "") + '" data-action="setting" data-key="' + key + '" data-value="' + value[0] + '" data-focus="setting-' + key + '-' + value[0] + '">' + value[1] + '</button>'; }).join("");
    }
    var results = state.diagnostics.map(function (item) { return '<div class="diagnostic-item"><b class="' + (item.ok ? "ok" : "bad") + '">' + (item.ok ? "✓" : "!") + '</b><div><strong>' + esc(item.name) + '</strong><br>' + esc(item.detail) + '</div></div>'; }).join("");
    app.innerHTML = '<section class="screen settings-screen">' + topbar("settings") + '<div class="settings-layout"><div class="content-card settings-list">' +
      '<div class="setting-row"><div class="setting-label">Каталог каналов</div><div class="choice-row">' + choices("view", [["list","Список"],["grid","Иконки"]]) + '</div></div>' +
      '<div class="setting-row"><div class="setting-label">Масштаб видео</div><div class="choice-row">' + choices("scale", [["fit","Вписать"],["fill","Растянуть"],["zoom","Заполнить"]]) + '</div></div>' +
      '<div class="setting-row"><div class="setting-label">Качество</div><div class="choice-row">' + choices("quality", [["auto","Авто"],["hd","HD"],["sd","Экономное"]]) + '</div></div>' +
      '<div class="setting-row"><div class="setting-label">Устойчивость</div><div class="choice-row">' + choices("buffer", [["fast","Быстро"],["balanced","Баланс"],["stable","Стабильно"]]) + '</div></div>' +
      '<button class="secondary-button focusable" data-action="edit-playlist" data-focus="settings-playlist">Изменить плейлист и медиатеку</button>' +
      '<button class="secondary-button focusable" data-action="refresh" data-focus="settings-refresh">Обновить список каналов</button></div>' +
      '<div class="content-card diagnostics"><h2 style="margin:0 0 14px">Диагностика</h2><p style="color:#adb1bc;line-height:1.5">Проверяет интернет, плейлист, программу и текущий видеопоток.</p>' +
      '<button class="primary-button focusable" data-action="diagnostics" data-focus="diagnostics">Проверить соединение</button><div class="diagnostic-result">' + results + '</div><div style="margin-top:auto;font-size:20px;color:#d9d6df">' + esc(state.diagnosticConclusion) + '</div></div></div></section>';
  }

  function openMedia() {
    var playlist = activePlaylist(); var url = playlist && playlist.mediaUrl;
    if (!url) { showToast("Адрес медиатеки не указан"); return; }
    state.screen = "media"; state.media.stack = []; loadMediaFolder(url, true);
  }

  function loadMediaFolder(url, push) {
    state.media.loading = true; state.media.error = ""; render();
    D.loadMedia(url).then(function (folder) {
      state.media.loading = false; state.media.folder = folder; state.media.index = 0;
      if (push) state.media.stack.push({ url: url, folder: folder });
      render();
    }).catch(function (error) { state.media.loading = false; state.media.error = error.message; render(); });
  }

  function renderMedia() {
    backdrop.style.display = "block";
    var folder = state.media.folder;
    var entries = folder ? folder.entries : [];
    var windowed = windowSlice(entries, state.media.index, 18);
    var cards = windowed.items.map(function (entry, offset) {
      var index = windowed.start + offset;
      return '<button class="media-card focusable" data-action="media-entry" data-index="' + index + '" data-focus="media-' + index + '"><div class="media-art"><span>' + (entry.isFolder ? "▰" : "▶") + '</span>' + (entry.logo ? '<img src="' + esc(entry.logo) + '" alt="" onerror="this.style.display=\'none\'">' : '') + '</div><span>' + esc(entry.title) + '</span></button>';
    }).join("");
    app.innerHTML = '<section class="screen media-screen"><header class="media-header"><div><h1 class="media-title">' + esc(folder ? folder.title : "Медиатека") + '</h1><div class="breadcrumbs">' + esc(state.media.stack.map(function (item) { return item.folder.title; }).join("  ›  ")) + '</div></div><div class="topbar-actions"><button class="pill-button focusable" data-action="media-search" data-focus="media-search">⌕ Поиск</button><button class="pill-button focusable" data-action="home" data-focus="media-home">Главная</button></div></header>' +
      (state.media.loading ? '<div class="loading">Загрузка медиатеки…</div>' : state.media.error ? '<div class="loading">' + esc(state.media.error) + '</div>' : '<div class="media-grid">' + cards + '</div>') + '</section>' + (state.media.search ? renderMediaSearch() : '');
  }

  function mediaSearchResults() {
    var entries = state.media.folder ? state.media.folder.entries : [];
    var query = state.media.searchQuery.trim().toLowerCase();
    return entries.filter(function (entry) { return !query || entry.title.toLowerCase().indexOf(query) >= 0; }).slice(0, 14);
  }

  function mediaSearchCards() {
    return mediaSearchResults().map(function (entry, index) {
      return '<button class="search-card focusable" data-action="media-search-result" data-index="' + index + '" data-focus="media-result-' + index + '"><div class="media-art" style="height:145px"><span>' + (entry.isFolder ? '▰' : '▶') + '</span>' + (entry.logo ? '<img src="' + esc(entry.logo) + '" alt="" onerror="this.style.display=\'none\'">' : '') + '</div><span>' + esc(entry.title) + '</span></button>';
    }).join("");
  }

  function renderMediaSearch() {
    var keys = keyboardChars.map(function (char, index) { return '<button class="key focusable" data-action="media-key" data-char="' + char + '" data-focus="media-key-' + index + '">' + char + '</button>'; }).join("") +
      '<button class="key wide focusable" data-action="media-space" data-focus="media-key-space">пробел</button><button class="key wide focusable" data-action="media-backspace" data-focus="media-key-back">⌫</button>';
    var results = mediaSearchCards();
    return '<div class="overlay"><button class="overlay-close mobile-only" data-action="close-media-search">×</button><div class="search-query"><b>⌕</b><span id="mobileMediaSearchLabel">' + esc(state.media.searchQuery || "Поиск в медиатеке") + '</span></div><input id="mobileMediaSearch" class="mobile-search-input mobile-only" type="search" inputmode="search" autocomplete="off" placeholder="Фильм или сериал" value="' + esc(state.media.searchQuery) + '"><div class="keyboard">' + keys + '</div><div id="mobileMediaSearchResults" class="search-results">' + results + '</div></div>';
  }

  function renderDialog() {
    var dialog = state.dialog;
    var nameField = dialog.firstRun ? '<p class="subtle">Введите адрес M3U один раз. Он сохранится только на этом устройстве.</p>' : '<label>Название</label><input id="dialogName" value="' + esc(dialog.name) + '" data-focus="dialog-name">';
    var phonePair = "";
    if (sourcePairBase) {
      if (dialog.pair) {
        phonePair = '<div class="source-pair-card"><img src="' + esc(dialog.pair.qr) + '" alt="QR-код"><div><h3>Введите с телефона</h3><p>Отсканируйте QR-код камерой. После отправки источник появится здесь автоматически.</p><div class="source-pair-code">' + esc(dialog.pair.code) + '</div><p class="subtle">Код действует 10 минут</p><button class="secondary-button focusable" data-action="source-pair-start" data-focus="source-pair-new">Новый код</button></div></div>';
      } else {
        phonePair = '<div class="source-pair-divider"><span>или</span></div><button class="phone-source-button secondary-button focusable" data-action="source-pair-start" data-focus="source-pair-start">▣ Ввести с телефона</button>' + (dialog.pairError ? '<p class="source-pair-error">' + esc(dialog.pairError) + '</p>' : '');
      }
    }
    app.insertAdjacentHTML("beforeend", '<div class="dialog-backdrop"><div class="dialog"><h2>' + (dialog.firstRun ? 'Добавьте источник' : 'Плейлист') + '</h2>' + nameField + '<div class="manual-source-fields"><label>URL M3U</label><input id="dialogPlaylist" value="' + esc(dialog.url) + '" data-focus="dialog-playlist"><label>URL медиатеки (необязательно)</label><input id="dialogMedia" value="' + esc(dialog.mediaUrl) + '" data-focus="dialog-media"></div>' + phonePair + '<div class="dialog-actions"><button class="secondary-button focusable" data-action="dialog-cancel" data-focus="dialog-cancel" style="padding:0 28px">Отмена</button><button class="primary-button focusable" data-action="dialog-save" data-focus="dialog-save" style="padding:0 28px">Сохранить</button></div></div></div>');
  }

  function runDiagnostics() {
    state.diagnostics = []; state.diagnosticConclusion = "Проверка выполняется…"; render();
    var playlist = activePlaylist();
    var checks = [
      { name: "Интернет", url: "https://api.github.com/zen", type: "status" },
      { name: "M3U-плейлист", url: playlist && playlist.url, type: "text" },
      { name: "Программа передач", url: (config.epgBaseUrl || "epg") + "/meta.json", type: "status" }
    ];
    var diagnosticChannel = state.channel || state.channels[0];
    if (diagnosticChannel) checks.push({ name: "Видеопоток: " + diagnosticChannel.name, url: D.normalizeStream(diagnosticChannel.url), type: "text" });
    var chain = Promise.resolve();
    checks.forEach(function (check) {
      chain = chain.then(function () {
        var started = Date.now();
        return fetch(check.url, check.type === "text" ? { headers: { Range: "bytes=0-2047" } } : {}).then(function (response) {
          if (!response.ok && response.status !== 206) throw new Error("HTTP " + response.status);
          state.diagnostics.push({ name: check.name, ok: true, detail: "Доступен, " + (Date.now() - started) + " мс" }); render();
        }).catch(function (error) { state.diagnostics.push({ name: check.name, ok: false, detail: error.message || "Нет ответа" }); render(); });
      });
    });
    chain.then(function () {
      var failed = state.diagnostics.filter(function (item) { return !item.ok; });
      state.diagnosticConclusion = failed.length ? "Есть проблема: " + failed[0].name : "Сеть и IPTV-источник работают нормально"; render();
    });
  }

  function action(target) {
    var name = target.getAttribute("data-action");
    if (!name) return;
    if (name === "home") { closePlayback(); clearSourcePair(); state.screen = "home"; state.dialog = null; render(); }
    else if (name === "settings") { closePlayback(); state.screen = "settings"; render(); }
    else if (name === "open-tv") openTelevision(null, true);
    else if (name === "recent") openTelevision(recentChannels(5)[+target.getAttribute("data-index")], false);
    else if (name === "open-media") openMedia();
    else if (name === "add-playlist") openPlaylistDialog(true);
    else if (name === "edit-playlist") openPlaylistDialog(false);
    else if (name === "select-playlist") selectPlaylist(+target.getAttribute("data-index"));
    else if (name === "dialog-cancel") { clearSourcePair(); state.dialog = null; render(); }
    else if (name === "dialog-save") savePlaylistDialog();
    else if (name === "source-pair-start") startSourcePair();
    else if (name === "search") { state.overlay = "search"; state.searchQuery = ""; state.focusId = "key-0"; render(); }
    else if (name === "key") { state.searchQuery += target.getAttribute("data-char") || ""; render(); }
    else if (name === "space") { state.searchQuery += " "; render(); }
    else if (name === "backspace") { state.searchQuery = state.searchQuery.slice(0, -1); render(); }
    else if (name === "search-result") { var result = searchResults()[+target.getAttribute("data-index")]; state.overlay = ""; playChannel(result, false); }
    else if (name === "mobile-category") {
      state.categoryIndex = +target.getAttribute("data-index");
      var mobileCat = categories()[state.categoryIndex];
      if (mobileCat) { state.selectedGroup = mobileCat.id; state.channelIndex = 0; state.guideIndex = 0; state.mobileChannelLimit = 40; state.panel = "channels"; render(); }
    }
    else if (name === "mobile-channel") {
      state.channelIndex = +target.getAttribute("data-index");
      var mobileChannel = filteredChannels()[state.channelIndex];
      if (mobileChannel) { state.panel = "channels"; playChannel(mobileChannel, false); }
    }
    else if (name === "mobile-program") {
      state.guideIndex = +target.getAttribute("data-index");
      var mobileGuide = state.channel ? state.programs[state.channel.epgId] || [] : [];
      var mobileProgram = mobileGuide[state.guideIndex];
      if (mobileProgram && mobileProgram.start <= Date.now()) { if (mobileProgram.end <= Date.now()) playArchive(mobileProgram); else goLive(); }
    }
    else if (name === "mobile-more-channels") { state.mobileChannelLimit += 40; render(); }
    else if (name === "show-controls") { state.overlay = "controls"; state.focusId = "control-play"; render(); }
    else if (name === "show-audio") { state.overlay = "audio"; state.focusId = "audio-0"; render(); }
    else if (name === "close-overlay") { state.overlay = ""; render(); }
    else if (name === "close-media-search") { state.media.search = false; render(); }
    else if (name === "from-start") { var current = state.channel && D.currentProgram(state.programs[state.channel.epgId] || []); if (current) playArchive(current); }
    else if (name === "live") goLive();
    else if (name === "seek-back") seek(-30);
    else if (name === "seek-forward") seek(30);
    else if (name === "play-pause") { if (video.paused) video.play(); else video.pause(); render(); }
    else if (name === "audio") selectAudio(+target.getAttribute("data-index"));
    else if (name === "setting") { store.settings[target.getAttribute("data-key")] = target.getAttribute("data-value"); persist(); setVideoScale(); render(); }
    else if (name === "refresh") loadActivePlaylist(true).then(function () { showToast("Список каналов обновлён"); });
    else if (name === "diagnostics") runDiagnostics();
    else if (name === "media-entry") openMediaEntry(+target.getAttribute("data-index"));
    else if (name === "media-search") { state.media.search = true; state.media.searchQuery = ""; state.focusId = "media-key-0"; render(); }
    else if (name === "media-key") { state.media.searchQuery += target.getAttribute("data-char") || ""; render(); }
    else if (name === "media-space") { state.media.searchQuery += " "; render(); }
    else if (name === "media-backspace") { state.media.searchQuery = state.media.searchQuery.slice(0, -1); render(); }
    else if (name === "media-search-result") { var mediaResult = mediaSearchResults()[+target.getAttribute("data-index")]; state.media.search = false; if (mediaResult) openMediaResult(mediaResult); }
  }

  app.addEventListener("click", function (event) {
    var target = event.target.closest ? event.target.closest("[data-action]") : null;
    if (target) {
      if (mobileLongPressed) { mobileLongPressed = false; event.preventDefault(); return; }
      state.focusId = target.getAttribute("data-focus") || state.focusId;
      action(target);
    }
  });

  app.addEventListener("input", function (event) {
    if (event.target.id === "mobileChannelSearch") {
      state.searchQuery = event.target.value.toLowerCase();
      var searchLabel = document.getElementById("mobileSearchLabel");
      var searchRoot = document.getElementById("mobileSearchResults");
      if (searchLabel) searchLabel.textContent = state.searchQuery || "Поиск каналов";
      if (searchRoot) searchRoot.innerHTML = channelSearchCards();
    } else if (event.target.id === "mobileMediaSearch") {
      state.media.searchQuery = event.target.value.toLowerCase();
      var mediaLabel = document.getElementById("mobileMediaSearchLabel");
      var mediaRoot = document.getElementById("mobileMediaSearchResults");
      if (mediaLabel) mediaLabel.textContent = state.media.searchQuery || "Поиск в медиатеке";
      if (mediaRoot) mediaRoot.innerHTML = mediaSearchCards();
    }
  });

  app.addEventListener("touchstart", function (event) {
    var target = event.target.closest ? event.target.closest('[data-action="mobile-channel"]') : null;
    if (!target) return;
    clearTimeout(mobileLongPressTimer);
    mobileLongPressed = false;
    mobileLongPressTimer = setTimeout(function () {
      var channel = filteredChannels()[+target.getAttribute("data-index")];
      if (channel) { mobileLongPressed = true; toggleFavorite(channel); }
    }, 650);
  }, { passive: true });

  app.addEventListener("touchend", function () { clearTimeout(mobileLongPressTimer); }, { passive: true });
  app.addEventListener("touchcancel", function () { clearTimeout(mobileLongPressTimer); }, { passive: true });

  function openPlaylistDialog(isNew, firstRun) {
    clearSourcePair();
    var playlist = isNew ? { name: "Плейлист " + (store.playlists.length + 1), url: "", mediaUrl: "" } : (activePlaylist() || { name: "Телевидение", url: "", mediaUrl: "" });
    state.dialog = { isNew: !!isNew, firstRun: !!firstRun, name: firstRun ? "Телевидение" : (playlist.name || "Телевидение"), url: playlist.url || "", mediaUrl: playlist.mediaUrl || "", pair: null, pairError: "" };
    state.focusId = firstRun ? "dialog-playlist" : "dialog-name"; render();
  }

  function savePlaylistDialog() {
    var nameInput = document.getElementById("dialogName");
    var name = nameInput ? (nameInput.value.trim() || "Телевидение") : "Телевидение";
    var url = document.getElementById("dialogPlaylist").value.trim();
    var media = document.getElementById("dialogMedia").value.trim();
    savePlaylistValues(name, url, media);
  }

  function savePlaylistValues(name, url, media) {
    if (!url) { showToast("Укажите адрес M3U"); return; }
    var existing = state.dialog && !state.dialog.isNew ? activePlaylist() : null;
    if (existing) { existing.name = name; existing.url = url; existing.mediaUrl = media; }
    else { store.playlists.push({ name: name, url: url, mediaUrl: media }); store.activePlaylist = store.playlists.length - 1; }
    clearSourcePair(); persist(); state.dialog = null; state.playlist = null; state.channels = []; loadActivePlaylist(true);
  }

  function clearSourcePair() {
    clearInterval(sourcePairTimer);
    sourcePairTimer = 0;
  }

  function startSourcePair() {
    if (!state.dialog || !sourcePairBase) return;
    clearSourcePair();
    state.dialog.pair = null;
    state.dialog.pairError = "";
    showToast("Создаём код для телефона…");
    fetch(sourcePairBase + "/api/tv-pair/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }).then(function (response) {
      return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || "Не удалось создать код"); return body; });
    }).then(function (pair) {
      if (!state.dialog) return;
      state.dialog.pair = pair;
      state.focusId = "source-pair-new";
      render();
      sourcePairTimer = setInterval(checkSourcePair, 1800);
    }).catch(function (error) {
      if (!state.dialog) return;
      state.dialog.pairError = error.message || "Сервис передачи недоступен";
      render();
    });
  }

  function checkSourcePair() {
    var pair = state.dialog && state.dialog.pair;
    if (!pair) return clearSourcePair();
    fetch(sourcePairBase + "/api/tv-pair/" + encodeURIComponent(pair.code) + "/status?pollToken=" + encodeURIComponent(pair.pollToken)).then(function (response) {
      return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || "Не удалось получить источник"); return body; });
    }).then(function (result) {
      if (result.status !== "ready" || !result.source) return;
      var source = result.source;
      showToast("Источник получен с телефона");
      savePlaylistValues(source.name || "Телевидение", source.url, source.mediaUrl || "");
    }).catch(function (error) {
      clearSourcePair();
      if (!state.dialog) return;
      state.dialog.pair = null;
      state.dialog.pairError = error.message || "Код передачи больше не действует";
      render();
    });
  }

  function selectPlaylist(index) {
    if (!store.playlists[index] || index === store.activePlaylist) return;
    store.activePlaylist = index; persist(); state.playlist = null; state.channels = []; state.groups = []; state.error = ""; loadActivePlaylist(true);
  }

  function openMediaEntry(index) {
    var entry = state.media.folder && state.media.folder.entries[index];
    if (!entry) return;
    state.media.index = index;
    openMediaResult(entry);
  }

  function openMediaResult(entry) {
    if (entry.isFolder) loadMediaFolder(entry.folderUrl, true);
    else if (entry.streamUrl) {
      state.screen = "viewer"; state.panel = "hidden"; state.overlay = "controls";
      state.channel = { name: entry.title, logo: entry.logo, url: entry.streamUrl, epgId: "", catchupDays: 0 };
      state.isArchive = true; state.archiveProgram = { title: entry.title, description: entry.description || "", start: Date.now(), end: Date.now() + 7200000 };
      state.playbackUrl = D.normalizeStream(entry.streamUrl); playChannel(state.channel, true);
    }
  }

  function closePlayback() {
    video.pause(); video.removeAttribute("src"); video.load(); video.classList.remove("visible"); backdrop.style.display = "block";
    state.panel = "hidden"; state.overlay = ""; releaseWakeLock();
  }

  function selectAudio(index) {
    var tracks = video.audioTracks;
    if (tracks && tracks.length) for (var i = 0; i < tracks.length; i += 1) tracks[i].enabled = i === index;
    state.overlay = ""; showToast("Аудиодорожка выбрана"); render();
  }

  function seek(seconds) {
    var duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds));
    render();
  }

  function requestWakeLock() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request("screen").then(function (lock) { wakeLock = lock; }).catch(function () {});
  }

  function releaseWakeLock() { if (wakeLock && wakeLock.release) wakeLock.release(); wakeLock = null; }

  function restoreFocus() {
    setTimeout(function () {
      var target = state.focusId ? document.querySelector('[data-focus="' + state.focusId + '"]') : null;
      if (!target) target = document.querySelector(".focusable");
      if (target && target.focus) target.focus();
    }, 0);
  }

  function spatialMove(direction) {
    var elements = Array.prototype.slice.call(document.querySelectorAll(".focusable:not([disabled])"));
    var current = document.activeElement;
    if (elements.indexOf(current) < 0) { if (elements[0]) elements[0].focus(); return; }
    var from = current.getBoundingClientRect(); var fx = from.left + from.width / 2; var fy = from.top + from.height / 2;
    var best = null; var score = Infinity;
    elements.forEach(function (candidate) {
      if (candidate === current) return;
      var r = candidate.getBoundingClientRect(); var x = r.left + r.width / 2; var y = r.top + r.height / 2; var dx = x - fx; var dy = y - fy;
      if ((direction === "left" && dx >= -2) || (direction === "right" && dx <= 2) || (direction === "up" && dy >= -2) || (direction === "down" && dy <= 2)) return;
      var primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      var secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      var value = primary + secondary * 2.7;
      if (value < score) { score = value; best = candidate; }
    });
    if (best) { best.focus(); state.focusId = best.getAttribute("data-focus") || ""; }
  }

  function viewerArrow(direction) {
    if (state.overlay === "info" && direction === "down") {
      state.overlay = "";
      state.focusId = "";
      render();
      return;
    }
    if (state.overlay) { spatialMove(direction); return; }
    if (state.panel === "hidden") {
      if (direction === "right") { state.panel = "channels"; state.focusId = "channel-" + state.channelIndex; render(); }
      else if (direction === "up") { state.overlay = "info"; state.focusId = "info-start"; render(); }
      else if (direction === "down") { state.overlay = "audio"; state.focusId = "audio-0"; render(); }
      return;
    }
    if (state.panel === "categories") {
      if (direction === "up") state.categoryIndex = Math.max(-1, state.categoryIndex - 1);
      else if (direction === "down") state.categoryIndex = Math.min(categories().length - 1, state.categoryIndex + 1);
      else if (direction === "right") state.panel = "channels";
      else if (direction === "left") state.panel = "hidden";
      state.focusId = state.panel === "categories" ? (state.categoryIndex < 0 ? "search-open" : "cat-" + state.categoryIndex) : "channel-" + state.channelIndex; render(); return;
    }
    if (state.panel === "channels") {
      var list = filteredChannels(); var grid = store.settings.view === "grid";
      if (direction === "up") state.channelIndex = Math.max(0, state.channelIndex - (grid ? 3 : 1));
      else if (direction === "down") state.channelIndex = Math.min(list.length - 1, state.channelIndex + (grid ? 3 : 1));
      else if (direction === "left" && (!grid || state.channelIndex % 3 === 0)) state.panel = "categories";
      else if (direction === "right" && (!grid || state.channelIndex % 3 === 2)) { state.panel = "guide"; loadPrograms(list[state.channelIndex], false); }
      else if (direction === "left") state.channelIndex = Math.max(0, state.channelIndex - 1);
      else if (direction === "right") state.channelIndex = Math.min(list.length - 1, state.channelIndex + 1);
      state.focusId = state.panel === "channels" ? "channel-" + state.channelIndex : state.panel === "categories" ? "cat-" + state.categoryIndex : "program-" + state.guideIndex; render(); return;
    }
    if (state.panel === "guide") {
      var programs = state.channel ? state.programs[state.channel.epgId] || [] : [];
      if (direction === "up") state.guideIndex = Math.max(0, state.guideIndex - 1);
      else if (direction === "down") state.guideIndex = Math.min(programs.length - 1, state.guideIndex + 1);
      else if (direction === "left") state.panel = "channels";
      state.focusId = state.panel === "guide" ? "program-" + state.guideIndex : "channel-" + state.channelIndex; render();
    }
  }

  function viewerEnter() {
    if (playbackBlocked) {
      playbackBlocked = false;
      var startPromise = video.play();
      if (startPromise && startPromise.catch) startPromise.catch(function () { playbackBlocked = true; });
    }
    if (state.overlay) {
      var active = document.activeElement; if (active && active.click) active.click(); return;
    }
    if (state.panel === "hidden") { state.overlay = "controls"; state.focusId = "control-play"; render(); return; }
    if (state.panel === "categories") {
      if (state.categoryIndex < 0) { state.overlay = "search"; state.searchQuery = ""; state.focusId = "key-0"; render(); return; }
      var cat = categories()[state.categoryIndex]; if (!cat) return;
      state.selectedGroup = cat.id; state.channelIndex = 0; state.panel = "channels"; state.focusId = "channel-0"; render(); return;
    }
    if (state.panel === "channels") {
      var channel = filteredChannels()[state.channelIndex]; if (channel) playChannel(channel, false); return;
    }
    if (state.panel === "guide") {
      var programs = state.channel ? state.programs[state.channel.epgId] || [] : [];
      var program = programs[state.guideIndex]; if (program && program.start <= Date.now()) { if (program.end <= Date.now()) playArchive(program); else goLive(); }
    }
  }

  function back() {
    if (state.dialog) { clearSourcePair(); state.dialog = null; render(); return; }
    if (state.screen === "viewer") {
      if (state.overlay === "search" && state.searchQuery) { state.searchQuery = state.searchQuery.slice(0, -1); render(); return; }
      if (state.overlay) { state.overlay = ""; render(); return; }
      if (state.panel !== "hidden") { state.panel = "hidden"; render(); return; }
      closePlayback(); state.screen = "home"; render(); return;
    }
    if (state.screen === "media") {
      if (state.media.search && state.media.searchQuery) { state.media.searchQuery = state.media.searchQuery.slice(0, -1); render(); return; }
      if (state.media.search) { state.media.search = false; render(); return; }
      if (state.media.stack.length > 1) { state.media.stack.pop(); state.media.folder = state.media.stack[state.media.stack.length - 1].folder; state.media.index = 0; render(); }
      else { state.screen = "home"; render(); }
      return;
    }
    if (state.screen !== "home") { state.screen = "home"; render(); }
  }

  function keyDirection(event) {
    var key = event.key; var code = event.keyCode;
    if (key === "ArrowLeft" || code === 37) return "left";
    if (key === "ArrowRight" || code === 39) return "right";
    if (key === "ArrowUp" || code === 38) return "up";
    if (key === "ArrowDown" || code === 40) return "down";
    return "";
  }

  document.addEventListener("keydown", function (event) {
    var direction = keyDirection(event); var code = event.keyCode; var key = event.key;
    var isBack = key === "Backspace" || key === "Escape" || code === 8 || code === 27 || code === 461 || code === 10009;
    var isEnter = key === "Enter" || code === 13;
    if (isBack) { event.preventDefault(); back(); return; }
    if (state.dialog && (document.activeElement && document.activeElement.tagName === "INPUT") && !direction && !isEnter) return;
    if (direction) { event.preventDefault(); if (state.screen === "viewer") viewerArrow(direction); else spatialMove(direction); return; }
    if (isEnter) {
      event.preventDefault();
      if (!enterDownAt) { enterDownAt = Date.now(); enterLongHandled = false; }
      if (state.screen === "viewer" && state.panel === "channels" && !enterLongHandled && Date.now() - enterDownAt > 650) {
        var channel = filteredChannels()[state.channelIndex]; if (channel) toggleFavorite(channel); enterLongHandled = true;
      }
      return;
    }
    if (state.screen === "viewer" && state.overlay === "search" && key && key.length === 1 && /[a-zа-яё0-9 ]/i.test(key)) { state.searchQuery += key.toLowerCase(); render(); }
    else if (state.screen === "media" && state.media.search && key && key.length === 1 && /[a-zа-яё0-9 ]/i.test(key)) { state.media.searchQuery += key.toLowerCase(); render(); }
  });

  document.addEventListener("keyup", function (event) {
    var isEnter = event.key === "Enter" || event.keyCode === 13;
    if (!isEnter) return;
    event.preventDefault();
    if (!enterLongHandled) {
      if (state.screen === "viewer") viewerEnter();
      else { var active = document.activeElement; if (active && active.click) active.click(); }
    }
    enterDownAt = 0; enterLongHandled = false;
  });

  function reloadPlayback(reason) {
    if (!state.playbackUrl || stallReloads >= 2) return;
    stallReloads += 1;
    var time = state.isArchive ? video.currentTime : 0;
    video.src = state.playbackUrl; video.load();
    video.addEventListener("loadedmetadata", function restore() { video.removeEventListener("loadedmetadata", restore); if (time) video.currentTime = time; video.play(); });
    showToast(reason || "Восстанавливаю поток…");
  }

  function handleLongBuffering() {
    clearTimeout(waitingTimer);
    waitingTimer = setTimeout(function () {
      if (store.settings.quality === "auto" && !state.isArchive) {
        var fallback = D.qualityFallback(state.channel, state.channels);
        if (fallback) {
          state.playbackUrl = D.normalizeStream(fallback.url); video.src = state.playbackUrl; video.load(); video.play();
          showToast("Слабое соединение — включено обычное качество"); return;
        }
      }
      reloadPlayback("Поток завис — переподключаюсь…");
    }, store.settings.buffer === "stable" ? 18000 : store.settings.buffer === "fast" ? 8000 : 12000);
  }

  video.addEventListener("waiting", handleLongBuffering);
  video.addEventListener("stalled", handleLongBuffering);
  video.addEventListener("playing", function () { clearTimeout(waitingTimer); stallReloads = 0; lastProgress = { time: video.currentTime, at: Date.now() }; });
  video.addEventListener("error", function () { reloadPlayback("Ошибка потока — пробую ещё раз…"); });
  video.addEventListener("timeupdate", function () {
    if (Math.abs(video.currentTime - lastProgress.time) > .5) lastProgress = { time: video.currentTime, at: Date.now() };
  });
  setInterval(function () {
    if (state.screen === "viewer" && !playbackBlocked && !video.paused && Date.now() - lastProgress.at > 25000) reloadPlayback("Поток остановился — восстанавливаю…");
    if (state.screen === "viewer") {
      Object.keys(state.programs).forEach(function (id) { state.currentByChannel[id] = D.currentProgram(state.programs[id]); });
      if (state.panel !== "hidden" || state.overlay === "info") scheduleRender();
    }
  }, 30000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden && state.screen === "viewer") requestWakeLock(); });

  function scaleStage() {
    var stage = document.getElementById("stage");
    if (isMobileLayout()) {
      stage.style.transform = "none";
      stage.style.left = "0";
      stage.style.top = "0";
      stage.style.width = "100%";
      stage.style.height = "100dvh";
      return;
    }
    stage.style.width = "1920px";
    stage.style.height = "1080px";
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = "scale(" + scale + ")";
    stage.style.left = ((window.innerWidth - 1920 * scale) / 2) + "px";
    stage.style.top = ((window.innerHeight - 1080 * scale) / 2) + "px";
  }

  window.addEventListener("resize", scaleStage);
  migrateSources(); scaleStage(); render();
  if (activePlaylist()) loadActivePlaylist(false).catch(function () {});
  else openPlaylistDialog(true, true);
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js?v=4").catch(function () {});
    });
  }
  setTimeout(function () { document.getElementById("splash").classList.add("hidden"); }, 1500);
}());
