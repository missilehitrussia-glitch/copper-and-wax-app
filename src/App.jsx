import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX,
  ListMusic, SlidersHorizontal, Music, Activity, Disc, Upload, Trash2
} from "lucide-react";

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  Flat:          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Bass Boost":  [7, 6, 5, 2, 0, -1, -1, 0, 0, 0],
  Vocal:         [-2, -2, 0, 2, 4, 4, 3, 1, 0, -1],
  "Treble Boost":[0, 0, -1, -1, 0, 1, 2, 4, 6, 7],
  Loudness:      [5, 3, 1, 0, 0, 0, 1, 2, 4, 5],
};
const SETTINGS_KEY = "copper-wax-settings-v2";
const DB_NAME = "copper-wax-db";
const STORE_NAME = "tracks";

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
function hueBg(hue, alpha = 1) { return `hsla(${hue}, 70%, 55%, ${alpha})`; }
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function cleanTitle(filename) {
  return filename.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

// ---------- IndexedDB helpers ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- pink noise (used only for the empty-library demo tone) ----------
function createPinkNoiseBuffer(ctx) {
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886*b0 + white*0.0555179;
    b1 = 0.99332*b1 + white*0.0750759;
    b2 = 0.96900*b2 + white*0.1538520;
    b3 = 0.86650*b3 + white*0.3104856;
    b4 = 0.55000*b4 + white*0.5329522;
    b5 = -0.7616*b5 - white*0.0168980;
    data[i] = (b0+b1+b2+b3+b4+b5+b6+white*0.5362) * 0.09;
    b6 = white*0.115926;
  }
  return buffer;
}

function buildFilterChain(ctx, sourceNode, initialBands, initialVolume) {
  const filters = BANDS.map((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = "peaking";
    f.frequency.value = freq;
    f.Q.value = 1;
    f.gain.value = initialBands[i] ?? 0;
    return f;
  });
  let node = sourceNode;
  filters.forEach((f) => { node.connect(f); node = f; });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 64;
  node.connect(analyser);
  const masterGain = ctx.createGain();
  masterGain.gain.value = initialVolume;
  analyser.connect(masterGain).connect(ctx.destination);
  return { filters, analyser, masterGain };
}

function buildDemoSource(ctx) {
  const noiseBuffer = createPinkNoiseBuffer(ctx);
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.045;
  noiseSource.connect(noiseGain);

  const padGain = ctx.createGain();
  padGain.gain.value = 1;
  const stopFns = [];
  [110, 164.81, 220].forEach((f) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    osc.connect(g).connect(padGain);
    osc.start();
    stopFns.push(() => { try { osc.stop(); } catch (e) {} });
  });
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.12;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.15;
  lfo.connect(lfoGain).connect(padGain.gain);
  lfo.start();
  stopFns.push(() => { try { lfo.stop(); } catch (e) {} });

  const preGain = ctx.createGain();
  preGain.gain.value = 1;
  noiseGain.connect(preGain);
  padGain.connect(preGain);
  noiseSource.start();
  stopFns.push(() => { try { noiseSource.stop(); } catch (e) {} });

  return { outputNode: preGain, stopFns };
}

