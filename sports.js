(function (global) {
  "use strict";

  var DAY = 86400000;
  var CLUSTER = 45 * 60000;
  var sportMatchers = [
    ["football", "Футбол", "⚽", /(футбол|football|soccer|апл|рпл|ла лига|лига чемпионов|лига европы|чемпионат мира-?2026)/i],
    ["hockey", "Хоккей", "◆", /(хоккей|hockey|кхл|нхл|вхл|nhl|khl)/i],
    ["basketball", "Баскетбол", "●", /(баскетбол|basketball|nba|нба|евролига)/i],
    ["tennis", "Теннис", "◉", /(теннис|tennis|уимблдон|wimbledon|atp|wta)/i],
    ["volleyball", "Волейбол", "◇", /(волейбол|volleyball)/i],
    ["combat", "Единоборства", "✦", /(бокс|boxing|mma|ufc|единоборств|bare knuckle)/i],
    ["motorsport", "Автоспорт", "▰", /(формула[ -]?1|formula[ -]?1|motogp|автоспорт|nascar)/i]
  ];
  var livePattern = /\b(прямой эфир|прямая трансляция|live)\b/i;
  var replayPattern = /\b(повтор|запись|архив)\b|\b(19|20)\d{2}\s*(г\.?|год)/i;
  var pairPattern = /\s(?:-|–|—|vs\.?|v\.?|против)\s/i;

  function sportFor(value) {
    for (var i = 0; i < sportMatchers.length; i += 1) {
      if (sportMatchers[i][3].test(value || "")) return { id: sportMatchers[i][0], title: sportMatchers[i][1], glyph: sportMatchers[i][2] };
    }
    return null;
  }

  function sports() {
    return sportMatchers.map(function (item) { return { id: item[0], title: item[1], glyph: item[2] }; });
  }

  function competitionFor(value) {
    var list = [
      ["Чемпионат мира", /чемпионат мира|world cup|fifa/i], ["Лига чемпионов", /лига чемпионов|champions league/i],
      ["Лига Европы", /лига европы|europa league/i], ["Премьер-лига", /премьер-лига|премьер лига|\bапл\b|premier league/i],
      ["Ла Лига", /ла лига|la liga|чемпионат испании/i], ["Бундеслига", /бундеслига|bundesliga|чемпионат германии/i],
      ["Серия А", /серия а|serie a|чемпионат италии/i], ["НХЛ", /\bнхл\b|\bnhl\b/i],
      ["КХЛ", /\bкхл\b|\bkhl\b/i], ["Уимблдон", /уимблдон|wimbledon/i], ["UFC", /\bufc\b/i]
    ];
    for (var i = 0; i < list.length; i += 1) if (list[i][1].test(value || "")) return list[i][0];
    return "";
  }

  function eventTitle(raw) {
    var value = String(raw || "").replace(livePattern, "").replace(/\s+/g, " ").replace(/^[\s:.,-]+|[\s:.,-]+$/g, "");
    var parts = value.split(/[.!?]\s+/);
    for (var i = 0; i < parts.length; i += 1) if (pairPattern.test(parts[i])) return parts[i].replace(/^[\s:.,-]+|[\s:.,-]+$/g, "");
    var match = value.match(/([^.!?]{2,})\s(?:-|–|—|vs\.?)\s([^.!?]{2,})/i);
    return match ? match[0].trim() : value;
  }

  function canonical(value) {
    return String(value || "").toLowerCase().replace(/ё/g, "е").replace(/\b(прямой эфир|прямая трансляция|live|hd|fhd|uhd|4k)\b/g, " ").replace(/[^a-zа-я0-9]+/gi, " ").replace(/\s+/g, " ").trim();
  }

  function stateFor(start, end, replay, now) {
    if (!replay && start <= now && end > now) return "live";
    if (start > now) return "upcoming";
    return "replay";
  }

  function buildLocal(records, channels, now) {
    var byEpg = {};
    channels.forEach(function (channel) {
      if (!channel.epgId) return;
      (byEpg[channel.epgId] || (byEpg[channel.epgId] = [])).push(channel);
    });
    var groups = [];
    (records || []).forEach(function (record) {
      var channelId = record[0]; var start = +record[1]; var end = +record[2]; var rawTitle = record[3] || ""; var category = record[4] || "";
      if (end < startOfDay(now) || start >= startOfDay(now) + DAY) return;
      var matchedChannels = byEpg[channelId] || [];
      if (!matchedChannels.length) return;
      var sport = sportFor(rawTitle + " " + category);
      if (!sport || !pairPattern.test(rawTitle)) return;
      var title = eventTitle(rawTitle); var key = sport.id + ":" + canonical(title);
      if (key.length < 8) return;
      var group = null;
      for (var i = groups.length - 1; i >= 0; i -= 1) {
        if (groups[i].key === key && Math.abs(groups[i].anchor - start) <= CLUSTER) { group = groups[i]; break; }
      }
      if (!group) {
        group = { key: key, sport: sport, title: title, competition: competitionFor(rawTitle + " " + category), anchor: start, broadcasts: [] };
        groups.push(group);
      }
      matchedChannels.forEach(function (channel) {
        group.broadcasts.push({ channel: channel, program: { start: start, end: end, title: rawTitle, category: category }, explicitLive: livePattern.test(rawTitle), replay: replayPattern.test(rawTitle) });
      });
    });
    return groups.map(function (group) {
      var unique = {}; var broadcasts = group.broadcasts.filter(function (item) {
        var id = item.channel.id + ":" + item.program.start; if (unique[id]) return false; unique[id] = true; return true;
      }).sort(function (a, b) {
        var ahd = /\b(hd|fhd|uhd|4k)\b/i.test(a.channel.name) ? 1 : 0;
        var bhd = /\b(hd|fhd|uhd|4k)\b/i.test(b.channel.name) ? 1 : 0;
        return bhd - ahd || a.channel.name.localeCompare(b.channel.name);
      });
      var start = Math.min.apply(null, broadcasts.map(function (item) { return item.program.start; }));
      var end = Math.max.apply(null, broadcasts.map(function (item) { return item.program.end; }));
      var replay = broadcasts.every(function (item) { return item.replay; });
      return { id: group.key + ":" + Math.floor(start / CLUSTER), sport: group.sport, title: group.title, competition: group.competition, start: start, end: end, state: stateFor(start, end, replay, now), broadcasts: broadcasts, fixture: null };
    });
  }

  function aliases(value) {
    var result = String(value || "").toLowerCase().replace(/ё/g, "е");
    var map = {
      "франция":"france", "испания":"spain", "англия":"england", "аргентина":"argentina", "германия":"germany", "италия":"italy",
      "португалия":"portugal", "бразилия":"brazil", "нидерланды":"netherlands", "бельгия":"belgium", "хорватия":"croatia",
      "швейцария":"switzerland", "австрия":"austria", "польша":"poland", "турция":"turkey", "украина":"ukraine", "сша":"usa",
      "мексика":"mexico", "канада":"canada", "япония":"japan", "китай":"china", "псж":"paris saint germain",
      "ман сити":"manchester city", "ман юнайтед":"manchester united", "интер майами":"inter miami"
    };
    Object.keys(map).forEach(function (key) { result = result.split(key).join(map[key]); });
    return result;
  }

  function latin(value) {
    var map = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ж:"zh",з:"z",и:"i",й:"i",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",ч:"ch",ш:"sh",щ:"shch",ы:"y",э:"e",ю:"yu",я:"ya",ь:"",ъ:"" };
    var result = aliases(value).split("").map(function (char) { return map[char] == null ? char : map[char]; }).join("");
    if (result.normalize) result = result.normalize("NFD");
    return result.replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function levenshtein(left, right) {
    var previous = []; var current = []; var i; var j;
    for (j = 0; j <= right.length; j += 1) previous[j] = j;
    for (i = 1; i <= left.length; i += 1) {
      current[0] = i;
      for (j = 1; j <= right.length; j += 1) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1));
      previous = current.slice();
    }
    return previous[right.length];
  }

  function teamMatches(haystack, team) {
    var needle = latin(team).replace(/\b(fc|cf|afc|club|football)\b/g, " ").replace(/\s+/g, " ").trim();
    if (needle.length < 3) return false;
    if (haystack.indexOf(needle) >= 0) return true;
    var hay = haystack.split(" ").filter(function (item) { return item.length >= 3; });
    var tokens = needle.split(" ").filter(function (item) { return item.length >= 3; });
    var matched = tokens.filter(function (token) {
      return hay.some(function (candidate) { return candidate === token || levenshtein(candidate, token) <= (token.length >= 7 ? 2 : 1); });
    }).length;
    return tokens.length > 0 && matched >= Math.max(1, Math.ceil(tokens.length / 2));
  }

  function matchFixture(event, fixtures) {
    var haystack = latin(event.title);
    var best = null;
    (fixtures || []).forEach(function (fixture) {
      if ((fixture.sport || "football") !== event.sport.id || Math.abs(+fixture.startMillis - event.start) > 4 * 3600000) return;
      var score = (teamMatches(haystack, fixture.home) ? 1 : 0) + (teamMatches(haystack, fixture.away) ? 1 : 0);
      if (score >= 2 && (!best || score > best.score)) best = { fixture: fixture, score: score };
    });
    return best && best.fixture;
  }

  function fixtureState(fixture, linked, now) {
    var status = String(fixture.status || "").toUpperCase();
    if (["1H","HT","2H","ET","BT","P","LIVE","IN PLAY","IN_PLAY","SUSP","INT"].indexOf(status) >= 0) return "live";
    if (["FT","AET","PEN","AWD","WO","CANC","ABD"].indexOf(status) >= 0) return "replay";
    if (linked) return linked.state;
    if (+fixture.startMillis > now) return "upcoming";
    return now - +fixture.startMillis <= 3 * 3600000 ? "live" : "replay";
  }

  function build(records, channels, fixtures, now) {
    now = now || Date.now();
    var events = buildLocal(records, channels, now);
    events.forEach(function (event) {
      var fixture = matchFixture(event, fixtures);
      if (fixture) { event.fixture = fixture; event.competition = fixture.competition || event.competition; }
    });
    events.sort(function (a, b) {
      var order = { live: 0, upcoming: 1, replay: 2 };
      return order[a.state] - order[b.state] || a.start - b.start;
    });
    var byFixture = {};
    events.forEach(function (event) { if (event.fixture) byFixture[event.fixture.id] = event; });
    var featured = (fixtures || []).map(function (fixture) {
      var linked = byFixture[fixture.id] || null;
      return { fixture: fixture, linkedEvent: linked, state: fixtureState(fixture, linked, now) };
    }).sort(function (a, b) {
      var order = { live: 0, upcoming: 1, replay: 2 };
      return order[a.state] - order[b.state] || +a.fixture.startMillis - +b.fixture.startMillis;
    }).slice(0, 10);
    return { events: events, featured: featured };
  }

  function startOfDay(value) { var date = new Date(value); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
  function localDate(value) {
    var date = new Date(value || Date.now());
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }

  global.TVSports = { build: build, sports: sports, sportFor: sportFor, localDate: localDate, eventTitle: eventTitle };
}(window));
