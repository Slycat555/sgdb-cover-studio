#!/usr/bin/env python3
"""Cover Studio — local server for building game artwork from SteamGridDB.

Standard library only. Serves the editor UI, proxies SteamGridDB / Steam store
requests (the SteamGridDB API has no CORS and needs your API key), finds your
Steam library, and writes finished artwork into Steam's custom grid folder.

    python3 server.py [--port 8765] [--no-browser] [--auto-exit]
"""
import argparse
import base64
import hashlib
import html
import json
import mmap
import os
import shutil
import socket
import subprocess
import re
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
HOME = Path.home()
IS_WINDOWS = os.name == "nt"
if IS_WINDOWS:   # %APPDATA% for settings, %LOCALAPPDATA% for the cache
    CONFIG_DIR = Path(os.environ.get("APPDATA") or HOME / "AppData/Roaming") / "sgdb-cover-studio"
    CACHE_DIR = Path(os.environ.get("LOCALAPPDATA") or HOME / "AppData/Local") / "sgdb-cover-studio" / "cache"
else:
    CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "sgdb-cover-studio"
    CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", HOME / ".cache")) / "sgdb-cover-studio"
CONFIG_FILE = CONFIG_DIR / "config.json"
GAME_FONTS_FILE = CONFIG_DIR / "game_fonts.json"     # fonts you picked, per game
USER_FONT_DIR = CONFIG_DIR / "fonts"                 # font files you uploaded
KNOWN_FONTS_FILE = APP_DIR / "known_fonts.json"      # fonts known to be used by specific games
FONT_CACHE_DIR = CACHE_DIR / "fonts"                 # fonts extracted from game data files

SGDB_BASE = "https://www.steamgriddb.com/api/v2/"
UA = "CoverStudio/1.0 (+local)"
STEAM_AGE_COOKIE = "birthtime=0; lastagecheckage=1-January-1990; wants_mature_content=1"

IMG_HOST_SUFFIXES = ("steamgriddb.com", "steamstatic.com", "steampowered.com",
                     "akamaihd.net", "steamusercontent.com")
SGDB_PATH_RE = re.compile(r"^(search/autocomplete/[^/?]+|games/(id|steam)/\d+|"
                          r"(grids|heroes|logos|icons)/game/\d+)(\?[\w=&,.%/-]*)?$")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
FONT_EXTS = (".ttf", ".otf", ".woff", ".woff2")
FONT_MIME = {".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2"}
# Game data containers that can hold fonts stored uncompressed (Unity, Godot, Unreal, Ren'Py, Electron...)
CONTAINER_EXTS = {".assets", ".resource", ".bundle", ".unity3d", ".pck", ".pak", ".dat", ".bin",
                  ".data", ".arc", ".bytes", ".rpa", ".asar", ".ab", ".big", ".res", ".pkg"}
CONTAINER_NAME_RE = re.compile(r"^(globalgamemanagers|level\d+|resources\.assets|sharedassets\d+\.assets)$", re.I)
GENERIC_FONT_RE = re.compile(r"^(arial|liberation|roboto|noto|dejavu|open ?sans|lato|source ?(sans|code|serif|han)|"
                             r"segoe|helvetica|verdana|tahoma|consolas|courier|times|droid|ubuntu|cantarell|"
                             r"fira|pt ?sans|nimbus|free ?(sans|serif|mono)|msgothic|ms ?gothic|simsun|malgun|"
                             r"nanum|yu ?gothic|meiryo|wqy|inter|lucida)", re.I)
SFNT_SIG_RE = re.compile(rb"(?:\x00\x01\x00\x00|OTTO|true)\x00[\x05-\x30]")
NON_GAME_RE = re.compile(r"^(Proton|Steam Linux Runtime|Steamworks Common|SteamVR)", re.I)

# Steam's custom artwork file names, relative to userdata/<user>/config/grid
GRID_NAMES = {"cover": "{id}p", "wide": "{id}", "hero": "{id}_hero", "logo": "{id}_logo"}

_json_cache = {}
_json_cache_lock = threading.Lock()
_font_tokens = {}
_last_ping = time.time()


# ---------------------------------------------------------------- config ---

def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_FILE)


def api_key():
    return os.environ.get("SGDB_API_KEY") or load_config().get("api_key")


# ----------------------------------------------------------------- http ---

def fetch(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


def cached_json(url, headers=None, ttl=600):
    now = time.time()
    with _json_cache_lock:
        hit = _json_cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1], hit[2]
    status, _, body = fetch(url, headers)
    if status == 200:
        with _json_cache_lock:
            _json_cache[url] = (now, status, body)
    return status, body


# ---------------------------------------------------------------- steam ---

def parse_vdf(text):
    """Parse Valve's text KeyValues format into nested dicts."""
    tokens = re.findall(r'"((?:[^"\\]|\\.)*)"|([{}])', text)

    def parse(i):
        obj = {}
        while i < len(tokens):
            key, brace = tokens[i]
            if brace == "}":
                return obj, i + 1
            i += 1
            if i >= len(tokens):
                break
            val, vbrace = tokens[i]
            if vbrace == "{":
                val, i = parse(i + 1)
            else:
                val = val.replace("\\\\", "\\")
                i += 1
            obj[key] = val
        return obj, i

    return parse(0)[0]


def parse_binary_vdf(data):
    """Parse Valve's binary KeyValues (shortcuts.vdf)."""
    pos = 0

    def cstr():
        nonlocal pos
        end = data.index(b"\x00", pos)
        s = data[pos:end].decode("utf-8", "replace")
        pos = end + 1
        return s

    def parse_map():
        nonlocal pos
        obj = {}
        while pos < len(data):
            t = data[pos]
            pos += 1
            if t == 0x08:
                return obj
            key = cstr()
            if t == 0x00:
                obj[key] = parse_map()
            elif t == 0x01:
                obj[key] = cstr()
            elif t == 0x02:
                obj[key] = struct.unpack_from("<i", data, pos)[0]
                pos += 4
            elif t == 0x07:
                obj[key] = struct.unpack_from("<Q", data, pos)[0]
                pos += 8
            else:
                raise ValueError(f"unknown binary vdf type {t:#x}")
        return obj

    return parse_map()