export default function CopperAndWax() {
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("now");
  const [tracks, setTracks] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [bands, setBands] = useState(PRESETS.Flat);
  const [activePreset, setActivePreset] = useState("Flat");
  const [importing, setImporting] = useState(false);

  const track = tracks.find((t) => t.id === currentId) || null;

  const dbRef = useRef(null);
  const audioElRef = useRef(null);
  const fileInputRef = useRef(null);
  const urlCacheRef = useRef({});

  const ctxRef = useRef(null);
  const graphModeRef = useRef("none"); // 'none' | 'demo' | 'real'
  const mediaSourceRef = useRef(null);
  const demoStopFnsRef = useRef([]);
  const filtersRef = useRef([]);
  const analyserRef = useRef(null);
  const masterGainRef = useRef(null);

  const rafRef = useRef(null);
  const specBarsRef = useRef([]);
  const vuBarsRef = useRef([]);

  // ---- load settings + library on mount ----
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (p.bands) setBands(p.bands);
          if (p.activePreset) setActivePreset(p.activePreset);
          if (typeof p.volume === "number") setVolume(p.volume);
        }
      } catch (e) {}
      try {
        const db = await openDB();
        dbRef.current = db;
        const all = await idbGetAll(db);
        all.sort((a, b) => a.createdAt - b.createdAt);
        setTracks(all);
        if (all.length > 0) setCurrentId(all[0].id);
      } catch (e) {
        console.error("db load failed", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ bands, activePreset, volume }));
    } catch (e) {}
  }, [bands, activePreset, volume, loaded]);

  function urlFor(t) {
    if (!urlCacheRef.current[t.id]) {
      urlCacheRef.current[t.id] = URL.createObjectURL(t.blob);
    }
    return urlCacheRef.current[t.id];
  }

  // ---- import files ----
  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setImporting(true);
    const db = dbRef.current || (await openDB());
    dbRef.current = db;
    const added = [];
    for (const file of files) {
      try {
        const dur = await new Promise((resolve) => {
          const tmp = new Audio();
          const u = URL.createObjectURL(file);
          tmp.src = u;
          tmp.onloadedmetadata = () => { resolve(tmp.duration || 0); URL.revokeObjectURL(u); };
          tmp.onerror = () => { resolve(0); URL.revokeObjectURL(u); };
        });
        const record = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: cleanTitle(file.name),
          artist: "On this device",
          duration: dur,
          hue: hashHue(file.name),
          createdAt: Date.now(),
          blob: file,
        };
        await idbPut(db, record);
        added.push(record);
      } catch (err) {
        console.error("import failed for", file.name, err);
      }
    }
    setTracks((prev) => {
      const next = [...prev, ...added];
      if (!currentId && next.length > 0) setCurrentId(next[0].id);
      return next;
    });
    setImporting(false);
    e.target.value = "";
  }

  async function deleteTrack(id) {
    const db = dbRef.current;
    if (db) await idbDelete(db, id);
    if (urlCacheRef.current[id]) {
      URL.revokeObjectURL(urlCacheRef.current[id]);
      delete urlCacheRef.current[id];
    }
    setTracks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (currentId === id) {
        setCurrentId(next.length > 0 ? next[0].id : null);
        setElapsed(0);
        setIsPlaying(false);
      }
      return next;
    });
  }

  // ---- ensure the correct graph (demo vs real) is wired up, called on play ----
  const ensureGraph = useCallback((desiredMode) => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctx();
    }
    const ctx = ctxRef.current;
    if (graphModeRef.current === desiredMode) return;

    // tear down demo graph if switching away from it
    if (graphModeRef.current === "demo") {
      demoStopFnsRef.current.forEach((fn) => fn());
      demoStopFnsRef.current = [];
      if (masterGainRef.current) masterGainRef.current.disconnect();
    }
    if (graphModeRef.current === "real" && masterGainRef.current) {
      masterGainRef.current.disconnect();
    }

    if (desiredMode === "demo") {
      const { outputNode, stopFns } = buildDemoSource(ctx);
      demoStopFnsRef.current = stopFns;
      const { filters, analyser, masterGain } = buildFilterChain(ctx, outputNode, bands, volume);
      filtersRef.current = filters;
      analyserRef.current = analyser;
      masterGainRef.current = masterGain;
    } else if (desiredMode === "real") {
      if (!mediaSourceRef.current) {
        mediaSourceRef.current = ctx.createMediaElementSource(audioElRef.current);
      }
      const { filters, analyser, masterGain } = buildFilterChain(ctx, mediaSourceRef.current, bands, volume);
      filtersRef.current = filters;
      analyserRef.current = analyser;
      masterGainRef.current = masterGain;
    }
    graphModeRef.current = desiredMode;
  }, [bands, volume]);

  const togglePlay = async () => {
    const desiredMode = tracks.length > 0 ? "real" : "demo";
    ensureGraph(desiredMode);
    const ctx = ctxRef.current;
    await ctx.resume();

    if (desiredMode === "real") {
      const el = audioElRef.current;
      if (!el.src && track) el.src = urlFor(track);
      if (isPlaying) { el.pause(); } else { el.play().catch(() => {}); }
    } else {
      if (isPlaying) { await ctx.suspend(); setIsPlaying(false); }
      else { await ctx.resume(); setIsPlaying(true); }
    }
  };

  // keep EQ + volume live on whichever chain is active
  useEffect(() => {
    filtersRef.current.forEach((f, i) => {
      if (f) f.gain.setTargetAtTime(bands[i], ctxRef.current?.currentTime || 0, 0.05);
    });
  }, [bands]);
  useEffect(() => {
    if (masterGainRef.current) {
      masterGainRef.current.gain.setTargetAtTime(volume, ctxRef.current?.currentTime || 0, 0.05);
    }
  }, [volume]);

  // audio element event wiring (real mode)
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setElapsed(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onEnded = () => {
      const idx = tracks.findIndex((t) => t.id === currentId);
      if (idx === -1) return;
      const next = tracks[(idx + 1) % tracks.length];
      setCurrentId(next.id);
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnded);
    };
  }, [tracks, currentId]);

  // when currentId changes, load the new src (and keep playing if we were)
  useEffect(() => {
    const el = audioElRef.current;
    if (!el || !track) return;
    const wasPlaying = isPlaying;
    el.src = urlFor(track);
    el.load();
    setElapsed(0);
    setDuration(track.duration || 0);
    if (wasPlaying && graphModeRef.current === "real") {
      el.play().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // spectrum + VU animation loop
  useEffect(() => {
    function tick() {
      const analyser = analyserRef.current;
      if (analyser && isPlaying) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const bars = specBarsRef.current;
        for (let i = 0; i < bars.length; i++) {
          const el = bars[i];
          if (!el) continue;
          const v = data[Math.min(data.length - 1, i + 2)] || 0;
          el.style.height = `${8 + (v / 255) * 100}%`;
        }
        const avg = data.reduce((a, b) => a + b, 0) / data.length / 255;
        const vus = vuBarsRef.current;
        if (vus[0]) vus[0].style.width = `${Math.min(100, avg * 120)}%`;
        if (vus[1]) vus[1].style.width = `${Math.min(100, avg * 105)}%`;
      } else {
        specBarsRef.current.forEach((el) => el && (el.style.height = "8%"));
        if (vuBarsRef.current[0]) vuBarsRef.current[0].style.width = "3%";
        if (vuBarsRef.current[1]) vuBarsRef.current[1].style.width = "3%";
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      if (ctxRef.current) ctxRef.current.close();
      Object.values(urlCacheRef.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  function selectTrack(id) { setCurrentId(id); }
  function skip(dir) {
    if (tracks.length === 0) return;
    const idx = tracks.findIndex((t) => t.id === currentId);
    const next = tracks[(idx + dir + tracks.length) % tracks.length];
    setCurrentId(next.id);
  }
  function applyPreset(name) { setBands(PRESETS[name]); setActivePreset(name); }
  function adjustBand(i, val) {
    setBands((prev) => { const next = [...prev]; next[i] = val; return next; });
    setActivePreset("Custom");
  }
  function seekTo(ratio) {
    const el = audioElRef.current;
    if (el && duration) { el.currentTime = ratio * duration; setElapsed(el.currentTime); }
  }
  function openPicker() { fileInputRef.current?.click(); }

  if (!loaded) {
    return (
      <Shell>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 10 }}>
          <Disc size={38} color="#e0975a" style={{ animation: "spin 2.5s linear infinite" }} />
          <div style={{ fontFamily: "Oswald, sans-serif", letterSpacing: 2, color: "#9c8f75", fontSize: 12 }}>WARMING UP THE DECK…</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <audio ref={audioElRef} style={{ display: "none" }} />
      <input ref={fileInputRef} type="file" accept="audio/*" multiple style={{ display: "none" }} onChange={handleFiles} />

      <div className="topbar">
        <span className="brand"><Disc size={15} /> COPPER &amp; WAX</span>
        <button className="add-btn" onClick={openPicker} disabled={importing}>
          <Upload size={13} /> {importing ? "Adding…" : "Add Songs"}
        </button>
      </div>

      <div className="scroll-area">
        {tab === "now" && (
          <NowPlaying
            track={track} isPlaying={isPlaying} elapsed={elapsed} duration={duration}
            volume={volume} setVolume={setVolume}
            onToggle={togglePlay} onSkip={skip} onSeek={seekTo}
            specBarsRef={specBarsRef} hasTracks={tracks.length > 0}
            onAdd={openPicker}
          />
        )}
        {tab === "library" && (
          <Library
            tracks={tracks} currentId={currentId} isPlaying={isPlaying}
            onSelect={selectTrack} onDelete={deleteTrack} onAdd={openPicker} importing={importing}
          />
        )}
        {tab === "eq" && (
          <Equalizer
            bands={bands} onAdjust={adjustBand}
            activePreset={activePreset} onPreset={applyPreset}
            vuBarsRef={vuBarsRef}
          />
        )}
      </div>

      {tab !== "now" && track && (
        <MiniPlayer track={track} isPlaying={isPlaying} onToggle={togglePlay} onOpen={() => setTab("now")} />
      )}

      <BottomNav tab={tab} setTab={setTab} />
      <GlobalStyle />
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="app-outer">
      <div className="app-frame">{children}</div>
    </div>
  );
}

// ---------- Now Playing ----------
function NowPlaying({ track, isPlaying, elapsed, duration, volume, setVolume, onToggle, onSkip, onSeek, specBarsRef, hasTracks, onAdd }) {
  if (!hasTracks || !track) {
    return (
      <div className="tab-pad now-pad">
        <div className="vinyl-wrap">
          <div className={"vinyl " + (isPlaying ? "spin" : "")}
            style={{ background: `radial-gradient(circle at 50% 50%, #191510 0 8%, #e0975a99 8.5% 9.5%, #191510 10% 20%, #e0975a55 20.5% 21.5%, #191510 22% 32%, #e0975a35 32.5% 33.2%, #191510 34% 100%)` }}>
            <div className="vinyl-label" style={{ background: `conic-gradient(from 90deg, #e0975a, #2a2319)` }}>
              <Music size={16} color="#14110c" />
            </div>
          </div>
        </div>
        <div className="track-info">
          <div className="track-title">No songs yet</div>
          <div className="track-artist">Add music from your phone to start listening</div>
        </div>
        <button className="big-add-btn" onClick={onAdd}><Upload size={16} /> Add Songs</button>

        <div className="section-title" style={{ marginTop: 26 }}><Activity size={15} /><span>Preview the EQ with a test tone</span></div>
        <div className="spectrum-row">
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className="spec-bar" ref={(el) => (specBarsRef.current[i] = el)} />
          ))}
        </div>
        <div className="controls-row" style={{ marginTop: 10 }}>
          <button className="play-btn" onClick={onToggle}>
            {isPlaying ? <Pause size={22} /> : <Play size={22} style={{ marginLeft: 3 }} />}
          </button>
        </div>
      </div>
    );
  }

  const pct = duration ? (elapsed / duration) * 100 : 0;
  return (
    <div className="tab-pad now-pad">
      <div className="vinyl-wrap">
        <div className={"vinyl " + (isPlaying ? "spin" : "")}
          style={{ background: `radial-gradient(circle at 50% 50%, #191510 0 8%, ${hueBg(track.hue,0.9)} 8.5% 9.5%, #191510 10% 20%, ${hueBg(track.hue,0.55)} 20.5% 21.5%, #191510 22% 32%, ${hueBg(track.hue,0.35)} 32.5% 33.2%, #191510 34% 100%)` }}
        >
          <div className="vinyl-label" style={{ background: `conic-gradient(from 90deg, ${hueBg(track.hue)}, #2a2319)` }}>
            <Music size={16} color="#14110c" />
          </div>
        </div>
        <div className={"tonearm " + (isPlaying ? "down" : "up")}>
          <div className="tonearm-stick" />
          <div className="tonearm-head" />
        </div>
      </div>

      <div className="track-info">
        <div className="track-title">{track.title}</div>
        <div className="track-artist">{track.artist}</div>
      </div>

      <div className="spectrum-row">
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="spec-bar" ref={(el) => (specBarsRef.current[i] = el)} />
        ))}
      </div>

      <div className="seek-row">
        <div
          className="seek-track"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek((e.clientX - rect.left) / rect.width);
          }}
        >
          <div className="seek-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="seek-times">
          <span>{fmtTime(elapsed)}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      <div className="controls-row">
        <button className="ctrl-btn" onClick={() => onSkip(-1)}><SkipBack size={20} /></button>
        <button className="play-btn" onClick={onToggle}>
          {isPlaying ? <Pause size={26} /> : <Play size={26} style={{ marginLeft: 3 }} />}
        </button>
        <button className="ctrl-btn" onClick={() => onSkip(1)}><SkipForward size={20} /></button>
      </div>

      <div className="volume-row">
        {volume === 0 ? <VolumeX size={15} color="#9c8f75" /> : <Volume2 size={15} color="#9c8f75" />}
        <input className="range-h" type="range" min="0" max="1" step="0.01" value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
      </div>
    </div>
  );
}

