@echo off
setlocal
title Just Volleyball Data Collector
set "JV_SELF=%~f0"
set "JV_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$lines = [System.IO.File]::ReadAllLines($env:JV_SELF, [System.Text.Encoding]::UTF8); $i = [Array]::FindIndex($lines, [Predicate[string]]{ param($l) $l.Trim() -eq '###__PS_START__###' }); if ($i -lt 0) { Write-Host '[ERROR] PowerShell payload marker not found.' -ForegroundColor Red; exit 1 }; $code = ($lines[($i+1)..($lines.Length-1)] -join [char]10); & ([ScriptBlock]::Create($code))"
set "RC=%errorlevel%"
if not "%JV_NO_PAUSE%"=="1" (
    echo.
    pause
)
exit /b %RC%

###__PS_START__###
$ErrorActionPreference = 'Stop'

$appDataRoot = Join-Path $env:APPDATA 'Godot\app_userdata\volleyball'
if (-not (Test-Path -LiteralPath $appDataRoot)) {
    Write-Host ''
    Write-Host '[ERROR] Could not find Just Volleyball save data at:' -ForegroundColor Red
    Write-Host "  $appDataRoot"
    Write-Host 'Make sure you have launched Just Volleyball on this Windows account at least once.'
    exit 1
}

Add-Type -AssemblyName System.Web.Extensions, System.IO.Compression, System.IO.Compression.FileSystem
$refAssemblies = @(
    ([System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location),
    ([System.IO.Compression.CompressionLevel].Assembly.Location),
    ([System.IO.Compression.ZipFile].Assembly.Location)
)

$csCode = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

public static class JvCollector {
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

    private static string ReadAllTextShared(string path) {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var sr = new StreamReader(fs, Utf8NoBom, true)) {
            return sr.ReadToEnd();
        }
    }

    private static JavaScriptSerializer MakeSerializer() {
        var js = new JavaScriptSerializer();
        js.MaxJsonLength = int.MaxValue;
        js.RecursionLimit = 256;
        return js;
    }

    public static string SerializeJson(object obj) {
        return MakeSerializer().Serialize(SanitizeForJson(obj));
    }

    public static object ParseJson(string text) {
        return MakeSerializer().DeserializeObject(text);
    }

    private static object SanitizeForJson(object v) {
        if (v == null) return null;
        if (v is double) {
            double d = (double)v;
            return (double.IsNaN(d) || double.IsInfinity(d)) ? null : v;
        }
        if (v is float) {
            float f = (float)v;
            return (float.IsNaN(f) || float.IsInfinity(f)) ? null : v;
        }
        var dict = v as IDictionary;
        if (dict != null) {
            var res = new Dictionary<string, object>(dict.Count);
            foreach (DictionaryEntry de in dict) {
                string key = de.Key == null ? "" : Convert.ToString(de.Key, CultureInfo.InvariantCulture);
                res[key] = SanitizeForJson(de.Value);
            }
            return res;
        }
        var arr = v as Array;
        if (arr != null && !(v is string)) {
            var list = new List<object>(arr.Length);
            for (int i = 0; i < arr.Length; i++) list.Add(SanitizeForJson(arr.GetValue(i)));
            return list;
        }
        var ilist = v as IList;
        if (ilist != null) {
            var list = new List<object>(ilist.Count);
            for (int i = 0; i < ilist.Count; i++) list.Add(SanitizeForJson(ilist[i]));
            return list;
        }
        return v;
    }

    public static string Sha256Hex(byte[] bytes) {
        using (var sha = SHA256.Create()) {
            byte[] h = sha.ComputeHash(bytes);
            var sb = new StringBuilder(h.Length * 2);
            for (int i = 0; i < h.Length; i++) sb.Append(h[i].ToString("x2"));
            return sb.ToString();
        }
    }

    private static Dictionary<string, object> CleanMatchDict(IDictionary raw) {
        var outDict = new Dictionary<string, object>();
        foreach (DictionaryEntry de in raw) {
            string k = Convert.ToString(de.Key, CultureInfo.InvariantCulture);
            if (k == "chat") continue;
            if (k == "players" && de.Value is IList) {
                var rawPlayers = (IList)de.Value;
                var cleanPlayers = new List<object>(rawPlayers.Count);
                for (int i = 0; i < rawPlayers.Count; i++) {
                    var pd = rawPlayers[i] as IDictionary;
                    if (pd == null) continue;
                    var cp = new Dictionary<string, object>();
                    foreach (DictionaryEntry pde in pd) {
                        string pk = Convert.ToString(pde.Key, CultureInfo.InvariantCulture);
                        if (pk == "cfg") continue;
                        cp[pk] = pde.Value;
                    }
                    cleanPlayers.Add(cp);
                }
                outDict["players"] = cleanPlayers;
            } else {
                outDict[k] = de.Value;
            }
        }
        return outDict;
    }

    private static List<object> CleanMatchList(object val) {
        var list = val as IList;
        var outList = new List<object>();
        if (list == null) return outList;
        for (int i = 0; i < list.Count; i++) {
            var md = list[i] as IDictionary;
            if (md != null) outList.Add(CleanMatchDict(md));
        }
        return outList;
    }

    private static List<object> CleanProfilesArray(object val) {
        var list = val as IList;
        var outList = new List<object>();
        if (list == null) return outList;
        string[] keepKeys = new string[] { "name", "uid", "level", "xp", "stats" };
        for (int i = 0; i < list.Count; i++) {
            var pr = list[i] as IDictionary;
            if (pr == null) continue;
            var cp = new Dictionary<string, object>();
            for (int k = 0; k < keepKeys.Length; k++) {
                string key = keepKeys[k];
                if (pr.Contains(key)) cp[key] = pr[key];
            }
            cp["match_history"] = pr.Contains("match_history") ? CleanMatchList(pr["match_history"]) : new List<object>();
            cp["favorite_matches"] = pr.Contains("favorite_matches") ? CleanMatchList(pr["favorite_matches"]) : new List<object>();
            outList.Add(cp);
        }
        return outList;
    }

    public static string SanitizeProfilesJson(string inputPath, out int matchCount) {
        matchCount = 0;
        string rawText = ReadAllTextShared(inputPath);
        var root = ParseJson(rawText) as IDictionary;
        if (root == null) throw new InvalidDataException("Root JSON is not an object.");

        var outRoot = new Dictionary<string, object>();
        if (root.Contains("version")) outRoot["version"] = root["version"];
        if (root.Contains("active")) outRoot["active"] = root["active"];
        var cleanedProfiles = root.Contains("profiles") ? CleanProfilesArray(root["profiles"]) : new List<object>();
        outRoot["profiles"] = cleanedProfiles;
        outRoot["recently_deleted"] = root.Contains("recently_deleted") ? CleanProfilesArray(root["recently_deleted"]) : new List<object>();

        for (int i = 0; i < cleanedProfiles.Count; i++) {
            var pr = (Dictionary<string, object>)cleanedProfiles[i];
            matchCount += ((List<object>)pr["match_history"]).Count;
            matchCount += ((List<object>)pr["favorite_matches"]).Count;
        }
        return SerializeJson(outRoot);
    }

    public static string[] DetectPlayerIdentity(string profilesPath) {
        string bestName = "";
        string bestSid = "";
        if (!File.Exists(profilesPath)) return new string[] { bestName, bestSid };

        try {
            var root = ParseJson(ReadAllTextShared(profilesPath)) as IDictionary;
            if (root == null || !root.Contains("profiles")) return new string[] { bestName, bestSid };
            var profiles = root["profiles"] as IList;
            if (profiles == null || profiles.Count == 0) return new string[] { bestName, bestSid };

            int activeIdx = 0;
            if (root.Contains("active") && root["active"] != null) {
                activeIdx = Convert.ToInt32(root["active"], CultureInfo.InvariantCulture);
            }
            if (activeIdx < 0 || activeIdx >= profiles.Count) activeIdx = 0;

            var ordered = new List<IDictionary>();
            if (profiles[activeIdx] is IDictionary) ordered.Add((IDictionary)profiles[activeIdx]);
            for (int i = 0; i < profiles.Count; i++) {
                if (i != activeIdx && profiles[i] is IDictionary) ordered.Add((IDictionary)profiles[i]);
            }

            long bestTs = -1;
            for (int pi = 0; pi < ordered.Count; pi++) {
                var pr = ordered[pi];
                if (string.IsNullOrEmpty(bestName) && pr.Contains("name") && pr["name"] != null) {
                    bestName = Convert.ToString(pr["name"], CultureInfo.InvariantCulture).Trim();
                }
                var mh = pr.Contains("match_history") ? (pr["match_history"] as IList) : null;
                if (mh == null) continue;
                for (int mi = mh.Count - 1; mi >= 0; mi--) {
                    var m = mh[mi] as IDictionary;
                    if (m == null) continue;
                    bool isOnline = m.Contains("online") && m["online"] is bool && (bool)m["online"];
                    if (!isOnline) continue;
                    long ts = m.Contains("ts") && m["ts"] != null ? Convert.ToInt64(m["ts"], CultureInfo.InvariantCulture) : 0;
                    if (ts < bestTs) continue;
                    string myName = m.Contains("my_name") && m["my_name"] != null ? Convert.ToString(m["my_name"], CultureInfo.InvariantCulture).Trim() : "";
                    string foundSid = "";
                    var players = m.Contains("players") ? (m["players"] as IList) : null;
                    if (players != null && !string.IsNullOrEmpty(myName)) {
                        for (int k = 0; k < players.Count; k++) {
                            var pl = players[k] as IDictionary;
                            if (pl == null) continue;
                            string pn = pl.Contains("name") && pl["name"] != null ? Convert.ToString(pl["name"], CultureInfo.InvariantCulture).Trim() : "";
                            string prn = pl.Contains("ready_name") && pl["ready_name"] != null ? Convert.ToString(pl["ready_name"], CultureInfo.InvariantCulture).Trim() : "";
                            if (pn == myName || prn == myName) {
                                string sid = pl.Contains("sid") && pl["sid"] != null ? Convert.ToString(pl["sid"], CultureInfo.InvariantCulture).Trim() : "";
                                if (!string.IsNullOrEmpty(sid) && sid != "0") {
                                    foundSid = sid;
                                    break;
                                }
                            }
                        }
                    }
                    if (!string.IsNullOrEmpty(myName)) {
                        bestTs = ts;
                        bestName = myName;
                        if (!string.IsNullOrEmpty(foundSid)) bestSid = foundSid;
                    }
                }
            }
        } catch {
            // Fall back cleanly if active profiles.json is unreadable; backup files still get scanned.
        }
        return new string[] { bestName, bestSid };
    }

    private sealed class GodotVarReader {
        private const int MaxDepth = 64;
        private readonly byte[] _buf;
        private readonly int _limit;
        public int Pos;

        public GodotVarReader(byte[] buf, int pos, int limit) {
            _buf = buf;
            Pos = pos;
            _limit = Math.Min(limit, buf.Length);
        }

        private void Ensure(int bytes) {
            if (bytes < 0 || Pos > _limit - bytes) {
                throw new EndOfStreamException("Unexpected end of Godot Variant data.");
            }
        }

        private int ValidateCount(int count, int minBytesPerItem) {
            if (count < 0 || (minBytesPerItem > 0 && count > (_limit - Pos) / minBytesPerItem)) {
                throw new InvalidDataException("Invalid collection length in Variant: " + count);
            }
            return count;
        }

        public uint U32() {
            Ensure(4);
            uint v = BitConverter.ToUInt32(_buf, Pos);
            Pos += 4;
            return v;
        }

        public int I32() {
            Ensure(4);
            int v = BitConverter.ToInt32(_buf, Pos);
            Pos += 4;
            return v;
        }

        public long I64() {
            Ensure(8);
            long v = BitConverter.ToInt64(_buf, Pos);
            Pos += 8;
            return v;
        }

        public ulong U64() {
            Ensure(8);
            ulong v = BitConverter.ToUInt64(_buf, Pos);
            Pos += 8;
            return v;
        }

        public float F32() {
            Ensure(4);
            float v = BitConverter.ToSingle(_buf, Pos);
            Pos += 4;
            return v;
        }

        public double F64() {
            Ensure(8);
            double v = BitConverter.ToDouble(_buf, Pos);
            Pos += 8;
            return v;
        }

        private object FNum(bool dbl) {
            if (dbl) {
                double d = F64();
                return (double.IsNaN(d) || double.IsInfinity(d)) ? (object)null : d;
            }
            float f = F32();
            return (float.IsNaN(f) || float.IsInfinity(f)) ? (object)null : (double)f;
        }

        private List<object> ReadFloats(int count, bool dbl) {
            ValidateCount(count, dbl ? 8 : 4);
            var list = new List<object>(Math.Min(count, 4096));
            for (int i = 0; i < count; i++) list.Add(FNum(dbl));
            return list;
        }

        private List<object> ReadInts(int count) {
            ValidateCount(count, 4);
            var list = new List<object>(Math.Min(count, 4096));
            for (int i = 0; i < count; i++) list.Add(I32());
            return list;
        }

        private string ReadGodotString() {
            int n = I32();
            if (n < 0 || n > _limit - Pos) throw new InvalidDataException("Invalid string length in Variant.");
            int padded = (n + 3) & ~3;
            Ensure(padded);
            string s = n == 0 ? "" : Utf8NoBom.GetString(_buf, Pos, n);
            Pos += padded;
            return s;
        }

        public object ReadVarBlock() {
            int blen = I32();
            Ensure(blen);
            int end = Pos + blen;
            object val = ReadVal(0);
            Pos = end;
            return val;
        }

        public object ReadVal(int depth) {
            if (depth > MaxDepth) throw new InvalidDataException("Variant nesting depth exceeded.");
            uint hdr = U32();
            int t = (int)(hdr & 0xFFFF);
            uint flags = hdr >> 16;
            bool dbl = (flags & 1) != 0;

            switch (t) {
                case 0: return null; // NIL
                case 1: return U32() != 0; // BOOL
                case 2: return dbl ? I64() : (long)I32(); // INT
                case 3: return FNum(dbl); // FLOAT
                case 4: return ReadGodotString(); // STRING
                case 5: return ReadFloats(2, dbl); // VECTOR2
                case 6: return ReadInts(2); // VECTOR2I
                case 7: return ReadFloats(4, dbl); // RECT2
                case 8: return ReadInts(4); // RECT2I
                case 9: return ReadFloats(3, dbl); // VECTOR3
                case 10: return ReadInts(3); // VECTOR3I
                case 11: return ReadFloats(6, dbl); // TRANSFORM2D
                case 12: return ReadFloats(4, dbl); // VECTOR4
                case 13: return ReadInts(4); // VECTOR4I
                case 14: return ReadFloats(4, dbl); // PLANE
                case 15: return ReadFloats(4, dbl); // QUATERNION
                case 16: return ReadFloats(6, dbl); // AABB
                case 17: return ReadFloats(9, dbl); // BASIS
                case 18: return ReadFloats(12, dbl); // TRANSFORM3D
                case 19: return ReadFloats(16, dbl); // PROJECTION
                case 20: return ReadFloats(4, false); // COLOR (always 4x float32)
                case 21: return ReadGodotString(); // STRING_NAME
                case 22: { // NODE_PATH
                    int npLen = I32();
                    if ((npLen & unchecked((int)0x80000000)) != 0 || (npLen & 0x40000000) != 0) {
                        int nameCount = ValidateCount(npLen & 0x3FFFFFFF, 4);
                        int subCount = ValidateCount(I32(), 4);
                        bool abs = (I32() & 1) != 0;
                        var names = new List<string>(Math.Min(nameCount, 256));
                        var subs = new List<string>(Math.Min(subCount, 256));
                        for (int i = 0; i < nameCount; i++) names.Add(ReadGodotString());
                        for (int i = 0; i < subCount; i++) subs.Add(ReadGodotString());
                        string p = (abs ? "/" : "") + string.Join("/", names);
                        if (subs.Count > 0) p += ":" + string.Join(":", subs);
                        return p;
                    }
                    int legacyBytes = ValidateCount(npLen, 1);
                    int padded = (legacyBytes + 3) & ~3;
                    Ensure(padded);
                    Pos += padded;
                    return "";
                }
                case 23: return U64(); // RID
                case 27: { // DICTIONARY
                    int count = ValidateCount((int)(U32() & 0x7FFFFFFF), 8);
                    var dict = new Dictionary<string, object>(Math.Min(count, 4096));
                    for (int i = 0; i < count; i++) {
                        object k = ReadVal(depth + 1);
                        object v = ReadVal(depth + 1);
                        string ks = k == null ? "" : Convert.ToString(k, CultureInfo.InvariantCulture);
                        dict[ks] = v;
                    }
                    return dict;
                }
                case 28: { // ARRAY
                    int count = ValidateCount((int)(U32() & 0x7FFFFFFF), 4);
                    var list = new List<object>(Math.Min(count, 4096));
                    for (int i = 0; i < count; i++) list.Add(ReadVal(depth + 1));
                    return list;
                }
                case 29: { // PACKED_BYTE_ARRAY
                    int count = ValidateCount(I32(), 1);
                    int padded = (count + 3) & ~3;
                    Ensure(padded);
                    var bytes = new List<object>(Math.Min(count, 4096));
                    for (int i = 0; i < count; i++) bytes.Add((int)_buf[Pos + i]);
                    Pos += padded;
                    return bytes;
                }
                case 30: return ReadInts(I32()); // PACKED_INT32_ARRAY
                case 31: { // PACKED_INT64_ARRAY
                    int count = ValidateCount(I32(), 8);
                    var list = new List<object>(Math.Min(count, 4096));
                    for (int i = 0; i < count; i++) list.Add(I64());
                    return list;
                }
                case 32: return ReadFloats(I32(), false); // PACKED_FLOAT32_ARRAY
                case 33: return ReadFloats(I32(), true); // PACKED_FLOAT64_ARRAY
                case 34: { // PACKED_STRING_ARRAY
                    int count = ValidateCount(I32(), 4);
                    var list = new List<object>(Math.Min(count, 4096));
                    for (int i = 0; i < count; i++) list.Add(ReadGodotString());
                    return list;
                }
                case 35: return ReadFloats(ValidateCount(I32(), dbl ? 16 : 8) * 2, dbl); // PACKED_VECTOR2_ARRAY
                case 36: return ReadFloats(ValidateCount(I32(), dbl ? 24 : 12) * 3, dbl); // PACKED_VECTOR3_ARRAY
                case 37: return ReadFloats(ValidateCount(I32(), 16) * 4, false); // PACKED_COLOR_ARRAY
                case 38: return ReadFloats(ValidateCount(I32(), dbl ? 32 : 16) * 4, dbl); // PACKED_VECTOR4_ARRAY
                default:
                    throw new NotSupportedException("Unsupported Godot Variant type " + t + " (flags=" + flags + ")");
            }
        }
    }

    public static Dictionary<string, object> ExtractVbrSummary(string path) {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var br = new BinaryReader(fs)) {
            byte[] magic = br.ReadBytes(4);
            if (magic.Length < 4 || Encoding.ASCII.GetString(magic) != "GCPF") {
                throw new InvalidDataException("Bad GCPF header");
            }
            uint cmode = br.ReadUInt32();
            uint bsize = br.ReadUInt32();
            uint total = br.ReadUInt32();
            if (cmode != 3) {
                throw new NotSupportedException("Unexpected GCPF compression mode " + cmode);
            }
            if (bsize == 0) throw new InvalidDataException("Zero GCPF block size");
            int bc = (int)(((ulong)total + bsize - 1UL) / bsize);
            uint[] csizes = new uint[bc];
            for (int i = 0; i < bc; i++) csizes[i] = br.ReadUInt32();

            using (var ms = new MemoryStream()) {
                byte[] copyBuf = new byte[16384];
                bool metaChecked = false;
                uint formatVer = 0;
                int pMetaEnd = -1;
                int pSlotsEnd = -1;
                int targetLen = -1;
                Dictionary<string, object> metaDict = null;

                for (int bi = 0; bi < bc; bi++) {
                    byte[] cblock = br.ReadBytes((int)csizes[bi]);
                    if (cblock.Length < (int)csizes[bi]) throw new EndOfStreamException("Truncated GCPF block");
                    using (var cms = new MemoryStream(cblock))
                    using (var gz = new GZipStream(cms, CompressionMode.Decompress)) {
                        int read;
                        while ((read = gz.Read(copyBuf, 0, copyBuf.Length)) > 0) {
                            ms.Write(copyBuf, 0, read);
                        }
                    }

                    byte[] buf = ms.GetBuffer();
                    int have = (int)ms.Length;

                    if (pMetaEnd < 0 && have >= 12) {
                        if (buf[0] != (byte)'V' || buf[1] != (byte)'B' || buf[2] != (byte)'R' || buf[3] != (byte)'P') {
                            throw new InvalidDataException("Bad VBRP magic inside replay");
                        }
                        formatVer = BitConverter.ToUInt32(buf, 4);
                        int mLen = (int)BitConverter.ToUInt32(buf, 8);
                        if (mLen < 0) throw new InvalidDataException("Invalid VBRP meta length");
                        pMetaEnd = 12 + mLen;
                    }
                    if (!metaChecked && pMetaEnd >= 0 && have >= pMetaEnd) {
                        var mr = new GodotVarReader(buf, 8, have);
                        metaDict = mr.ReadVarBlock() as Dictionary<string, object>;
                        metaChecked = true;
                        bool isOnline = metaDict != null && metaDict.ContainsKey("online") && metaDict["online"] is bool && (bool)metaDict["online"];
                        if (!isOnline) {
                            return null; // Skip offline replay immediately without decompressing frame blocks.
                        }
                    }
                    if (metaChecked && pSlotsEnd < 0 && have >= pMetaEnd + 4) {
                        int sLen = (int)BitConverter.ToUInt32(buf, pMetaEnd);
                        if (sLen < 0) throw new InvalidDataException("Invalid VBRP slots length");
                        pSlotsEnd = pMetaEnd + 4 + sLen;
                    }
                    if (pSlotsEnd >= 0 && targetLen < 0 && have >= pSlotsEnd + 4) {
                        int eLen = (int)BitConverter.ToUInt32(buf, pSlotsEnd);
                        if (eLen < 0) throw new InvalidDataException("Invalid VBRP events length");
                        targetLen = pSlotsEnd + 4 + eLen;
                    }
                    if (targetLen >= 0 && have >= targetLen) {
                        break;
                    }
                }

                if (targetLen < 0 || ms.Length < targetLen) {
                    throw new EndOfStreamException("Incomplete VBRP metadata/events section");
                }

                byte[] finalBuf = ms.GetBuffer();
                var r = new GodotVarReader(finalBuf, pMetaEnd, (int)ms.Length);
                var rawSlots = r.ReadVarBlock() as IList;
                var rawEvents = r.ReadVarBlock() as IList;

                var cleanSlots = new List<object>();
                if (rawSlots != null) {
                    for (int i = 0; i < rawSlots.Count; i++) {
                        var sd = rawSlots[i] as IDictionary;
                        if (sd == null) continue;
                        var cs = new Dictionary<string, object>(sd.Count);
                        foreach (DictionaryEntry de in sd) {
                            string k = Convert.ToString(de.Key, CultureInfo.InvariantCulture);
                            if (k == "cfg") continue;
                            cs[k] = de.Value;
                        }
                        cleanSlots.Add(cs);
                    }
                }

                var cleanEvents = new List<object>();
                if (rawEvents != null) {
                    for (int i = 0; i < rawEvents.Count; i++) {
                        var ed = rawEvents[i] as IDictionary;
                        if (ed == null || !ed.Contains("k")) continue;
                        string kind = Convert.ToString(ed["k"], CultureInfo.InvariantCulture);
                        if (kind == "point") {
                            cleanEvents.Add(ed);
                        } else if (kind == "seat") {
                            var ce = new Dictionary<string, object>(3);
                            if (ed.Contains("t")) ce["t"] = ed["t"];
                            ce["k"] = "seat";
                            var dd = ed.Contains("d") ? (ed["d"] as IDictionary) : null;
                            if (dd != null) {
                                var cd = new Dictionary<string, object>(dd.Count);
                                foreach (DictionaryEntry dde in dd) {
                                    string dk = Convert.ToString(dde.Key, CultureInfo.InvariantCulture);
                                    if (dk == "cfg") continue;
                                    cd[dk] = dde.Value;
                                }
                                ce["d"] = cd;
                            }
                            cleanEvents.Add(ce);
                        }
                    }
                }

                var res = new Dictionary<string, object>();
                res["file"] = Path.GetFileName(path);
                res["mtime_utc"] = File.GetLastWriteTimeUtc(path).ToString("yyyy-MM-ddTHH:mm:ssZ");
                res["format_version"] = formatVer;
                res["meta"] = metaDict;
                res["slots"] = cleanSlots;
                res["events"] = cleanEvents;
                return res;
            }
        }
    }

    public static void BuildZip(string stageDir, string zipPath) {
        if (File.Exists(zipPath)) File.Delete(zipPath);
        ZipFile.CreateFromDirectory(stageDir, zipPath, CompressionLevel.Optimal, false, Utf8NoBom);
    }
}
'@