def windows_steam_path():
    """Steam's install folder from the Windows registry (it can be on any drive)."""
    try:
        import winreg
    except ImportError:
        return None
    for hive, key, value in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
                             (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
                             (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath")):
        try:
            with winreg.OpenKey(hive, key) as k:
                return Path(winreg.QueryValueEx(k, value)[0])
        except OSError:
            continue
    return None


def steam_root():
    candidates = [windows_steam_path(),
        HOME / ".local/share/Steam",
        HOME / ".steam/steam",
        HOME / ".steam/root",
        HOME / ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        HOME / "Library/Application Support/Steam",
        Path("C:/Program Files (x86)/Steam"),
        Path("C:/Program Files/Steam"),
    ]
    for c in candidates:
        if c and (c / "userdata").is_dir():
            return c.resolve()
    return None


def library_folders(root):
    folders = [root]
    try:
        vdf = parse_vdf((root / "steamapps/libraryfolders.vdf").read_text(encoding="utf-8", errors="replace"))
        for entry in vdf.get("libraryfolders", {}).values():
            if isinstance(entry, dict) and entry.get("path"):
                p = Path(entry["path"])
                if p.resolve() not in [f.resolve() for f in folders if f.exists()]:
                    folders.append(p)
    except OSError:
        pass
    return [f for f in folders if (f / "steamapps").is_dir()]


def installed_games(root):
    games = {}
    for lib in library_folders(root):
        for acf in (lib / "steamapps").glob("appmanifest_*.acf"):
            try:
                st = parse_vdf(acf.read_text(encoding="utf-8", errors="replace")).get("AppState", {})
            except OSError:
                continue
            appid, name = st.get("appid"), st.get("name", "")
            if not appid or not appid.isdigit() or NON_GAME_RE.match(name) or appid == "228980":
                continue
            games[appid] = {"appid": appid, "name": name,
                            "installDir": str(lib / "steamapps/common" / st.get("installdir", ""))}
    return sorted(games.values(), key=lambda g: g["name"].lower())


def steam_users(root):
    names = {}
    try:
        vdf = parse_vdf((root / "config/loginusers.vdf").read_text(encoding="utf-8", errors="replace"))
        for sid64, info in vdf.get("users", {}).items():
            if sid64.isdigit():
                names[str(int(sid64) - 76561197960265728)] = (
                    info.get("PersonaName", ""), info.get("MostRecent") == "1")
    except OSError:
        pass
    users = []
    for d in (root / "userdata").iterdir():
        if not d.name.isdigit() or d.name == "0":
            continue
        name, recent = names.get(d.name, ("", False))
        if not name:
            try:
                m = re.search(r'"PersonaName"\s+"([^"]*)"',
                              (d / "config/localconfig.vdf").read_text(encoding="utf-8", errors="replace"))
                name = m.group(1) if m else ""
            except OSError:
                pass
        users.append({"id": d.name, "name": name or f"User {d.name}", "mostRecent": recent,
                      "shortcuts": read_shortcuts(d)})
    users.sort(key=lambda u: (not u["mostRecent"], u["name"].lower()))
    return users


def read_shortcuts(user_dir):
    try:
        data = parse_binary_vdf((user_dir / "config/shortcuts.vdf").read_bytes())
    except (OSError, ValueError, IndexError, struct.error):
        return []
    out = []
    for entry in data.get("shortcuts", {}).values():
        if not isinstance(entry, dict):
            continue
        e = {k.lower(): v for k, v in entry.items()}
        if "appid" not in e or not e.get("appname"):
            continue
        start = str(e.get("startdir", "")).strip('"')
        out.append({"id": str(e["appid"] & 0xFFFFFFFF), "name": e["appname"], "installDir": start})
    return sorted(out, key=lambda s: s["name"].lower())


def find_install_dir(appid=None, shortcut=None, user=None):
    root = steam_root()
    if not root:
        return None
    if appid:
        for g in installed_games(root):
            if g["appid"] == appid:
                return g["installDir"]
    if shortcut and user:
        for s in read_shortcuts(root / "userdata" / user):
            if s["id"] == shortcut:
                return s["installDir"]
    return None


# ---------------------------------------------------------------- fonts ---

def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def sfnt_length(buf, pos, limit):
    """Length of a valid TrueType/OpenType font starting at buf[pos], else 0."""
    try:
        n = struct.unpack_from(">H", buf, pos + 4)[0]
        sr, es, rs = struct.unpack_from(">HHH", buf, pos + 6)
        p2 = 1 << (n.bit_length() - 1)
        if sr != p2 * 16 or es != p2.bit_length() - 1 or rs != n * 16 - sr:
            return 0
        tables, end = {}, 0
        for i in range(n):
            tag, _, off, ln = struct.unpack_from(">4sIII", buf, pos + 12 + 16 * i)
            if not all(32 <= c < 127 for c in tag) or off < 12 + 16 * n or ln > 64 << 20 or pos + off + ln > limit:
                return 0
            tables[tag] = off
            end = max(end, off + ln)
        if b"cmap" not in tables or b"head" not in tables or not ({b"glyf", b"CFF ", b"CFF2"} & tables.keys()):
            return 0
        if struct.unpack_from(">I", buf, pos + tables[b"head"] + 12)[0] != 0x5F0F3CF5:
            return 0
        return end
    except struct.error:
        return 0


def _decode_names(table):
    fmt, count, soff = struct.unpack_from(">HHH", table, 0)
    names = {}
    for j in range(count):
        pid, eid, lid, nid, ln, off = struct.unpack_from(">HHHHHH", table, 6 + 12 * j)
        if nid not in (1, 4, 16):
            continue
        raw = table[soff + off: soff + off + ln]
        if pid in (0, 3):
            txt = raw.decode("utf-16-be", "replace")
        elif pid == 1 and lid == 0:
            txt = raw.decode("mac_roman", "replace")
        else:
            continue
        txt = txt.strip("\x00 ").strip()
        if txt and (nid not in names or (pid == 3 and lid == 0x409)):
            names[nid] = txt
    return names.get(16) or names.get(1), names.get(4) or names.get(16) or names.get(1)


def font_names(data):
    """(family, full name) from a TTF/OTF/WOFF file's name table."""
    try:
        if data[:4] == b"wOFF":
            n = struct.unpack_from(">H", data, 12)[0]
            for i in range(n):
                tag, off, clen, olen, _ = struct.unpack_from(">4sIIII", data, 44 + 20 * i)
                if tag == b"name":
                    t = data[off:off + clen]
                    return _decode_names(zlib.decompress(t) if clen < olen else t)
            return None, None
        n = struct.unpack_from(">H", data, 4)[0]
        for i in range(n):
            tag, _, off, ln = struct.unpack_from(">4sIII", data, 12 + 16 * i)
            if tag == b"name":
                return _decode_names(data[off:off + ln])
    except (struct.error, zlib.error, IndexError):
        pass
    return None, None


def carve_buffer(buf, deadline):
    """Complete font files found as plain byte runs inside buf."""
    out, size = [], len(buf)
    for i, m in enumerate(SFNT_SIG_RE.finditer(buf)):
        if i % 2000 == 0 and time.time() > deadline:
            break
        ln = sfnt_length(buf, m.start(), size)
        if ln:
            out.append(bytes(buf[m.start():m.start() + ln]))
    pos = buf.find(b"wOFF")
    while pos != -1 and time.time() < deadline:
        try:
            ln = struct.unpack_from(">I", buf, pos + 8)[0]
            n = struct.unpack_from(">H", buf, pos + 12)[0]
            if 44 < ln < 32 << 20 and 3 < n < 60 and pos + ln <= size:
                out.append(bytes(buf[pos:pos + ln]))
        except struct.error:
            pass
        pos = buf.find(b"wOFF", pos + 4)
    return out


def carve_fonts(path, deadline):
    """Pull complete font files out of a game data file (fonts in Unity assets,
    uncompressed Unreal .pak etc. are stored as plain byte runs)."""
    try:
        with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            return carve_buffer(mm, deadline)
    except (OSError, ValueError):
        return []


# ---- Godot: fonts live in .pck archives, usually as compressed resources.

def _zstd(data, size):
    try:
        from compression import zstd          # Python 3.14+
        return zstd.decompress(data)
    except ImportError:
        pass
    try:
        import zstandard                       # optional third-party module
        return zstandard.ZstdDecompressor().decompress(data, max_output_size=size)
    except ImportError:
        return None


def godot_decompress(buf):
    """Unpack Godot's compressed-file container ("RSCC"); other data passes through."""
    if buf[:4] != b"RSCC":
        return buf
    try:
        mode, block, total = struct.unpack_from("<III", buf, 4)
        count = (total + block - 1) // block if block else 0
        sizes = struct.unpack_from(f"<{count}I", buf, 16)
        pos, out = 16 + 4 * count, bytearray()
        for i, sz in enumerate(sizes):
            chunk, pos = buf[pos:pos + sz], pos + sz
            want = min(block, total - i * block)
            if mode == 2:                      # zstd
                d = _zstd(chunk, want)
            elif mode == 1:                    # deflate
                try:
                    d = zlib.decompress(chunk)
                except zlib.error:
                    d = zlib.decompress(chunk, -zlib.MAX_WBITS)
            elif mode == 3:                    # gzip
                d = zlib.decompress(chunk, 16 + zlib.MAX_WBITS)
            else:                              # FastLZ / Brotli: not supported
                return None
            if d is None:
                return None
            out += d
        return bytes(out)
    except (struct.error, zlib.error, ValueError):
        return None


def godot_pck_files(path, want):
    """Yield (res path, bytes) for files in a Godot .pck (standalone or embedded
    in the game executable) whose res path satisfies want()."""
    try:
        with open(path, "rb") as f:
            start = 0
            if f.read(4) != b"GDPC":
                f.seek(-12, 2)
                size, magic = struct.unpack("<Q4s", f.read(12))
                if magic != b"GDPC":
                    return
                f.seek(-12 - size, 2)
                start = f.tell()
                if f.read(4) != b"GDPC":
                    return
            version = struct.unpack("<4I", f.read(16))[0]
            flags = base = 0
            if version >= 2:
                flags, base = struct.unpack("<IQ", f.read(12))
            if flags & 1:                      # encrypted directory
                return
            if flags & 2:                      # file offsets relative to the pack
                base += start
            if version >= 3:
                dir_off = struct.unpack("<Q", f.read(8))[0]
                f.seek(start + dir_off)
            else:
                f.read(64)
            entries = []
            for _ in range(struct.unpack("<I", f.read(4))[0]):
                n = struct.unpack("<I", f.read(4))[0]
                res = f.read(n).rstrip(b"\0").decode("utf-8", "replace")
                off, size = struct.unpack("<QQ", f.read(16))
                f.read(16)
                eflags = struct.unpack("<I", f.read(4))[0] if version >= 2 else 0
                if not eflags & 1 and size < 64 << 20 and want(res):
                    entries.append((res, base + off, size))
            for res, off, size in entries:
                f.seek(off)
                yield res, f.read(size)
    except (OSError, struct.error, ValueError):
        return


def godot_font_res(res):
    low = res.lower()
    return low.endswith((".fontdata", ".ttf", ".otf", ".woff", ".woff2")) or ("font" in low and low.endswith((".res", ".tres")))


def is_embedded_pck(path):
    try:
        with open(path, "rb") as f:
            f.seek(-4, 2)
            return f.read(4) == b"GDPC"
    except OSError:
        return False


def scan_fonts(install_dir, limit=60, budget_s=30, budget_bytes=12 << 30):
    """Find the fonts a game uses: loose font files plus fonts embedded in its data files."""
    base = Path(install_dir) if install_dir else None
    if not base or not base.is_dir():
        return []
    loose, containers, visited = [], [], 0
    base_depth = len(base.parts)
    for dirpath, dirnames, filenames in os.walk(base):
        visited += len(filenames)
        if visited > 80000:
            break
        if len(Path(dirpath).parts) - base_depth >= 10:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d.lower() not in
                       {"_commonredist", "redist", "directx", "vcredist", "dotnet", "__installer", "mono", "monobleedingedge"}]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            ext = os.path.splitext(fn)[1].lower()
            if ext in FONT_EXTS:
                loose.append(full)
            elif ext in CONTAINER_EXTS or CONTAINER_NAME_RE.match(fn) or \
                    (ext in (".exe", ".x86_64", ".x86_32", ".arm64") and is_embedded_pck(full)):
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                if 1024 < st.st_size < 4 << 30:
                    containers.append((full, st.st_size, st.st_mtime))

    # Scans are cached until the game's files change.
    sig = hashlib.sha1(json.dumps([3, sorted(loose), sorted(containers)]).encode()).hexdigest()  # 3 = scanner version
    cache_file = FONT_CACHE_DIR / f"scan-{hashlib.sha1(str(base).encode()).hexdigest()[:16]}.json"
    cached = load_json(cache_file, {})
    if cached.get("sig") == sig and all(os.path.isfile(f["file_path"]) for f in cached.get("fonts", [])):
        found = cached["fonts"]
    else:
        found, seen = [], set()

        def add(data, file_path, origin, kind):
            digest = hashlib.sha1(data).hexdigest()
            if digest in seen:
                return
            seen.add(digest)
            family, full = font_names(data)
            if not family:
                family = re.sub(r"[-_ ]?(regular|bold|italic|light|medium|black|semibold|thin|sdf)$", "",
                                os.path.splitext(os.path.basename(file_path))[0], flags=re.I) if kind == "file" \
                    else f"Embedded font {len(found) + 1}"
            low = origin.lower()
            score = 0
            if re.search(r"engine[/\\]|slate|editor|proton|steamworks|debug|fallback", low):
                score += 10
            if "/exported/" in low or low.endswith((".res", ".tres")):
                score += 2                     # derived copy; prefer the original import
            if GENERIC_FONT_RE.match(family.replace(" ", "")) or GENERIC_FONT_RE.match(family):
                score += 6
            if re.search(r"title|logo|display|head|main|menu", (family + " " + origin).lower()):
                score -= 3
            found.append({"digest": digest, "file_path": file_path, "origin": origin, "kind": kind,
                          "family": family, "full": full or family, "score": score})

        for full in loose:
            try:
                add(Path(full).read_bytes(), full, os.path.relpath(full, base), "file")
            except OSError:
                pass
        deadline, scanned = time.time() + budget_s, 0
        # Likely font holders first: Unity resources/shared assets, then smaller files.
        containers.sort(key=lambda c: (0 if CONTAINER_NAME_RE.match(os.path.basename(c[0])) else 1, c[1]))
        FONT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        def keep(data, origin):
            ext = ".otf" if data[:4] == b"OTTO" else ".woff" if data[:4] == b"wOFF" else ".ttf"
            dest = FONT_CACHE_DIR / (hashlib.sha1(data).hexdigest() + ext)
            if not dest.exists():
                dest.write_bytes(data)
            add(data, str(dest), origin, "embedded")

        for path, size, _ in containers:
            if time.time() > deadline or scanned > budget_bytes:
                break
            scanned += size
            rel = os.path.relpath(path, base)
            godot = 0
            if path.lower().endswith(".pck") or is_embedded_pck(path):
                for res, blob in godot_pck_files(path, godot_font_res):
                    godot += 1
                    data = godot_decompress(blob)
                    if data:
                        # "res://.godot/imported/Font-Bold.otf-<hash>.fontdata" → "Font-Bold.otf"
                        name = re.sub(r"-[0-9a-f]{32}\.fontdata$", "", res.rsplit("/", 1)[-1])
                        for font in carve_buffer(data, deadline):
                            keep(font, f"{rel} › {name}" + (" (exported)" if "/exported/" in res else ""))
            if not godot:
                for font in carve_fonts(path, deadline):
                    keep(font, rel)
        save_json(cache_file, {"sig": sig, "fonts": found})

    out = []
    for f in sorted(found, key=lambda f: (f["score"], f["family"].lower())):
        token = f["digest"][:20]
        _font_tokens[token] = f["file_path"]
        try:
            fsize = os.path.getsize(f["file_path"])
        except OSError:
            fsize = 0
        out.append({"token": token, "family": f["family"], "full": f["full"], "kind": f["kind"], "size": fsize,
                    "path": f["origin"], "generic": f["score"] >= 6, "file": os.path.basename(f["file_path"])})
    return out[:limit]


def user_fonts():
    index = load_json(USER_FONT_DIR / "index.json", {})
    out = []
    for digest, meta in index.items():
        p = USER_FONT_DIR / meta.get("file", "")
        if p.is_file():
            token = "u" + digest[:19]
            _font_tokens[token] = str(p)
            out.append({"token": token, "family": meta.get("family"), "name": meta.get("name")})
    return out


def repair_font(data):
    """Fix header versions that browsers' font checker (OTS) rejects outright, e.g. PF Tempesta
    Seven's vhea 0x10001, which would otherwise fail to load with a "network error"."""
    if data[:4] not in (b"\x00\x01\x00\x00", b"true", b"OTTO"):
        return data
    try:
        out = None
        for i in range(struct.unpack_from(">H", data, 4)[0]):
            rec = 12 + 16 * i
            tag, _, off, ln = struct.unpack_from(">4sIII", data, rec)
            if tag in (b"hhea", b"vhea") and ln >= 4 and struct.unpack_from(">I", data, off)[0] not in (0x10000, 0x11000):
                out = out or bytearray(data)
                struct.pack_into(">I", out, off, 0x10000)
                t = bytes(out[off:off + ln]) + b"\0" * (-ln % 4)
                struct.pack_into(">I", out, rec + 4, sum(struct.unpack(f">{len(t) // 4}I", t)) & 0xFFFFFFFF)
        return bytes(out) if out else data
    except struct.error:
        return data


def save_user_font(name, data):
    ext = {b"OTTO": ".otf", b"wOFF": ".woff", b"wOF2": ".woff2"}.get(data[:4], ".ttf")
    if ext == ".ttf" and data[:4] not in (b"\x00\x01\x00\x00", b"true"):
        raise ValueError("That isn't a TTF, OTF or WOFF font file")
    digest = hashlib.sha1(data).hexdigest()
    USER_FONT_DIR.mkdir(parents=True, exist_ok=True)
    (USER_FONT_DIR / (digest + ext)).write_bytes(data)
    family, _ = font_names(data)
    index = load_json(USER_FONT_DIR / "index.json", {})
    index[digest] = {"file": digest + ext, "name": str(name)[:120],
                     "family": family or re.sub(r"\.[^.]+$", "", str(name))[:120]}
    save_json(USER_FONT_DIR / "index.json", index)
    token = "u" + digest[:19]
    _font_tokens[token] = str(USER_FONT_DIR / (digest + ext))
    return {"token": token, "family": index[digest]["family"], "name": index[digest]["name"]}


def game_font_info(key, name):
    norm = "name:" + re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()
    saved = load_json(GAME_FONTS_FILE, {})
    known = load_json(KNOWN_FONTS_FILE, {})
    return {"saved": saved.get(key) or saved.get(norm), "known": known.get(key) or known.get(norm)}


def save_game_font(key, name, choice):
    if not re.fullmatch(r"(steam|shortcut|sgdb):\d+|name:[a-z0-9 ]{1,120}", key or ""):
        raise ValueError("Bad game key")
    if choice is not None and (not isinstance(choice, dict) or len(json.dumps(choice)) > 4000):
        raise ValueError("Bad font choice")
    saved = load_json(GAME_FONTS_FILE, {})
    norm = "name:" + re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()
    for k in {key, norm} - {"name:"}:
        if choice is None:
            saved.pop(k, None)
        else:
            saved[k] = choice
    save_json(GAME_FONTS_FILE, saved)


def librarycache_assets(appid):
    root = steam_root()
    if not root:
        return []
    cache = root / "appcache/librarycache"
    out = []
    candidates = []
    d = cache / appid
    if d.is_dir():
        for p in d.rglob("*"):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS and len(p.relative_to(d).parts) <= 2:
                candidates.append((p, p.relative_to(d).as_posix()))
    for p in cache.glob(f"{appid}_*"):
        if p.suffix.lower() in IMAGE_EXTS:
            candidates.append((p, p.name))
    for p, rel in candidates:
        name = p.stem.lower().replace(f"{appid}_", "")
        if "blur" in name:
            continue
        if "library_hero" in name:
            kind = "hero"
        elif name == "logo":
            kind = "logo"
        elif "600x900" in name:
            kind = "cover"
        elif "header" in name:
            kind = "header"
        else:
            kind = "art"
        out.append({"kind": kind, "url": f"/api/local/{appid}/{rel}", "label": f"Steam {kind}"})
    order = {"hero": 0, "logo": 1, "cover": 2, "header": 3, "art": 4}
    out.sort(key=lambda a: order[a["kind"]])
    return out


def resolve_local(appid, rel):
    root = steam_root()
    if not root or not re.fullmatch(r"(?:[0-9a-f]{40}/)?[\w.-]+", rel):
        return None
    cache = (root / "appcache/librarycache").resolve()
    for p in (cache / appid / rel, cache / rel):
        try:
            rp = p.resolve()
        except OSError:
            continue
        if rp.is_file() and cache in rp.parents and rp.suffix.lower() in IMAGE_EXTS:
            return rp
    return None


def strip_html(s):
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    s = re.sub(r"</(li|p|ul|h\d)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\n{2,}", "\n", html.unescape(s)).strip()


BULLET_RE = re.compile(r"^\s*([•\-*・►▶✓✔▪◆◇➤→–—]|\d{1,2}[.)])\s+")


def html_blocks(h):
    """The store description as ordered blocks: headings, paragraphs and list items.
    Handles tag-structured pages and older ones laid out with <br> line breaks."""
    h = re.sub(r"<(img|source)[^>]*>|<video.*?</video>|<iframe.*?</iframe>", " ", h or "", flags=re.S | re.I)
    h = re.sub(r"<h[1-6][^>]*>(.*?)</h[1-6]>", lambda m: "\n\x01" + m.group(1).replace("\n", " ") + "\n", h, flags=re.S | re.I)
    # List items stay one line even when their text is wrapped in <p> or broken with <br>.
    h = re.sub(r"<li[^>]*>(.*?)</li>", lambda m: "\n\x02" + re.sub(r"</?p\b[^>]*>|<br\s*/?>", " ", m.group(1)) + "\n",
               h, flags=re.S | re.I)
    h = re.sub(r"<li[^>]*>", "\n\x02", h, flags=re.I)
    h = re.sub(r"<br\s*/?>|</?(p|div|ul|ol|li|span class=\"bb_img_ctn\")\b[^>]*>", "\n", h, flags=re.I)
    blocks = []
    for raw in h.split("\n"):
        kind = "p"
        if raw.startswith("\x01"):
            kind, raw = "h", raw[1:]
        elif raw.startswith("\x02"):
            kind, raw = "li", raw[1:]
        # Unescape twice: some store pages double-encode entities (&amp;quot;).
        text = re.sub(r"\s+", " ", html.unescape(html.unescape(re.sub(r"<[^>]+>", "", raw)))).strip()
        if not text:
            continue
        if kind == "p":
            bold_only = re.fullmatch(r"\s*<(strong|b|u)>(.*?)</\1>\s*:?\s*", raw, re.S | re.I)
            lead = re.match(r"\s*<(strong|b)>([^<]{3,60})</\1>\s*([:\-–—]\s*)?(.+)", raw, re.S | re.I)
            if BULLET_RE.match(text):
                kind, text = "li", BULLET_RE.sub("", text)
            elif bold_only and len(text) < 90:
                kind = "h"
            elif len(text) <= 60 and text == text.upper() and re.search(r"[A-Z]{3}", text) and not text.endswith("."):
                kind = "h"
            elif lead and len(text) < 240:
                rest = re.sub(r"\s+", " ", html.unescape(html.unescape(re.sub(r"<[^>]+>", "", lead.group(4))))).strip()
                label = html.unescape(html.unescape(lead.group(2))).strip().rstrip(":")
                if lead.group(3) or rest[:1].isupper():   # "<b>Label</b> — Detail" reads as a feature line
                    kind, text = "li", f"{label}: {rest}"
        blocks.append({"type": kind, "text": text[:1500]})
    return blocks[:150]


def _head_ok(url):
    key = "HEAD " + url
    with _json_cache_lock:
        if key in _json_cache:
            return _json_cache[key][1] == 200
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA}), timeout=6) as r:
            status = r.status
    except (urllib.error.URLError, OSError):
        status = 0
    with _json_cache_lock:
        _json_cache[key] = (time.time(), status, b"")
    return status == 200


