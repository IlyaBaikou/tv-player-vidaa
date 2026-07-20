#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playlistUrl = process.argv[2] || process.env.TV_PLAYER_PLAYLIST_URL;
if (!playlistUrl) throw new Error("Передайте URL M3U аргументом или через TV_PLAYER_PLAYLIST_URL");

const playlistResponse = await fetch(playlistUrl, { cache: "no-store" });
if (!playlistResponse.ok) throw new Error(`M3U: HTTP ${playlistResponse.status}`);
const playlist = await playlistResponse.text();
const header = playlist.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
const epgMatch = header.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i);
if (!epgMatch?.[1]) throw new Error("В M3U не найден url-tvg");

const accepted = new Set();
for (const line of playlist.split(/\r?\n/)) {
  if (!line.startsWith("#EXTINF")) continue;
  const logo = line.match(/tvg-logo="([^"]*)"/i)?.[1] || "";
  const inferred = logo.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const epgId = line.match(/tvg-id="([^"]*)"/i)?.[1] || inferred;
  if (epgId) accepted.add(epgId);
}

const now = Date.now();
const from = now - 7 * 86400000;
const to = now + 3 * 86400000;
const buckets = Array.from({ length: 256 }, () => Object.create(null));
const sports = [];
let count = 0;
let bytes = 0;

function bucketFor(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash * 31) + value.charCodeAt(i)) >>> 0;
  return hash % 256;
}

function xmlDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/.exec(value || "");
  if (!m) return 0;
  let time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) time += (m[7] === "+" ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60000;
  return time;
}

function entities(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(+code))
    .replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  return entities(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1] || "");
}

const sportPattern = /(футбол|football|soccer|апл|рпл|ла лига|лига чемпионов|лига европы|хоккей|hockey|кхл|нхл|вхл|nhl|khl|баскетбол|basketball|nba|нба|евролига|теннис|tennis|уимблдон|wimbledon|atp|wta|волейбол|volleyball|бокс|boxing|mma|ufc|единоборств|bare knuckle|формула[ -]?1|formula[ -]?1|motogp|автоспорт|nascar)/i;
const pairPattern = /\s(?:-|–|—|vs\.?|v\.?|против)\s/i;

function parseProgramme(block) {
  const open = block.slice(0, block.indexOf(">") + 1);
  const channel = open.match(/channel="([^"]+)"/i)?.[1] || "";
  if (!accepted.has(channel)) return;
  const start = xmlDate(open.match(/start="([^"]+)"/i)?.[1]);
  const end = xmlDate(open.match(/stop="([^"]+)"/i)?.[1]);
  if (!start || end < from || start > to) return;
  const item = [start, end, tag(block, "title") || "Без названия", tag(block, "desc"), tag(block, "category")];
  const bucket = buckets[bucketFor(channel)];
  (bucket[channel] ||= []).push(item);
  if (sportPattern.test(`${item[2]} ${item[4]}`) && pairPattern.test(item[2])) sports.push([channel, start, end, item[2], item[4]]);
  count += 1;
}

console.log(`Загружаю XMLTV для ${accepted.size} каналов…`);
const epgResponse = await fetch(epgMatch[1], { headers: { "Accept-Encoding": "gzip, br" } });
if (!epgResponse.ok || !epgResponse.body) throw new Error(`EPG: HTTP ${epgResponse.status}`);
const decoder = new TextDecoder();
let buffer = "";
let started = false;
let lastReport = 0;
for await (const chunk of epgResponse.body) {
  bytes += chunk.byteLength;
  buffer += decoder.decode(chunk, { stream: true });
  if (!started) {
    const first = buffer.indexOf("<programme");
    if (first < 0) {
      if (buffer.length > 1024 * 1024) buffer = buffer.slice(-128);
      continue;
    }
    buffer = buffer.slice(first);
    started = true;
  }
  let end;
  while ((end = buffer.indexOf("</programme>")) >= 0) {
    const block = buffer.slice(0, end + 12);
    const next = buffer.indexOf("<programme", end + 12);
    buffer = next >= 0 ? buffer.slice(next) : buffer.slice(end + 12);
    parseProgramme(block);
  }
  if (bytes - lastReport > 25 * 1024 * 1024) {
    lastReport = bytes;
    console.log(`${Math.round(bytes / 1024 / 1024)} МБ · подходящих передач: ${count}`);
  }
}

const output = path.join(root, "epg");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
let writtenBuckets = 0;
for (let i = 0; i < buckets.length; i += 1) {
  const data = buckets[i];
  if (!Object.keys(data).length) continue;
  for (const programs of Object.values(data)) programs.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(path.join(output, `bucket-${i.toString(16).padStart(2, "0")}.json`), JSON.stringify(data));
  writtenBuckets += 1;
}
fs.writeFileSync(path.join(output, "meta.json"), JSON.stringify({ generatedAt: Date.now(), channels: accepted.size, programs: count, buckets: writtenBuckets }, null, 2));
fs.writeFileSync(path.join(output, "sports.json"), JSON.stringify({ generatedAt: Date.now(), records: sports.sort((a, b) => a[1] - b[1]) }));
console.log(`Готово: ${count} передач, ${writtenBuckets} чанков, ${Math.round(bytes / 1024 / 1024)} МБ прочитано.`);