Write-Host '======================================================'
Write-Host '  Just Volleyball Data Collector (v1.0)'
Write-Host '======================================================'
Write-Host "Reading game data from: $appDataRoot"
Write-Host 'Initializing helpers...'

Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refAssemblies

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$seenHashes = New-Object 'System.Collections.Generic.HashSet[string]'
$errorsList = New-Object 'System.Collections.Generic.List[string]'

$counts = [ordered]@{
    profiles_scanned = 0
    profiles_saved = 0
    profiles_deduped = 0
    save_backups_scanned = 0
    save_backups_saved = 0
    save_backups_deduped = 0
    vbr_scanned = 0
    vbr_online_saved = 0
    vbr_skipped_offline = 0
    vbr_errors = 0
}

$activeProfPath = Join-Path $appDataRoot 'data\profiles.json'
if (-not (Test-Path -LiteralPath $activeProfPath)) {
    foreach ($fb in @('data\profiles.json.bak', 'data\profiles.json.old')) {
        $cand = Join-Path $appDataRoot $fb
        if (Test-Path -LiteralPath $cand) { $activeProfPath = $cand; break }
    }
}

$idPair = [JvCollector]::DetectPlayerIdentity($activeProfPath)
$playerName = if ($idPair[0]) { $idPair[0] } else { 'Player' }
$playerSid = $idPair[1]