def hires_art(appid):
    """Steam's 2x library art (sharper for print) from its CDN, where it exists."""
    from concurrent.futures import ThreadPoolExecutor
    base = f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/"
    dirs = [""]
    root = steam_root()
    if root:
        d = root / "appcache/librarycache" / appid
        if d.is_dir():
            dirs += [p.name + "/" for p in d.iterdir() if p.is_dir() and re.fullmatch(r"[0-9a-f]{40}", p.name)]
    wanted = [("hero", "library_hero_2x.jpg"), ("cover", "library_600x900_2x.jpg"), ("logo", "logo_2x.png")]
    urls = [(kind, base + d + name) for kind, name in wanted for d in dirs]
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(lambda ku: _head_ok(ku[1]), urls))
    out, seen = [], set()
    for (kind, url), good in zip(urls, ok):
        if good and kind not in seen:
            seen.add(kind)
            out.append({"kind": kind, "url": url, "label": f"Steam {kind} (hi-res)", "hires": True})
    return out


def store_info(appid):
    status, body = cached_json(
        f"https://store.steampowered.com/api/appdetails?appids={appid}&l=english&cc=US", ttl=3600)
    details = None
    if status == 200:
        try:
            payload = json.loads(body)
            # Keyed by the requested id — or sometimes by an edition's id.
            entry = payload.get(appid) or next(iter(payload.values()), {})
            if entry.get("success"):
                details = entry["data"]
        except (ValueError, StopIteration, AttributeError):
            details = None

    tags = []
    try:
        status, _, page = fetch(f"https://store.steampowered.com/app/{appid}/?l=english",
                                {"Cookie": STEAM_AGE_COOKIE}, timeout=15)
        m = re.search(r"InitAppTagModal\(\s*\d+,\s*(\[.*?\])\s*,", page.decode("utf-8", "replace"), re.S)
        if m:
            tags = [t["name"].strip() for t in json.loads(m.group(1))][:20]
    except (OSError, ValueError, KeyError):
        pass

    if not details:
        return {"details": None, "tags": tags, "official": []}

    reqs = details.get("pc_requirements") or {}
    if isinstance(reqs, list):
        reqs = {}
    official = []
    for key in ("background_raw", "header_image"):
        if details.get(key):
            official.append({"kind": "header" if key == "header_image" else "background",
                             "url": details[key], "label": key.replace("_", " ")})
    for s in details.get("screenshots", [])[:24]:
        official.append({"kind": "screenshot", "url": s["path_full"], "thumb": s["path_thumbnail"],
                         "label": "Screenshot"})
    about_html = details.get("about_the_game", "") or ""
    features = [strip_html(li) for li in re.findall(r"<li[^>]*>(.*?)</li>", about_html, re.S | re.I)]
    features = [f for f in features if 3 < len(f) <= 140][:10]
    about_html = re.sub(r"<ul.*?</ul>|<h\d.*?</h\d>|<img[^>]*>", "\n", about_html, flags=re.S | re.I)
    info = {
        "name": details.get("name"),
        "features": features,
        "blocks": html_blocks(details.get("about_the_game", "")),
        "extraBlocks": html_blocks(details.get("detailed_description", ""))
        if details.get("detailed_description") != details.get("about_the_game") else [],
        "shortDescription": html.unescape(details.get("short_description", "")),
        "about": strip_html(about_html)[:4000],
        "developers": details.get("developers", []),
        "publishers": details.get("publishers", []),
        "releaseDate": (details.get("release_date") or {}).get("date", ""),
        "genres": [g["description"] for g in details.get("genres", [])],
        "categories": [c["description"] for c in details.get("categories", [])],
        "controllerSupport": details.get("controller_support"),
        "requirements": strip_html(reqs.get("minimum", "")),
        "recommended": strip_html(reqs.get("recommended", "")),
        "website": details.get("website"),
        "requiredAge": details.get("required_age"),
    }
    return {"details": info, "tags": tags, "official": official}


