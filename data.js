(function (global) {
  "use strict";

  var STORAGE_KEY = "tv-player-vidaa-v1";

  function hash(value) {
    var h = 2166136261;
    for (var i = 0; i < value.length; i += 1) {
      h ^= value.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(36);
  }

  function loadStore() {
    var defaults = {
      playlists: [], favorites: [], recent: [], activePlaylist: 0,
      archiveHistory: [], channelHealth: {},
      settings: { view: "list", scale: "fit", quality: "auto", buffer: "balanced" }
    };
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved) {
        Object.keys(saved).forEach(function (key) { defaults[key] = saved[key]; });
        defaults.settings = Object.assign({ view: "list", scale: "fit", quality: "auto", buffer: "balanced" }, saved.settings || {});
      }
    } catch (error) { /* use defaults */ }
    return defaults;
  }

  function saveStore(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch (error) { /* quota or privacy mode */ }
  }

  function attrs(line) {
    var result = {};
    var regex = /([\w-]+)="([^"]*)"/g;
    var match;
    while ((match = regex.exec(line))) result[match[1].toLowerCase()] = match[2];
    return result;
  }

  function absoluteUrl(base, value) {
    if (!value) return "";
    try { return new URL(value, base).toString(); } catch (error) { return value; }
  }

  function normalizeStream(url) {
    return String(url || "").replace(".plink-pile.ch/", ".plink-pile.su/");
  }

  function parseM3u(text) {
    var lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
    if (!lines[0] || lines[0].indexOf("#EXTM3U") !== 0) throw new Error("Файл не является M3U-плейлистом");
    var header = attrs(lines[0]);
    var logoBase = header["url-logo"] || "";
    var channels = [];
    var pending = null;
    for (var i = 1; i < lines.length; i += 1) {
      var line = lines[i].trim();
      if (line.indexOf("#EXTINF") === 0) pending = line;
      else if (pending && line && line.charAt(0) !== "#" && /^https?:\/\//i.test(line)) {
        var data = attrs(pending);
        var name = pending.substring(pending.lastIndexOf(",") + 1).trim() || "Канал";
        var logo = data["tvg-logo"] || "";
        var inferred = logo ? logo.substring(logo.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "") : "";
        var epgId = data["tvg-id"] || inferred;
        channels.push({
          id: hash(epgId + "|" + line), epgId: epgId, name: name,
          group: data["group-title"] || "Без категории",
          logo: absoluteUrl(logoBase, logo), url: line,
          catchupDays: parseInt(data["catchup-days"], 10) || (data["tvg-rec"] === "1" ? 1 : 0),
          catchupType: data["catchup-type"] || data.catchup || ""
        });
        pending = null;
      }
    }
    return { channels: channels, epgUrl: header["url-tvg"] || header["x-tvg-url"] || "" };
  }

  function fetchText(url, options) {
    if (!url) return Promise.reject(new Error("Адрес не указан"));
    return fetch(url, options || {}).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    });
  }

  function playlistCacheKey(url) { return "tv-player-playlist-cache-v1-" + hash(String(url || "")); }

  function readPlaylistCache(url) {
    try {
      var cached = JSON.parse(localStorage.getItem(playlistCacheKey(url)) || "null");
      if (cached && cached.data && Array.isArray(cached.data.channels)) return cached;
    } catch (error) { /* ignore corrupted or unavailable cache */ }
    return null;
  }

  function writePlaylistCache(url, data) {
    try { localStorage.setItem(playlistCacheKey(url), JSON.stringify({ savedAt: Date.now(), data: data })); }
    catch (error) { /* quota or privacy mode */ }
  }

  function fetchPlaylist(url) {
    return fetchText(url, { cache: "no-store" }).then(parseM3u).then(function (data) {
      writePlaylistCache(url, data);
      return data;
    });
  }

  function loadPlaylist(url, force) {
    var cached = !force && readPlaylistCache(url);
    if (!cached) return fetchPlaylist(url);
    // Показываем сохранённый список сразу, а свежую копию готовим для следующего запуска.
    setTimeout(function () { fetchPlaylist(url).catch(function () {}); }, 0);
    return Promise.resolve(cached.data);
  }

  function parseXmlDate(value) {
    var match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/.exec(value || "");
    if (!match) return 0;
    var time = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
    if (match[7]) {
      var offset = (+match[8] * 60 + +match[9]) * 60000;
      time += match[7] === "+" ? -offset : offset;
    }
    return time;
  }

  function decodeXml(text) {
    var node = document.createElement("textarea");
    node.innerHTML = String(text || "").replace(/<[^>]*>/g, " ");
    return node.value.replace(/\s+/g, " ").trim();
  }

  function parseMediaXml(text) {
    var xml = new DOMParser().parseFromString(text, "text/xml");
    var folderTitle = textOf(xml, "playlist_name") || "Медиатека";
    var nodes = xml.getElementsByTagName("channel");
    var entries = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var title = textOf(node, "title") || "Без названия";
      var folder = textOf(node, "playlist_url");
      var stream = textOf(node, "stream_url");
      entries.push({
        id: hash(folder + "|" + stream + "|" + title), title: title,
        logo: textOf(node, "logo_30x30"), folderUrl: folder, streamUrl: stream,
        description: textOf(node, "description"), search: textOf(node, "search_on").toLowerCase() === "search",
        isFolder: !!folder
      });
    }
    return { title: folderTitle, entries: entries };
  }

  function textOf(node, tag) {
    var item = node.getElementsByTagName(tag)[0];
    return item && item.textContent ? item.textContent.trim() : "";
  }

  function loadMedia(url) { return fetchText(url).then(parseMediaXml); }

  function bucketFor(channelId) {
    var h = 0;
    for (var i = 0; i < channelId.length; i += 1) h = ((h * 31) + channelId.charCodeAt(i)) >>> 0;
    return (h % 256).toString(16).padStart(2, "0");
  }

  var epgBucketCache = {};
  function loadPrograms(base, channelId) {
    if (!base || !channelId) return Promise.resolve([]);
    var bucket = bucketFor(channelId);
    if (!epgBucketCache[bucket]) {
      epgBucketCache[bucket] = fetch(base.replace(/\/$/, "") + "/bucket-" + bucket + ".json", { cache: "no-store" })
        .then(function (response) { if (!response.ok) throw new Error("EPG ещё не подготовлена"); return response.json(); })
        .catch(function (error) { delete epgBucketCache[bucket]; throw error; });
    }
    return epgBucketCache[bucket].then(function (data) {
      return (data[channelId] || []).map(function (item) {
        return { start: item[0], end: item[1], title: item[2], description: item[3] || "", category: item[4] || "" };
      });
    });
  }

  function archiveUrl(channel, program) {
    if (!channel || !program || !channel.catchupDays) return "";
    var playback = normalizeStream(channel.url);
    var parts = playback.split("?");
    var clean = parts[0];
    var start = Math.floor(program.start / 1000);
    var duration = Math.max(60, Math.floor((program.end - program.start) / 1000));
    var url = clean.substring(0, clean.lastIndexOf("/")) + "/archive-" + start + "-" + duration + ".m3u8";
    return parts[1] ? url + "?" + parts.slice(1).join("?") : url;
  }

  function baseName(name) {
    return String(name || "").replace(/(^|[\s._-])(uhd|fhd|hd|4k)(?=$|[\s._()+-])/ig, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function qualityFallback(source, channels) {
    if (!/(^|[\s._-])(uhd|fhd|hd|4k)(?=$|[\s._()+-])/i.test(source.name)) return null;
    var base = baseName(source.name);
    var matches = channels.filter(function (item) {
      return item.id !== source.id && item.group === source.group && !/(^|[\s._-])(uhd|fhd|hd|4k)(?=$|[\s._()+-])/i.test(item.name) && baseName(item.name) === base;
    });
    matches.sort(function (a, b) { return a.name.length - b.name.length; });
    return matches[0] || null;
  }

  function currentProgram(programs, now) {
    now = now || Date.now();
    for (var i = 0; i < programs.length; i += 1) if (programs[i].start <= now && programs[i].end > now) return programs[i];
    return null;
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  global.TVData = {
    loadStore: loadStore, saveStore: saveStore, hash: hash,
    loadPlaylist: loadPlaylist, parseM3u: parseM3u, normalizeStream: normalizeStream,
    loadMedia: loadMedia, loadPrograms: loadPrograms, archiveUrl: archiveUrl,
    qualityFallback: qualityFallback, currentProgram: currentProgram,
    formatTime: formatTime, parseXmlDate: parseXmlDate, decodeXml: decodeXml,
    fetchText: fetchText
  };
}(window));