// ---------- Library ----------
function Library({ tracks, currentId, isPlaying, onSelect, onDelete, onAdd, importing }) {
  return (
    <div className="tab-pad">
      <div className="section-title-row">
        <div className="section-title" style={{ marginBottom: 0 }}><ListMusic size={15} /><span>Your Library ({tracks.length})</span></div>
        <button className="link-btn" onClick={onAdd} disabled={importing}><Upload size={13} /> {importing ? "Adding…" : "Add"}</button>
      </div>
      {tracks.length === 0 ? (
        <div className="empty-note">No songs added yet. Tap "Add" and pick audio files from your phone.</div>
      ) : (
        <div className="lib-list">
          {tracks.map((t) => {
            const active = t.id === currentId;
            return (
              <div key={t.id} className={"lib-item " + (active ? "active" : "")} onClick={() => onSelect(t.id)}>
                <div className="lib-art" style={{ background: `linear-gradient(155deg, ${hueBg(t.hue)}, #191510)` }}>
                  <Music size={14} color="rgba(255,255,255,0.85)" />
                </div>
                <div className="lib-mid">
                  <div className="lib-title">{t.title}</div>
                  <div className="lib-artist">{t.artist}</div>
                </div>
                {active && isPlaying ? (
                  <div className="playing-bars"><span /><span /><span /></div>
                ) : (
                  <div className="lib-dur">{fmtTime(t.duration)}</div>
                )}
                <button className="trash-btn" onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Equalizer ----------
function Equalizer({ bands, onAdjust, activePreset, onPreset, vuBarsRef }) {
  return (
    <div className="tab-pad">
      <div className="section-title"><SlidersHorizontal size={15} /><span>10-Band Equalizer</span></div>
      <div className="preset-row">
        {Object.keys(PRESETS).concat(activePreset === "Custom" ? ["Custom"] : []).map((name) => (
          <button key={name} className={"preset-chip " + (activePreset === name ? "active" : "")} onClick={() => name !== "Custom" && onPreset(name)}>
            {name}
          </button>
        ))}
      </div>
      <div className="eq-rack">
        {BANDS.map((freq, i) => (
          <div className="eq-strip" key={freq}>
            <span className="eq-db">{bands[i] > 0 ? `+${bands[i]}` : bands[i]}</span>
            <div className="eq-slider-wrap">
              <input type="range" min="-12" max="12" step="1" value={bands[i]} className="eq-slider" onChange={(e) => onAdjust(i, Number(e.target.value))} />
            </div>
            <span className="eq-freq">{freq >= 1000 ? `${freq / 1000}k` : freq}</span>
          </div>
        ))}
      </div>
      <div className="section-title" style={{ marginTop: 26 }}><Activity size={15} /><span>Output Level</span></div>
      <div className="vu-wrap">
        <div className="vu-row"><span>L</span><div className="vu-track"><div className="vu-fill" ref={(el) => (vuBarsRef.current[0] = el)} /></div></div>
        <div className="vu-row"><span>R</span><div className="vu-track"><div className="vu-fill" ref={(el) => (vuBarsRef.current[1] = el)} /></div></div>
      </div>
    </div>
  );
}

function MiniPlayer({ track, isPlaying, onToggle, onOpen }) {
  return (
    <div className="mini-player" onClick={onOpen}>
      <div className="mini-art" style={{ background: `linear-gradient(155deg, ${hueBg(track.hue)}, #191510)` }} />
      <div className="mini-mid">
        <div className="mini-title">{track.title}</div>
        <div className="mini-artist">{track.artist}</div>
      </div>
      <button className="mini-btn" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
        {isPlaying ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: 2 }} />}
      </button>
    </div>
  );
}

function BottomNav({ tab, setTab }) {
  const items = [
    { id: "now", label: "Now Playing", Icon: Disc },
    { id: "library", label: "Library", Icon: ListMusic },
    { id: "eq", label: "Equalizer", Icon: SlidersHorizontal },
  ];
  return (
    <div className="bottom-nav">
      {items.map(({ id, label, Icon }) => (
        <button key={id} className={"nav-btn " + (tab === id ? "active" : "")} onClick={() => setTab(id)}>
          <Icon size={19} /><span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap');

      .app-outer { width: 100%; min-height: 100vh; display: flex; justify-content: center; background: #0c0a06; font-family: 'Inter', sans-serif; }
      .app-frame { width: 100%; max-width: 430px; min-height: 100vh; background: radial-gradient(900px 400px at 50% -8%, rgba(224,151,90,0.12), transparent 60%), linear-gradient(180deg,#17140f 0%,#14110c 45%,#100d09 100%); position: relative; display: flex; flex-direction: column; color: #f5ecd8; overflow: hidden; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      .topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 10px; }
      .brand { display: flex; align-items: center; gap: 6px; font-family: 'Oswald', sans-serif; font-size: 13px; letter-spacing: 2px; color: #e0975a; }
      .add-btn { display: flex; align-items: center; gap: 5px; font-family: 'Inter', sans-serif; font-size: 11.5px; font-weight: 600; color: #14110c; background: linear-gradient(160deg,#f0b57a,#e0975a); border: none; padding: 6px 11px; border-radius: 20px; cursor: pointer; }
      .add-btn:disabled { opacity: 0.6; }

      .scroll-area { flex: 1; overflow-y: auto; padding-bottom: 100px; }
      .tab-pad { padding: 10px 18px 4px; }

      .section-title { display: flex; align-items: center; gap: 7px; font-family: 'Oswald', sans-serif; font-size: 13px; letter-spacing: 1px; color: #f5ecd8; margin-bottom: 14px; text-transform: uppercase; }
      .section-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
      .link-btn { display: flex; align-items: center; gap: 5px; background: none; border: 1px solid rgba(224,151,90,0.3); color: #f0b57a; font-size: 11.5px; font-weight: 600; padding: 5px 10px; border-radius: 20px; cursor: pointer; }
      .empty-note { color: #766b58; font-size: 12.5px; line-height: 1.6; }

      .now-pad { display: flex; flex-direction: column; align-items: center; padding-top: 12px; }
      .vinyl-wrap { position: relative; width: 210px; height: 210px; margin-bottom: 20px; }
      .vinyl { width: 210px; height: 210px; border-radius: 50%; box-shadow: 0 20px 50px rgba(0,0,0,0.55), inset 0 0 0 6px #100d09; display: flex; align-items: center; justify-content: center; }
      .vinyl.spin { animation: spin 7s linear infinite; }
      .vinyl-label { width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: inset 0 0 0 2px rgba(0,0,0,0.3); }
      .tonearm { position: absolute; top: -14px; right: -6px; width: 90px; height: 90px; transform-origin: 88px 8px; transition: transform 0.5s ease; }
      .tonearm.up { transform: rotate(-28deg); }
      .tonearm.down { transform: rotate(0deg); }
      .tonearm-stick { position: absolute; top: 6px; right: 6px; width: 6px; height: 78px; background: linear-gradient(180deg,#cabba0,#8a7c62); border-radius: 4px; }
      .tonearm-head { position: absolute; bottom: -2px; right: 0px; width: 16px; height: 10px; background: #e0975a; border-radius: 3px; }

      .track-info { text-align: center; margin-bottom: 14px; }
      .track-title { font-family: 'Oswald', sans-serif; font-size: 19px; font-weight: 600; }
      .track-artist { font-size: 12.5px; color: #9c8f75; margin-top: 3px; }

      .big-add-btn { display: flex; align-items: center; gap: 7px; background: linear-gradient(160deg,#f0b57a,#e0975a); color: #14110c; border: none; font-weight: 700; font-size: 13px; padding: 11px 20px; border-radius: 24px; cursor: pointer; margin-bottom: 6px; }

      .spectrum-row { display: flex; align-items: flex-end; gap: 3px; height: 44px; width: 100%; max-width: 260px; margin: 14px 0; }
      .spec-bar { flex: 1; height: 8%; background: linear-gradient(180deg,#f0b57a,#e0975a); border-radius: 3px 3px 0 0; transition: height 0.08s linear; }

      .seek-row { width: 100%; max-width: 280px; margin-bottom: 18px; }
      .seek-track { height: 5px; border-radius: 4px; background: #241f16; overflow: hidden; cursor: pointer; }
      .seek-fill { height: 100%; background: linear-gradient(90deg,#e0975a,#f0b57a); border-radius: 4px; }
      .seek-times { display: flex; justify-content: space-between; font-family: 'Space Mono', monospace; font-size: 10.5px; color: #9c8f75; margin-top: 6px; }

      .controls-row { display: flex; align-items: center; gap: 26px; margin-bottom: 20px; }
      .ctrl-btn { background: none; border: none; color: #f5ecd8; cursor: pointer; opacity: 0.85; }
      .play-btn { width: 60px; height: 60px; border-radius: 50%; border: none; cursor: pointer; background: linear-gradient(160deg,#f0b57a,#e0975a); color: #14110c; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 22px rgba(224,151,90,0.4); }
      .volume-row { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 220px; }
      .range-h { flex: 1; accent-color: #e0975a; }

      .lib-list { display: flex; flex-direction: column; gap: 8px; }
      .lib-item { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: #1e1911; border: 1px solid rgba(224,151,90,0.12); border-radius: 13px; padding: 10px 10px 10px 12px; cursor: pointer; color: #f5ecd8; }
      .lib-item.active { border-color: rgba(224,151,90,0.55); background: #241d13; }
      .lib-art { width: 40px; height: 40px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
      .lib-mid { flex: 1; min-width: 0; }
      .lib-title { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .lib-artist { font-size: 11px; color: #9c8f75; margin-top: 1px; }
      .lib-dur { font-family: 'Space Mono', monospace; font-size: 11px; color: #9c8f75; flex-shrink: 0; }
      .trash-btn { background: none; border: none; color: #766b58; padding: 4px; cursor: pointer; flex-shrink: 0; }
      .playing-bars { display: flex; align-items: flex-end; gap: 2px; height: 14px; }
      .playing-bars span { width: 3px; background: #e0975a; border-radius: 2px; animation: barPulse 0.9s ease-in-out infinite; }
      .playing-bars span:nth-child(1) { height: 6px; animation-delay: 0s; }
      .playing-bars span:nth-child(2) { height: 14px; animation-delay: 0.2s; }
      .playing-bars span:nth-child(3) { height: 9px; animation-delay: 0.4s; }
      @keyframes barPulse { 0%,100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }

      .preset-row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 22px; }
      .preset-chip { flex-shrink: 0; background: #1e1911; border: 1px solid rgba(224,151,90,0.2); color: #c9bda3; font-size: 12px; padding: 7px 13px; border-radius: 20px; cursor: pointer; white-space: nowrap; }
      .preset-chip.active { background: rgba(224,151,90,0.16); border-color: #e0975a; color: #f0b57a; font-weight: 600; }

      .eq-rack { display: flex; justify-content: space-between; background: #1a150e; border: 1px solid rgba(224,151,90,0.15); border-radius: 16px; padding: 18px 8px 14px; }
      .eq-strip { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 26px; }
      .eq-db { font-family: 'Space Mono', monospace; font-size: 9px; color: #9c8f75; }
      .eq-slider-wrap { height: 150px; display: flex; align-items: center; justify-content: center; }
      .eq-slider { width: 150px; height: 26px; transform: rotate(-90deg); accent-color: #e0975a; }
      .eq-freq { font-family: 'Space Mono', monospace; font-size: 9px; color: #9c8f75; }

      .vu-wrap { display: flex; flex-direction: column; gap: 10px; background: #1a150e; border: 1px solid rgba(224,151,90,0.15); border-radius: 14px; padding: 14px 16px; }
      .vu-row { display: flex; align-items: center; gap: 10px; font-family: 'Space Mono', monospace; font-size: 11px; color: #9c8f75; }
      .vu-track { flex: 1; height: 8px; border-radius: 4px; background: #241f16; overflow: hidden; }
      .vu-fill { height: 100%; width: 3%; background: linear-gradient(90deg,#4ecdc4,#e0975a 70%,#ff5c5c 92%); border-radius: 4px; transition: width 0.05s linear; }

      .mini-player { position: absolute; left: 10px; right: 10px; bottom: 70px; display: flex; align-items: center; gap: 10px; background: #211c15; border: 1px solid rgba(224,151,90,0.25); border-radius: 14px; padding: 8px 10px; cursor: pointer; z-index: 15; box-shadow: 0 8px 20px rgba(0,0,0,0.4); }
      .mini-art { width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0; }
      .mini-mid { flex: 1; min-width: 0; }
      .mini-title { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mini-artist { font-size: 10.5px; color: #9c8f75; }
      .mini-btn { width: 30px; height: 30px; border-radius: 50%; border: none; background: linear-gradient(160deg,#f0b57a,#e0975a); color: #14110c; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }

      .bottom-nav { position: absolute; bottom: 0; left: 0; right: 0; display: flex; background: rgba(20,17,12,0.95); border-top: 1px solid rgba(224,151,90,0.18); padding: 8px 6px 12px; backdrop-filter: blur(6px); z-index: 12; }
      .nav-btn { flex: 1; background: none; border: none; color: #766b58; display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 10.5px; cursor: pointer; padding: 4px 0; }
      .nav-btn.active { color: #f0b57a; }

      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-thumb { background: rgba(224,151,90,0.3); border-radius: 3px; }
    `}</style>
  );
}