# ------------------------------------------------------------ AI spine ---
# Gemini's image model continues the front artwork round the fold onto the spine.
# Results are cached, so the same request is only paid for once.

GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_IMAGE_MODEL = "gemini-3-pro-image"
DVDCOVERMAKER_CONFIG = HOME / ".config/dvdcovermaker/config.json"
AI_SPINE_DIR = CACHE_DIR / "ai-spines"


def gemini_settings():
    """Gemini key and image model: env, this app's config, or DVD Cover Maker's config."""
    ours, theirs = load_config(), load_json(DVDCOVERMAKER_CONFIG, {})
    key = os.environ.get("GEMINI_API_KEY") or ours.get("gemini_api_key") or theirs.get("gemini_api_key")
    model = ours.get("gemini_image_model") or theirs.get("gemini_image_model") or DEFAULT_IMAGE_MODEL
    return key, model


def gemini_source():
    """Where the Gemini key comes from: "env", "file" (this app), "dvdcovermaker" or None."""
    if os.environ.get("GEMINI_API_KEY"):
        return "env"
    if load_config().get("gemini_api_key"):
        return "file"
    return "dvdcovermaker" if load_json(DVDCOVERMAKER_CONFIG, {}).get("gemini_api_key") else None


def key_status():
    """Which keys are set and where from — never the keys themselves."""
    sgdb_src = "env" if os.environ.get("SGDB_API_KEY") else ("file" if load_config().get("api_key") else None)
    return {"hasKey": bool(api_key()), "keySource": sgdb_src,
            "hasGemini": bool(gemini_settings()[0]), "geminiSource": gemini_source(), "configFile": str(CONFIG_FILE)}