$safeName = ([regex]::Replace($playerName, '[^A-Za-z0-9_-]+', '_')).Trim('_')
if (-not $safeName) { $safeName = 'Player' }
if ($safeName.Length -gt 24) { $safeName = $safeName.Substring(0, 24).Trim('_') }
if (-not $safeName) { $safeName = 'Player' }

$stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
$zipName = "JustVolleyball_Data_${safeName}_${stamp}.zip"

$targetDir = if ($env:JV_DIR -and (Test-Path -LiteralPath $env:JV_DIR)) {
    if ($env:JV_DIR.Length -gt 3) { $env:JV_DIR.TrimEnd('\') } else { $env:JV_DIR }
} else {
    [Environment]::GetFolderPath('Desktop')
}
try {
    $probeFile = Join-Path $targetDir ".jv_write_test_$([guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllText($probeFile, 'ok', $utf8NoBom)
    Remove-Item -LiteralPath $probeFile -Force
} catch {
    $targetDir = [Environment]::GetFolderPath('Desktop')
}
$zipPath = Join-Path $targetDir $zipName
$stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("jv_collect_" + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $stageDir -Force)

try {
    Write-Host "Detected player: $playerName" $(if ($playerSid) { "(SteamID $playerSid)" } else { "" })

    # 1. Profile match histories (data\profiles.json* and data\flagged\profiles*.json*)
    Write-Host '[1/3] Collecting & sanitizing profile match histories...'
    $profileCandidates = New-Object 'System.Collections.Generic.List[object]'
    $dataDir = Join-Path $appDataRoot 'data'
    foreach ($fn in @('profiles.json', 'profiles.json.bak', 'profiles.json.old')) {
        $fp = Join-Path $dataDir $fn
        if (Test-Path -LiteralPath $fp) {
            $profileCandidates.Add([pscustomobject]@{ Path = $fp; Rel = "data/$fn" })
        }
    }
    $flaggedDir = Join-Path $dataDir 'flagged'
    if (Test-Path -LiteralPath $flaggedDir) {
        Get-ChildItem -LiteralPath $flaggedDir -File -Filter 'profiles*.json*' -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
            $profileCandidates.Add([pscustomobject]@{ Path = $_.FullName; Rel = "data/flagged/$($_.Name)" })
        }
    }

    foreach ($item in $profileCandidates) {
        $counts.profiles_scanned++
        try {
            $mc = 0
            $cleanJson = [JvCollector]::SanitizeProfilesJson($item.Path, [ref]$mc)
            $bytes = $utf8NoBom.GetBytes($cleanJson)
            $hash = [JvCollector]::Sha256Hex($bytes)
            if (-not $seenHashes.Add($hash)) {
                $counts.profiles_deduped++
                continue
            }
            $outPath = Join-Path $stageDir ($item.Rel -replace '/', '\')
            [void](New-Item -ItemType Directory -Path (Split-Path $outPath -Parent) -Force)
            [System.IO.File]::WriteAllBytes($outPath, $bytes)
            $counts.profiles_saved++
        } catch {
            $msg = "profiles ($($item.Rel)): $($_.Exception.Message)"
            $errorsList.Add($msg)
            Write-Host "  [WARN] $msg" -ForegroundColor Yellow
        }
    }
    Write-Host "  Saved $($counts.profiles_saved) profile file(s) ($($counts.profiles_deduped) identical copy/copies skipped)."

    # 2. In-game save backups (Documents\just volleyball\save backups and userdata\save backups)
    Write-Host '[2/3] Checking save backups for older match histories...'
    $backupRoots = New-Object 'System.Collections.Generic.List[object]'
    $docsDir = [Environment]::GetFolderPath('MyDocuments')
    if ($docsDir) {
        $docBackups = Join-Path $docsDir 'just volleyball\save backups'
        if (Test-Path -LiteralPath $docBackups) {
            $backupRoots.Add([pscustomobject]@{ Dir = $docBackups; Prefix = 'docs' })
        }
    }
    $userBackups = Join-Path $appDataRoot 'save backups'
    if (Test-Path -LiteralPath $userBackups) {
        $backupRoots.Add([pscustomobject]@{ Dir = $userBackups; Prefix = 'userdata' })
    }

    foreach ($br in $backupRoots) {
        $rootFull = [System.IO.Path]::GetFullPath($br.Dir).TrimEnd('\')
        Get-ChildItem -LiteralPath $rootFull -File -Recurse -Filter 'profiles*.json*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | ForEach-Object {
            $counts.save_backups_scanned++
            $rel = $_.FullName.Substring($rootFull.Length).TrimStart('\')
            try {
                $mc = 0
                $cleanJson = [JvCollector]::SanitizeProfilesJson($_.FullName, [ref]$mc)
                if ($mc -eq 0) {
                    $counts.save_backups_deduped++
                    return
                }
                $bytes = $utf8NoBom.GetBytes($cleanJson)
                $hash = [JvCollector]::Sha256Hex($bytes)
                if (-not $seenHashes.Add($hash)) {
                    $counts.save_backups_deduped++
                    return
                }
                $outRel = if ($backupRoots.Count -gt 1) { "save_backups\$($br.Prefix)\$rel" } else { "save_backups\$rel" }
                $outPath = Join-Path $stageDir $outRel
                [void](New-Item -ItemType Directory -Path (Split-Path $outPath -Parent) -Force)
                [System.IO.File]::WriteAllBytes($outPath, $bytes)
                $counts.save_backups_saved++
            } catch {
                $msg = "save_backup ($rel): $($_.Exception.Message)"
                $errorsList.Add($msg)
                Write-Host "  [WARN] $msg" -ForegroundColor Yellow
            }
        }
    }
    Write-Host "  Saved $($counts.save_backups_saved) unique backup file(s) ($($counts.save_backups_deduped) duplicate/empty skipped)."

    # 3. Online .vbr replay summaries
    Write-Host '[3/3] Extracting online replay metadata & point/seat events (.vbr)...'
    $replaysDir = Join-Path $appDataRoot 'replays'
    $vbrSummaries = New-Object 'System.Collections.Generic.List[object]'
    if (Test-Path -LiteralPath $replaysDir) {
        Get-ChildItem -LiteralPath $replaysDir -File -Filter '*.vbr' -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
            $counts.vbr_scanned++
            try {
                $summary = [JvCollector]::ExtractVbrSummary($_.FullName)
                if ($null -eq $summary) {
                    $counts.vbr_skipped_offline++
                } else {
                    $vbrSummaries.Add($summary)
                    $counts.vbr_online_saved++
                }
            } catch {
                $counts.vbr_errors++
                $msg = "vbr ($($_.Name)): $($_.Exception.Message)"
                $errorsList.Add($msg)
                Write-Host "  [WARN] $msg" -ForegroundColor Yellow
            }
        }
    }
    $replaysOutDir = Join-Path $stageDir 'replays'
    [void](New-Item -ItemType Directory -Path $replaysOutDir -Force)
    [System.IO.File]::WriteAllText((Join-Path $replaysOutDir 'vbr_replays.json'), [JvCollector]::SerializeJson($vbrSummaries), $utf8NoBom)
    Write-Host "  Extracted $($counts.vbr_online_saved) online replay(s) ($($counts.vbr_skipped_offline) offline skipped, $($counts.vbr_errors) error(s))."

    # Write manifest.json
    $manifest = [ordered]@{
        collector_version = '1.0'
        collected_at_utc  = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        player_name       = $playerName
        player_sid        = $playerSid
        counts            = $counts
        privacy_scrubbed  = @(
            'chat logs removed from match_history and favorite_matches',
            'cosmetic avatar cfg removed from match players, replay slots, and seat events',
            'account bindings, seals, achievements, cosmetics, settings, and UI prefs excluded',
            'Steam tokens, config files, crash/debug logs, and 3D replay pose frames excluded'
        )
        errors            = @($errorsList)
    }
    [System.IO.File]::WriteAllText((Join-Path $stageDir 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10), $utf8NoBom)

    Write-Host ''
    Write-Host 'Creating zip archive...'
    [JvCollector]::BuildZip($stageDir, $zipPath)
    $zipInfo = Get-Item -LiteralPath $zipPath
    $sizeStr = if ($zipInfo.Length -ge 1MB) { ('{0:N2} MB' -f ($zipInfo.Length / 1MB)) } else { ('{0:N1} KB' -f ($zipInfo.Length / 1KB)) }

    Write-Host ''
    Write-Host '[DONE] Collection complete!' -ForegroundColor Green
    Write-Host "  Zip file: $zipPath"
    Write-Host "  Zip size: $sizeStr"
    Write-Host '  Privacy:  No chat logs, Steam tokens, settings, bindings, or 3D frame bloat included.'

    if ($env:JV_NO_EXPLORER -ne '1') {
        if ($zipPath -like '*,*') {
            Start-Process explorer.exe -ArgumentList "`"$targetDir`""
        } else {
            Start-Process explorer.exe -ArgumentList "/select,`"$zipPath`""
        }
    }
    exit 0
} finally {
    if (Test-Path -LiteralPath $stageDir) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}