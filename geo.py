# -*- coding: utf-8 -*-
"""Поиск адресов и мест (подсказки как в Яндекс Картах) на бесплатных
источниках без ключей: Photon (komoot, хорош для названий мест и поиска "на
ходу") + OpenStreetMap Nominatim (адреса, обратный геокодинг, районы).
Результаты объединяются и дедуплицируются. Используется и приложением
(pauseapp.api_geocode/api_reverse_geocode), и ботом (автозаполнение
координат новой точки при подтверждении заказа)."""
import asyncio
import logging
import re
import time
import urllib.parse

import aiohttp

logger = logging.getLogger(__name__)

# Ташкент: minLon, minLat, maxLon, maxLat
_BBOX = (68.9, 41.15, 69.6, 41.45)
_VIEWBOX = "68.9,41.45,69.6,41.15"  # Nominatim: left,top,right,bottom
_UA = "PauseAppTashkent/1.0 (lunch delivery mini app; Telegram bot)"
_CACHE: dict = {}
_TTL = 6 * 3600
_NOM_LOCK = asyncio.Lock()
_NOM_LAST = [0.0]


def _in_city(lat, lon) -> bool:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return _BBOX[0] <= lon <= _BBOX[2] and _BBOX[1] <= lat <= _BBOX[3]


def norm(s: str) -> str:
    return re.sub(r"[^0-9a-zа-яё]+", "", (s or "").lower())


async def _get(url: str, throttle: bool):
    now = time.time()
    hit = _CACHE.get(url)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    if throttle:
        # Nominatim: политика сервиса — не чаще 1 запроса в секунду
        async with _NOM_LOCK:
            wait = 1.0 - (time.time() - _NOM_LAST[0])
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                data = await _fetch(url)
            finally:
                _NOM_LAST[0] = time.time()
    else:
        data = await _fetch(url)
    if len(_CACHE) > 600:
        _CACHE.clear()
    _CACHE[url] = (time.time(), data)
    return data


async def _fetch(url: str):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=6)) as session:
        async with session.get(url, headers={"User-Agent": _UA}) as resp:
            return await resp.json(content_type=None)


def _compose(name: str, street: str, district: str, fallback: str, lat, lon) -> dict:
    name = (name or "").strip()
    if name and street and name == street.split(",")[0]:
        name = ""
    if name and street:
        title, label = name, f"{name} ({street})"
    elif name:
        title = label = name
    elif street:
        title = label = street
    else:
        title = label = fallback
    sub = [x for x in ((street if name else ""), district) if x]
    return {"title": title, "subtitle": ", ".join(sub), "label": label,
            "district": district, "lat": lat, "lon": lon}


def format_nominatim(d: dict) -> dict:
    a = d.get("address") or {}
    road = a.get("road") or a.get("pedestrian") or a.get("footway") or a.get("residential") or ""
    house = a.get("house_number") or ""
    street = (road + (", " + house if house else "")).strip(", ")
    district = a.get("city_district") or a.get("suburb") or a.get("borough") or a.get("neighbourhood") or ""
    name = (d.get("name") or "").strip()
    parts = [x.strip() for x in (d.get("display_name") or "").split(",") if x.strip()]
    return _compose(name, street, district, ", ".join(parts[:2]), d.get("lat"), d.get("lon"))


def format_photon(f: dict) -> dict:
    p = f.get("properties") or {}
    lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
    street = (p.get("street") or "") + (", " + p["housenumber"] if p.get("housenumber") and p.get("street") else "")
    district = p.get("district") or p.get("locality") or ""
    return _compose(p.get("name") or "", street, district, p.get("city") or "", str(lat), str(lon))


async def _photon(q: str) -> list:
    params = {"q": q, "limit": "8", "lat": "41.3111", "lon": "69.2406",
              "bbox": "{},{},{},{}".format(*_BBOX)}
    data = await _get("https://photon.komoot.io/api/?" + urllib.parse.urlencode(params), False)
    return [format_photon(f) for f in (data or {}).get("features", [])]


async def _nominatim_search(q: str) -> list:
    params = {"format": "jsonv2", "q": q, "limit": "6", "addressdetails": "1",
              "viewbox": _VIEWBOX, "bounded": "1", "countrycodes": "uz", "accept-language": "ru"}
    data = await _get("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params), True)
    return [format_nominatim(d) for d in (data or [])]


async def search(q: str) -> list:
    """Подсказки по тексту: Photon (места) + Nominatim (адреса), в пределах Ташкента."""
    q = (q or "").strip()
    if len(q) < 2:
        return []
    res = await asyncio.gather(_photon(q), _nominatim_search(q), return_exceptions=True)
    out, seen_t, seen_c = [], set(), set()
    for batch in res:
        if isinstance(batch, Exception):
            logger.warning("geo.search: источник недоступен: %s", batch)
            continue
        for it in batch:
            if not it["title"] or not _in_city(it["lat"], it["lon"]):
                continue
            tkey = norm(it["title"]) + "|" + norm(it["subtitle"])
            ckey = (round(float(it["lat"]), 4), round(float(it["lon"]), 4))
            if tkey in seen_t or ckey in seen_c:
                continue
            seen_t.add(tkey)
            seen_c.add(ckey)
            out.append(it)
    return out[:8]


async def reverse(lat: float, lon: float):
    params = {"format": "jsonv2", "lat": "%.5f" % lat, "lon": "%.5f" % lon,
              "zoom": "18", "addressdetails": "1", "accept-language": "ru"}
    try:
        data = await _get("https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(params), True)
    except Exception:
        logger.exception("geo.reverse")
        return None
    if not isinstance(data, dict) or data.get("error"):
        return None
    place = format_nominatim(data)
    place["lat"], place["lon"] = lat, lon
    return place


async def geocode_point(name: str):
    """Лучшее совпадение по названию точки (для автозаполнения координат)."""
    items = await search(name + ", Ташкент")
    return items[0] if items else None