def check_gemini_key(key):
    req = urllib.request.Request(f"{GEMINI_API}?pageSize=1", headers={"x-goog-api-key": key, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def update_keys(body):
    """Save and/or remove the SteamGridDB and Gemini keys, testing each new key first."""
    cfg = load_config()
    sgdb = str(body.get("apiKey") or "").strip()
    gemini = str(body.get("geminiKey") or "").strip()
    clear = body.get("clear") or []
    if sgdb:
        if not re.fullmatch(r"[A-Za-z0-9]{16,64}", sgdb):
            raise ValueError("That doesn't look like a SteamGridDB API key.")
        try:
            status, _, _ = fetch(SGDB_BASE + "search/autocomplete/portal", {"Authorization": f"Bearer {sgdb}"})
        except OSError:
            raise ValueError("Couldn't reach SteamGridDB to check the key — are you online?")
        if status == 401:
            raise ValueError("SteamGridDB rejected that key.")
        cfg["api_key"] = sgdb
    elif "sgdb" in clear:
        cfg.pop("api_key", None)
    if gemini:
        if not re.fullmatch(r"[\w.-]{20,200}", gemini):
            raise ValueError("That doesn't look like a Gemini API key.")
        try:
            status = check_gemini_key(gemini)
        except OSError:
            raise ValueError("Couldn't reach Google to check the Gemini key — are you online?")
        if status in (400, 401):   # 403 can just mean a key without access to the model list
            raise ValueError("Google rejected that Gemini key.")
        cfg["gemini_api_key"] = gemini
    elif "gemini" in clear:
        cfg.pop("gemini_api_key", None)
    save_config(cfg)
    return key_status()


def continue_spine(image_b64, aspect, force=False, extra=""):
    """Gemini extends the front artwork into the grey strip on its left: the spine, as the same
    printed artwork wrapping round the fold of a real retail case."""
    key, model = gemini_settings()
    if not key:
        raise ValueError("The AI spine needs a Gemini API key — add one in Settings.")
    if aspect not in ("9:16", "2:3", "3:4", "4:5", "1:1", "5:4", "4:3", "3:2", "16:9"):
        raise ValueError("Unsupported aspect ratio")
    prompt = (
        "This is the front cover artwork of a video game box, on a canvas whose LEFT strip is flat grey. "
        "Return this same image with ONLY the grey strip filled: a seamless continuation of the artwork's LEFT "
        "EDGE, exactly as if the picture were a little wider. Carry on the scenery, background, colours, lighting, "
        "grain and texture found right at that edge, and continue only shapes that actually cross the edge, so "
        "the join is invisible and it looks like one continuous piece of official artwork. Keep everything that is "
        "already there pixel for pixel: same framing, same size, same position. Do not draw a box, case, frame, "
        "mock-up or photograph of an object. No new objects or figures, no text, letters, logos or borders."
        + str(extra)[:300])
    body = json.dumps({
        "contents": [{"role": "user", "parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
            {"text": prompt}]}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect, "imageSize": "2K"}},
    }).encode()
    digest = hashlib.sha1(body + model.encode()).hexdigest()[:24]
    AI_SPINE_DIR.mkdir(parents=True, exist_ok=True)
    variants = sorted(AI_SPINE_DIR.glob(f"{digest}-*.png"))
    if variants and not force:
        return {"url": f"/api/ai-spine/{variants[-1].name}", "cached": True, "model": model}
    status, raw = 0, b""
    for attempt in range(3):
        req = urllib.request.Request(f"{GEMINI_API}/{model}:generateContent", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "x-goog-api-key": key, "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            if attempt < 2:
                continue
            raise ValueError(f"Gemini didn't answer ({type(e).__name__}). Try again in a moment.")
        if status in (500, 502, 503, 504) and attempt < 2:
            continue
        break
    text = raw.decode("utf-8", "replace")
    if status == 402 or "credits" in text.lower():
        raise ValueError("Gemini refused: your AI Studio prepaid credits are used up.")
    if status == 429:
        try:
            err = json.loads(text).get("error", {})
        except ValueError:
            err = {}
        msg = err.get("message") or ""
        wait = next((d.get("retryDelay") for d in err.get("details", []) if d.get("retryDelay")), None)
        if "spending cap" in msg.lower() or "spend cap" in msg.lower():
            raise ValueError("Gemini refused: your Google AI Studio project has reached its monthly spending cap. "
                             "Raise the cap at https://ai.studio/spend, or wait for it to reset next month.")
        if "per day" in msg.lower() or "PerDay" in json.dumps(err):
            raise ValueError("Gemini refused: this key's daily limit for the image model is used up. Try again tomorrow.")
        raise ValueError("Gemini is rate-limiting this key" + (f" — try again in {wait}." if wait else ", try again in a minute.")
                         + (f" ({msg[:160]})" if msg else ""))
    if status != 200:
        try:
            msg = json.loads(text)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            msg = text[:200]
        raise ValueError(f"Gemini returned {status}: {msg}")
    parts = ((json.loads(text).get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    blob = next((p.get("inline_data") or p.get("inlineData") for p in parts if p.get("inline_data") or p.get("inlineData")), None)
    if not blob:
        raise ValueError("Gemini didn't return an image this time. Try again.")
    name = f"{digest}-{int(time.time())}.png"
    (AI_SPINE_DIR / name).write_bytes(base64.b64decode(blob["data"]))
    return {"url": f"/api/ai-spine/{name}", "cached": False, "model": model}


# ------------------------------------------------------------- upscayl ---

_upscayl = None
UPSCAYL_DIR = CACHE_DIR / "upscale"


def _host_prefix():
    # Inside a Flatpak sandbox (e.g. an IDE), run host programs via flatpak-spawn.
    return ["flatpak-spawn", "--host"] if os.path.exists("/.flatpak-info") else []


def upscayl_engine():
    """Find Upscayl: its Flatpak, or a standalone upscayl-bin with a models folder."""
    global _upscayl
    if _upscayl is not None:
        return _upscayl
    prefix = _host_prefix()
    try:
        loc = subprocess.run(prefix + ["flatpak", "info", "--show-location", "org.upscayl.Upscayl"],
                             capture_output=True, text=True, timeout=15)
        if loc.returncode == 0 and loc.stdout.strip():
            models_dir = loc.stdout.strip() + "/files/upscayl/resources/models"
            ls = subprocess.run(prefix + ["ls", models_dir], capture_output=True, text=True, timeout=15)
            models = sorted(f[:-6] for f in ls.stdout.split() if f.endswith(".param"))
            if models:
                _upscayl = {"kind": "flatpak", "models": models, "modelsArg": "/app/upscayl/resources/models",
                            "cmd": prefix + ["flatpak", "run", "--filesystem={work}",
                                             "--command=/app/upscayl/resources/bin/upscayl-bin", "org.upscayl.Upscayl"]}
                return _upscayl
    except (OSError, subprocess.SubprocessError):
        pass
    candidates = [os.environ.get("UPSCAYL_BIN"), shutil.which("upscayl-bin"),
                  HOME / "DVDCoverMaker/tools/upscayl/upscayl-bin", HOME / ".local/bin/upscayl-bin",
                  "/opt/Upscayl/resources/bin/upscayl-bin", "/usr/lib/upscayl/resources/bin/upscayl-bin"]
    if IS_WINDOWS:
        for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
            if base:
                candidates += [Path(base) / "Programs/Upscayl/resources/bin/upscayl-bin.exe",
                               Path(base) / "Upscayl/resources/bin/upscayl-bin.exe"]
    for c in candidates:
        if not c or not Path(c).is_file():
            continue
        b = Path(c)
        for md in (b.parent / "models", b.parent.parent / "models"):
            models = sorted(p.stem for p in md.glob("*.param"))
            if models:
                _upscayl = {"kind": "standalone", "models": models, "modelsArg": str(md), "cmd": prefix + [str(b)]}
                return _upscayl
    _upscayl = {}
    return _upscayl


UPSCAYL_SRC_DIR = CACHE_DIR / "upscaled-art"


def _run_upscayl(png, model, scale):
    """Run Upscayl on a PNG; returns the output path (in a job folder cleared after an hour)."""
    eng = upscayl_engine()
    if not eng:
        raise ValueError("Upscayl isn't installed")
    if model not in eng["models"]:
        raise ValueError(f"Unknown Upscayl model: {model}")
    if scale not in (2, 3, 4):
        raise ValueError("Scale must be 2, 3 or 4")
    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Expected a PNG")
    UPSCAYL_DIR.mkdir(parents=True, exist_ok=True)
    for old in UPSCAYL_DIR.iterdir():          # tidy up results older than an hour
        if old.is_dir() and re.fullmatch(r"[0-9a-f]{12}", old.name) and time.time() - old.stat().st_mtime > 3600:
            shutil.rmtree(old, ignore_errors=True)
    job = hashlib.sha1(os.urandom(16)).hexdigest()[:12]
    work = UPSCAYL_DIR / job
    work.mkdir()
    (work / "in.png").write_bytes(png)
    cmd = [part.replace("{work}", str(work)) for part in eng["cmd"]] + [
        "-i", str(work / "in.png"), "-o", str(work / "out.png"), "-m", eng["modelsArg"],
        "-n", model, "-s", str(scale), "-f", "png"]
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=1200)
    out = work / "out.png"
    if not out.is_file() or not image_complete(out.read_bytes()):   # it can exit leaving an empty file
        tail = (run.stderr or run.stdout or "").strip().splitlines()[-3:]
        shutil.rmtree(work, ignore_errors=True)
        raise ValueError("Upscayl failed: " + (" / ".join(tail) or "it produced no image"))
    return out


def upscale_image(png, model, scale):
    """Upscale a finished render (one-off; served from the job folder)."""
    out = _run_upscayl(png, model, scale)
    w, h = struct.unpack(">II", out.read_bytes()[16:24])
    return {"url": f"/api/upscaled/{out.parent.name}.png", "width": w, "height": h}


def upscale_source(png, model, scale):
    """Upscale a piece of source art; cached for good, so each image is only done once."""
    digest = hashlib.sha1(png + f"|{model}|{scale}".encode()).hexdigest()[:24]
    dest = UPSCAYL_SRC_DIR / f"{digest}.png"
    if not dest.is_file() or not image_complete(dest.read_bytes()):   # redo a broken earlier result
        out = _run_upscayl(png, model, scale)
        UPSCAYL_SRC_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(out), dest)
        shutil.rmtree(out.parent, ignore_errors=True)
    w, h = struct.unpack(">II", dest.read_bytes()[16:24])
    return {"url": f"/api/upscaled-art/{digest}.png", "width": w, "height": h}


RENDERS_DIR = HOME / "Pictures" / "Cover Studio"


def save_renders(game, files):
    """Save the 3D renders to ~/Pictures/Cover Studio/<game>/."""
    folder = re.sub(r"[^\w .()&'-]+", "", str(game or "Untitled")).strip()[:80] or "Untitled"
    dest = RENDERS_DIR / folder
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        name = str(f.get("name", ""))
        if not re.fullmatch(r"[\w.-]{1,80}\.png", name):
            raise ValueError(f"Bad file name: {name}")
        png = base64.b64decode(f.get("data", ""), validate=True)
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Renders must be PNG")
        tmp = dest / (name + ".tmp")
        tmp.write_bytes(png)
        os.replace(tmp, dest / name)
        saved.append(name)
    return {"folder": str(dest), "saved": saved}


def write_grid_files(user_id, target_id, files):
    root = steam_root()
    if not root:
        raise ValueError("Steam installation not found")
    if not re.fullmatch(r"\d{1,12}", str(target_id)):
        raise ValueError("Invalid Steam app / shortcut id")
    user_dir = root / "userdata" / str(user_id)
    if not re.fullmatch(r"\d+", str(user_id)) or not user_dir.is_dir():
        raise ValueError("Unknown Steam user")
    grid = user_dir / "config/grid"
    grid.mkdir(parents=True, exist_ok=True)
    backup = grid / "_cover_studio_backup"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    written, backed_up = [], []
    for f in files:
        kind = f.get("kind")
        if kind not in GRID_NAMES:
            raise ValueError(f"Unknown artwork kind: {kind}")
        png = base64.b64decode(f.get("data", ""), validate=True)
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Artwork must be PNG")
        stem = GRID_NAMES[kind].format(id=target_id)
        for ext in IMAGE_EXTS:
            old = grid / (stem + ext)
            if old.exists():
                backup.mkdir(exist_ok=True)
                os.replace(old, backup / f"{stem}.{stamp}{ext}")
                backed_up.append(old.name)
        dest = grid / (stem + ".png")
        tmp = grid / (stem + ".png.tmp")
        tmp.write_bytes(png)
        os.replace(tmp, dest)
        written.append(dest.name)
    return {"written": written, "backedUp": backed_up, "gridDir": str(grid)}


# -------------------------------------------------------------- handler ---

class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets a second copy bind a port that's already in use (so it never
    # moves on to a free one); there, ask for the port exclusively instead.
    allow_reuse_address = not IS_WINDOWS

    def server_bind(self):
        if IS_WINDOWS and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = "CoverStudio/1.0"

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # --- helpers
    def send(self, status, body, ctype="application/json", cache=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if cache:
            self.send_header("Cache-Control", f"max-age={cache}")
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def err(self, status, msg):
        self.send(status, {"success": False, "errors": [msg]})

    def host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("127.0.0.1", "localhost")

    def read_json(self):
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise ValueError("Expected JSON")
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("Cross-origin request refused")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 80 * 1024 * 1024:
            raise ValueError("Request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    # --- routes
    def do_GET(self):
        global _last_ping
        if not self.host_ok():
            return self.err(403, "Bad host")
        url = urllib.parse.urlsplit(self.path)
        path, qs = url.path, urllib.parse.parse_qs(url.query)
        try:
            if path in ("/", "/index.html"):
                return self.static("index.html")
            if path.startswith("/static/"):
                return self.static(path[len("/static/"):])
            if path == "/api/ping":
                _last_ping = time.time()
                return self.send(200, {"ok": True})
            if path == "/api/config":
                return self.send(200, key_status())
            if path == "/api/library":
                root = steam_root()
                if not root:
                    return self.send(200, {"steamRoot": None, "games": [], "users": []})
                return self.send(200, {"steamRoot": str(root), "games": installed_games(root),
                                       "users": steam_users(root)})
            if path.startswith("/api/sgdb/"):
                return self.sgdb(self.path[len("/api/sgdb/"):])
            if path == "/api/img":
                return self.image(qs.get("u", [""])[0])
            if path.startswith("/api/local/"):
                parts = path[len("/api/local/"):].split("/", 1)
                if len(parts) == 2 and parts[0].isdigit():
                    p = resolve_local(parts[0], urllib.parse.unquote(parts[1]))
                    if p:
                        return self.send(200, p.read_bytes(), sniff_image(p.read_bytes()[:16]), 3600)
                return self.err(404, "Not found")
            if path.startswith("/api/store/"):
                appid = path[len("/api/store/"):]
                if not appid.isdigit():
                    return self.err(400, "Bad app id")
                info = store_info(appid)
                info["official"] = hires_art(appid) + librarycache_assets(appid) + info["official"]
                return self.send(200, info)
            if path == "/api/storesearch":
                term = qs.get("term", [""])[0][:100]
                status, body = cached_json("https://store.steampowered.com/api/storesearch/?" +
                                           urllib.parse.urlencode({"term": term, "l": "english", "cc": "US"}))
                return self.send(status, body)
            if path == "/api/fonts":
                d = find_install_dir(qs.get("appid", [None])[0], qs.get("shortcut", [None])[0],
                                     qs.get("user", [None])[0])
                return self.send(200, {"installDir": d, "fonts": scan_fonts(d)})
            if path == "/api/gamefonts":
                return self.send(200, game_font_info(qs.get("key", [""])[0], qs.get("name", [""])[0]))
            if path == "/api/upscayl":
                eng = upscayl_engine()
                models = eng.get("models", [])
                default = next((m for m in ("high-fidelity-4x", "upscayl-standard-4x") if m in models), models[0] if models else None)
                return self.send(200, {"available": bool(eng), "engine": eng.get("kind"), "models": models, "default": default})
            m = re.fullmatch(r"/api/upscaled-art/([0-9a-f]{24})\.png", path)
            if m:
                f = UPSCAYL_SRC_DIR / f"{m.group(1)}.png"
                if not f.is_file():
                    return self.err(404, "Not found")
                return self.send(200, f.read_bytes(), "image/png", 86400)
            m = re.fullmatch(r"/api/upscaled/([0-9a-f]{12})\.png", path)
            if m:
                f = UPSCAYL_DIR / m.group(1) / "out.png"
                if not f.is_file():
                    return self.err(404, "Not found")
                return self.send(200, f.read_bytes(), "image/png")
            m = re.fullmatch(r"/api/ai-spine/([0-9a-f]{24}-\d+\.png)", path)
            if m:
                f = AI_SPINE_DIR / m.group(1)
                if not f.is_file():
                    return self.err(404, "Not found")
                return self.send(200, f.read_bytes(), sniff_image(f.read_bytes()[:16]), 86400)
            if path == "/api/userfonts":
                return self.send(200, {"fonts": user_fonts()})
            if path.startswith("/api/fontfile/"):
                full = _font_tokens.get(path[len("/api/fontfile/"):])
                if not full or not os.path.isfile(full):
                    return self.err(404, "Font not found")
                ext = os.path.splitext(full)[1].lower()
                return self.send(200, repair_font(Path(full).read_bytes()), FONT_MIME.get(ext, "font/ttf"), 3600)
            return self.err(404, "Not found")
        except (OSError, urllib.error.URLError) as e:
            return self.err(502, f"Network or file error: {e}")

    def do_POST(self):
        if not self.host_ok():
            return self.err(403, "Bad host")
        try:
            body = self.read_json()
        except ValueError as e:
            return self.err(400, str(e))
        try:
            if self.path == "/api/config":
                return self.send(200, update_keys(body))
            if self.path == "/api/spine/continue":
                return self.send(200, continue_spine(str(body.get("image", "")), str(body.get("aspect", "4:5")),
                                                     bool(body.get("force")), body.get("extra", "")))
            if self.path == "/api/upscale-art":
                png = base64.b64decode(body.get("data", ""), validate=True)
                return self.send(200, upscale_source(png, str(body.get("model", "")), int(body.get("scale", 2))))
            if self.path == "/api/upscale":
                png = base64.b64decode(body.get("data", ""), validate=True)
                return self.send(200, upscale_image(png, str(body.get("model", "")), int(body.get("scale", 2))))
            if self.path == "/api/gamefonts":
                save_game_font(body.get("key"), body.get("name"), body.get("choice"))
                return self.send(200, {"ok": True})
            if self.path == "/api/userfont":
                data = base64.b64decode(body.get("data", ""), validate=True)
                if len(data) > 40 << 20:
                    return self.err(400, "Font file too large")
                return self.send(200, save_user_font(body.get("name", "font"), data))
            if self.path == "/api/save-renders":
                files = body.get("files") or []
                if not isinstance(files, list) or not files:
                    return self.err(400, "No files")
                return self.send(200, save_renders(body.get("game"), files))
            if self.path == "/api/apply":
                files = body.get("files") or []
                if not isinstance(files, list) or not files:
                    return self.err(400, "No files")
                return self.send(200, write_grid_files(body.get("userId"), body.get("targetId"), files))
            return self.err(404, "Not found")
        except (ValueError, base64.binascii.Error) as e:
            return self.err(400, str(e))
        except OSError as e:
            return self.err(500, f"Could not write files: {e}")

    # --- implementations
    def static(self, name):
        p = (STATIC_DIR / name).resolve()
        if STATIC_DIR not in p.parents or not p.is_file():
            return self.err(404, "Not found")
        ctype = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png"}.get(p.suffix,
                                                                                       "application/octet-stream")
        return self.send(200, p.read_bytes(), ctype)

    def sgdb(self, rest):
        if not SGDB_PATH_RE.match(rest):
            return self.err(400, "Unsupported SteamGridDB request")
        key = api_key()
        if not key:
            return self.err(401, "No SteamGridDB API key set")
        status, body = cached_json(SGDB_BASE + rest, {"Authorization": f"Bearer {key}"})
        if not body:
            body = json.dumps({"success": False, "errors": [f"SteamGridDB returned {status}"]}).encode()
        return self.send(status, body)

    def image(self, u):
        parsed = urllib.parse.urlparse(u)
        host = parsed.hostname or ""
        if parsed.scheme != "https" or not any(host == s or host.endswith("." + s) for s in IMG_HOST_SUFFIXES):
            return self.err(400, "Image host not allowed")
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        f = CACHE_DIR / hashlib.sha1(u.encode()).hexdigest()
        data = f.read_bytes() if f.exists() else b""
        if not image_complete(data):   # not cached yet, or an earlier download came back empty / cut short
            try:
                status, _, data = fetch(u, timeout=40)
            except OSError as e:
                return self.err(502, f"Image fetch failed ({e})")
            if status != 200:
                return self.err(status, f"Image fetch failed ({status})")
            if sniff_image(data[:16]) == "application/octet-stream":
                f.unlink(missing_ok=True)
                return self.err(502, "The image host sent an empty or unreadable file")
            if image_complete(data):   # only keep whole images, so a bad download is retried next time
                tmp = f.with_suffix(".tmp")
                tmp.write_bytes(data)
                os.replace(tmp, f)
            else:
                f.unlink(missing_ok=True)
                return self.send(200, data, sniff_image(data[:16]))
        return self.send(200, data, sniff_image(data[:16]), 86400)


def image_complete(data):
    """True if data is a recognised image that wasn't cut off part-way."""
    kind = sniff_image(data[:16])
    if kind == "image/png":
        return b"IEND" in data[-64:]
    if kind == "image/jpeg":
        return b"\xff\xd9" in data[-1024:]   # some encoders leave padding after the end marker
    if kind == "image/webp":
        return len(data) >= struct.unpack("<I", data[4:8])[0] + 8
    if kind == "image/gif":
        return data.rstrip(b"\0").endswith(b"\x3b")
    return False


def sniff_image(head):
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:3] == b"GIF":
        return "image/gif"
    return "application/octet-stream"


def main():
    ap = argparse.ArgumentParser(description="Cover Studio for SteamGridDB")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--auto-exit", action="store_true",
                    help="quit a few minutes after the last browser tab closes")
    args = ap.parse_args()

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if not server:
        sys.exit("No free port found")
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Cover Studio running at {url}  (Ctrl+C to stop)")

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    if args.auto_exit:
        def watchdog():
            while True:
                time.sleep(30)
                if time.time() - _last_ping > 240:
                    print("No open editor tabs — shutting down.")
                    server.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
