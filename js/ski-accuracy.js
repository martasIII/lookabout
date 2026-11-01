// Přesnost scény a automatická kalibrace podle obzoru (prototyp lyžařského areálu).
//
// Kalibrace: z obrazu kamery se vytáhne obzor (přechod obloha → terén v každém sloupci) a porovná se s obzorem
// vypočteným z terénu. Hledá se posun směru, při kterém sedí nejvíc sloupců; náklon se dorovná mediánem. Výsledek
// se použije jen při jasné shodě, jinak zůstává kompas. Vyzkoušeno na snímku z Mapy.cz: z kompasu vedle o ±20°
// se směr vrátil na ±0,5°.
//
// Přesnost: odhad chyby ve stupních ze směru (kompas, kalibrace a jak dávno byla) a z polohy (GPS převedená na úhel
// pro typickou vzdálenost toho, co je v záběru). Ukazuje se jako barevná tečka vpravo nahoře.

const SAMPLE_WIDTH = 160;               // obraz pro hledání obzoru: malý, ať je to rychlé
const ATTEMPT_EVERY_MS = 1000;
const SEARCH_DEGREES = 25;
const SEARCH_STEP = 0.1;
const FIT_TOLERANCE = 0.35;             // sloupec „sedí“, když se liší do tolika stupňů
const MIN_FIT = 0.35;                   // aspoň tolik sloupců musí sedět
const MAX_RIVAL = 0.85;                 // nejlepší shoda jinde (dál než 3°) musí být znatelně horší

const COMPASS_SIGMA = 10;               // kompas v telefonu běžně ±5–15°
const MANUAL_SIGMA = 1.5;               // tažení prstem na vrchol
const DRIFT_PER_MINUTE = 0.5;           // gyroskop pomalu ujíždí
const DRIFT_PER_TURNED_DEGREE = 0.01;   // a víc, když se s telefonem hodně točí

const LEVELS = [
    { max: 1, color: '#2e9d4c', symbol: '✓', name: 'přesné' },
    { max: 4, color: '#e0b000', symbol: '~', name: 'zhruba' },
    { max: 12, color: '#d8402e', symbol: '!', name: 'nepřesné' },
    { max: Infinity, color: '#1a1a1a', symbol: '✕', name: 'mimo' },
];
const LEVEL_SETTLE_MS = 1500;           // barva se změní, až nová platí chvíli: na hranici by blikala

let dotnet = null;
let video = null;
let sample = null;
let sampleCtx = null;
let dot = null;
let detail = null;

let calibratedAt = null;    // kdy a jak přesně se naposledy kalibrovalo
let calibrationSigma = 0;
let source = null;          // 'obzor' | 'ruční' | null
let turned = 0;             // o kolik stupňů se od kalibrace telefonem otočilo
let wasCalibrated = false;
let expectLock = false;     // kalibraci podle obzoru C# ohlásí jako zámek; nesmí se splést s tažením
let lastAzimuth = null;
let recentPoses = [];
let lastAttempt = 0;
let lastOutcome = 'zatím nic';
let pendingJump = null;     // velká oprava se přijme, až ji potvrdí druhý pokus

let shownLevel = 3;
let candidateLevel = 3;
let candidateSince = 0;
let lastSigma = Infinity;
let lastReason = '';
let lastGps = null;

export function init(dotnetRef, videoElement) {
    dotnet = dotnetRef;
    video = videoElement;
    sample = document.createElement('canvas');
    sampleCtx = sample.getContext('2d', { willReadFrequently: true });

    dot = document.createElement('button');
    dot.className = 'accuracy';
    dot.setAttribute('aria-label', 'Přesnost');
    dot.addEventListener('click', () => detail.hidden = !detail.hidden);
    document.body.appendChild(dot);

    detail = document.createElement('div');
    detail.className = 'accuracy-detail';
    detail.hidden = true;
    detail.addEventListener('click', () => detail.hidden = true);
    document.body.appendChild(detail);
    render(performance.now());
}

/**
 * Každý snímek: sleduje kalibraci a otáčení, občas zkusí kalibraci podle obzoru a aktualizuje tečku.
 * @param gpsAccuracy přesnost polohy v metrech (ukázkové stanoviště 0), null = bez polohy
 * @param typicalDistance typická vzdálenost toho, co je v záběru (m)
 */
export function update(camera, view, gpsAccuracy, typicalDistance, width, height) {
    const now = performance.now();
    lastGps = gpsAccuracy;

    if (lastAzimuth !== null)
        turned += Math.abs(((camera.azimuth - lastAzimuth) % 360 + 540) % 360 - 180);
    lastAzimuth = camera.azimuth;

    // Zámek bez naší kalibrace = uživatel táhl prstem.
    if (camera.calibrated && !wasCalibrated && !expectLock)
        calibrated(now, MANUAL_SIGMA, 'ruční');
    wasCalibrated = camera.calibrated;
    if (camera.calibrated)
        expectLock = false;

    recentPoses.push({ t: now, az: camera.azimuth, el: camera.elevation });
    while (recentPoses.length && recentPoses[0].t < now - 400)
        recentPoses.shift();

    if (now - lastAttempt > ATTEMPT_EVERY_MS && view && video?.videoWidth) {
        lastAttempt = now;
        if (!isStill())
            lastOutcome = 'čekám, až telefon chvíli podržíš';
        else if (Math.abs(camera.elevation) > 30)
            lastOutcome = 'namiř k obzoru';
        else
            attempt(camera, view, width, height, now);
    }

    // Odhad chyby.
    let headingSigma, reason = '';
    if (source) {
        headingSigma = calibrationSigma + DRIFT_PER_MINUTE * (now - calibratedAt) / 60000 + DRIFT_PER_TURNED_DEGREE * turned;
    } else if (camera.hasCompass) {
        headingSigma = COMPASS_SIGMA;
    } else {
        headingSigma = Infinity;
        reason = 'telefon nedává kompas';
    }
    let positionSigma = 0;
    if (gpsAccuracy === null) {
        positionSigma = Infinity;
        reason = 'čekám na polohu';
    } else if (gpsAccuracy > 0) {
        positionSigma = Math.atan(gpsAccuracy / Math.max(100, typicalDistance)) * 180 / Math.PI;
    }
    let sigma = Math.hypot(headingSigma, positionSigma);
    if (Math.abs(camera.elevation) > 45) {
        sigma = Infinity;
        reason = 'telefon míří do země nebo do nebe';
    }
    lastSigma = sigma;
    lastReason = reason;

    // Barva s prodlevou, ať na hranici nebliká.
    const level = LEVELS.findIndex(l => sigma <= l.max);
    if (level !== candidateLevel) {
        candidateLevel = level;
        candidateSince = now;
    }
    if (candidateLevel !== shownLevel && now - candidateSince > LEVEL_SETTLE_MS)
        shownLevel = candidateLevel;
    render(now);
}

function calibrated(now, sigma, how) {
    calibratedAt = now;
    calibrationSigma = sigma;
    source = how;
    turned = 0;
}

function isStill() {
    if (recentPoses.length < 5)
        return false;
    const az = recentPoses.map(p => p.az), el = recentPoses.map(p => p.el);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    return spread(az) < 0.6 && spread(el) < 0.6;
}

// ---------- Kalibrace podle obzoru ----------

function attempt(camera, view, width, height, now) {
    const skyline = cameraSkyline(width, height);
    if (typeof skyline === 'string') {
        lastOutcome = skyline;
        return;
    }

    // Sloupce obrazu → směr a výška nad obzorem podle současné pózy.
    const unproject = makeUnprojector(camera, width, height);
    const azimuths = [], elevations = [];
    for (const { x, y } of skyline) {
        const [az, el] = unproject(x, y);
        azimuths.push(az);
        elevations.push(el);
    }
    const terrainAt = (az) => {
        const step = view.horizonStep, n = view.horizon.length;
        const f = ((az % 360) + 360) % 360 / step, i = Math.floor(f) % n, t = f - Math.floor(f);
        return (view.horizon[i] * (1 - t) + view.horizon[(i + 1) % n] * t) * 180 / Math.PI;
    };

    // Plochý obzor neurčí směr (sedí všude stejně).
    const here = azimuths.map(terrainAt);
    const mean = here.reduce((a, b) => a + b, 0) / here.length;
    if (Math.sqrt(here.reduce((a, b) => a + (b - mean) ** 2, 0) / here.length) < 0.25) {
        lastOutcome = 'obzor tady nemá výrazný tvar';
        return;
    }

    const { shift, pitch, peak, rival, halfWidth } = matchHorizon(azimuths, elevations, terrainAt);

    // Na snímku z Mapy.cz správná shoda sedí 38–52 % sloupců (zbytek stromy a popředí) a soupeř je o 15–30 % horší.
    if (peak < MIN_FIT || rival > peak * MAX_RIVAL || halfWidth > 3 || Math.abs(pitch) > 6) {
        lastOutcome = `obzor nejistý (sedí ${Math.round(peak * 100)} %, jinde ${Math.round(rival * 100)} %)`;
        return;
    }

    // Větší opravu přijmeme, až ji potvrdí i další pokus: falešná shoda by scénu přehodila.
    if (Math.abs(shift) > 3) {
        if (!pendingJump || Math.abs(pendingJump - shift) > 1) {
            pendingJump = shift;
            lastOutcome = `obzor ukazuje posun ${shift.toFixed(1)}°, ověřuji`;
            return;
        }
    }
    pendingJump = null;

    expectLock = true;
    dotnet.invokeMethod('CalibrateBy', shift, pitch);
    calibrated(now, halfWidth, 'obzor');
    lastOutcome = `podle obzoru: oprava ${shift >= 0 ? '+' : ''}${shift.toFixed(1)}°, sedí ${Math.round(peak * 100)} % sloupců`;
}

/**
 * Porovnání obzorů: posun směru, při kterém sedí nejvíc sloupců (náklon se pro každý posun dorovná mediánem).
 * Vrací i jistotu: šířku vrcholu (polovinu, ve stupních) a nejlepší shodu jinde než ±3° od vítěze.
 */
export function matchHorizon(azimuths, elevations, terrainAt) {
    const shifts = [], scores = [], pitches = [];
    const diffs = new Float64Array(azimuths.length);
    for (let d = -SEARCH_DEGREES; d <= SEARCH_DEGREES + 1e-9; d += SEARCH_STEP) {
        for (let i = 0; i < azimuths.length; i++)
            diffs[i] = terrainAt(azimuths[i] + d) - elevations[i];
        const pitch = median(diffs);
        let fit = 0;
        for (let i = 0; i < diffs.length; i++)
            if (Math.abs(diffs[i] - pitch) < FIT_TOLERANCE)
                fit++;
        shifts.push(d);
        scores.push(fit / diffs.length);
        pitches.push(pitch);
    }

    const best = scores.indexOf(Math.max(...scores));
    const peak = scores[best];
    const near = shifts.filter((_, i) => scores[i] >= peak * 0.8);
    return {
        shift: shifts[best],
        pitch: pitches[best],
        peak,
        rival: Math.max(0, ...scores.filter((_, i) => Math.abs(shifts[i] - shifts[best]) > 3)),
        halfWidth: Math.max(0.3, (Math.max(...near) - Math.min(...near)) / 2),
    };
}

/**
 * Obzor v obraze kamery: [{x, y}] v bodech obrazovky, nebo důvod, proč ho najít nejde. Obloha = světlé a spíš modré
 * (hranice světlosti podle Otsua pro celý snímek); obzor = první řádek, pod kterým jsou aspoň 3 body terénu.
 */
function cameraSkyline(width, height) {
    const sw = SAMPLE_WIDTH, sh = Math.round(SAMPLE_WIDTH * height / width);
    sample.width = sw;
    sample.height = sh;

    // Náhled vyplňuje obrazovku a přesahy ořezává (object-fit: cover): vezme se jen ta viditelná část.
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(width / vw, height / vh);
    const sx = (vw - width / scale) / 2, sy = (vh - height / scale) / 2;
    sampleCtx.drawImage(video, sx, sy, width / scale, height / scale, 0, 0, sw, sh);
    const data = sampleCtx.getImageData(0, 0, sw, sh).data;

    const skyness = new Float32Array(sw * sh);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < sw * sh; i++) {
        const r = data[4 * i], g = data[4 * i + 1], b = data[4 * i + 2];
        const v = Math.max(0, Math.min(255, 0.3 * r + 0.55 * g + 0.15 * b + 0.5 * (b - r)));
        skyness[i] = v;
        histogram[v | 0]++;
    }
    const threshold = otsu(histogram, sw * sh);

    let skySum = 0, skyCount = 0, groundSum = 0, groundCount = 0;
    for (let i = 0; i < skyness.length; i++) {
        if (skyness[i] > threshold) { skySum += skyness[i]; skyCount++; }
        else { groundSum += skyness[i]; groundCount++; }
    }
    if (!skyCount || !groundCount || skySum / skyCount - groundSum / groundCount < 35)
        return 'málo kontrastu mezi oblohou a terénem';

    const points = [];
    for (let x = 0; x < sw; x++) {
        if (skyness[x] <= threshold)
            continue;                      // nahoře není obloha (strom, střecha): sloupec vynechat
        let run = 0;
        for (let y = 1; y < sh; y++) {
            run = skyness[y * sw + x] <= threshold ? run + 1 : 0;
            if (run === 3) {
                const row = y - 2;
                if (row > 2 && row < sh - 3)
                    points.push({ x: (x + 0.5) * width / sw, y: row * height / sh });
                break;
            }
        }
    }
    if (points.length < sw * 0.35)
        return 'obzor vidět jen v malé části obrazu';
    return points;
}

function otsu(histogram, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++)
        sum += i * histogram[i];
    let sumB = 0, weightB = 0, best = 0, threshold = 128;
    for (let i = 0; i < 256; i++) {
        weightB += histogram[i];
        if (!weightB)
            continue;
        const weightF = total - weightB;
        if (!weightF)
            break;
        sumB += i * histogram[i];
        const between = weightB * weightF * (sumB / weightB - (sum - sumB) / weightF) ** 2;
        if (between > best) {
            best = between;
            threshold = i;
        }
    }
    return threshold;
}

/** Bod obrazovky → [azimut, výška nad obzorem] ve stupních; stejně jako ScreenProjector.Unproject v knihovně. */
export function makeUnprojector(camera, width, height) {
    const d = Math.PI / 180;
    const az = camera.azimuth * d, el = camera.elevation * d, roll = camera.roll * d;
    const forward = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
    const levelRight = [Math.cos(az), -Math.sin(az), 0];
    const levelUp = [
        levelRight[1] * forward[2] - levelRight[2] * forward[1],
        levelRight[2] * forward[0] - levelRight[0] * forward[2],
        levelRight[0] * forward[1] - levelRight[1] * forward[0],
    ];
    const right = levelRight.map((v, i) => v * Math.cos(roll) + levelUp[i] * Math.sin(roll));
    const up = levelUp.map((v, i) => v * Math.cos(roll) - levelRight[i] * Math.sin(roll));
    const tanH = Math.tan(camera.horizontalFov * d / 2), tanV = tanH * height / width;
    return (x, y) => {
        const sx = (2 * x / width - 1) * tanH, sy = (1 - 2 * y / height) * tanV;
        const v = forward.map((f, i) => f + right[i] * sx + up[i] * sy);
        const length = Math.hypot(v[0], v[1], v[2]);
        return [(Math.atan2(v[0], v[1]) / d + 360) % 360, Math.asin(v[2] / length) / d];
    };
}

function median(values) {
    const sorted = Float64Array.from(values).sort();
    const m = sorted.length >> 1;
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// ---------- Tečka a vysvětlení ----------

function render(now) {
    const level = LEVELS[shownLevel];
    dot.style.background = level.color;
    dot.textContent = level.symbol;
    if (detail.hidden)
        return;

    const lines = [];
    lines.push(isFinite(lastSigma) ? `Přesnost ±${lastSigma < 2 ? lastSigma.toFixed(1) : Math.round(lastSigma)}° (${level.name})`
        : `Přesnost: ${level.name}${lastReason ? ' – ' + lastReason : ''}`);
    lines.push(source
        ? `Kalibrace ${source === 'obzor' ? 'podle obzoru' : 'tažením'} před ${formatAge(now - calibratedAt)}`
        : 'Bez kalibrace, směr jen z kompasu');
    lines.push(lastGps === null ? 'Poloha: čekám' : lastGps === 0 ? 'Poloha: ukázkové stanoviště' : `GPS ±${Math.round(lastGps)} m`);
    lines.push(`Obzor z kamery: ${lastOutcome}`);
    if (shownLevel > 0)
        lines.push('Tip: namiř na hory s výrazným obzorem a chvilku drž, nebo táhni prstem popisky na skutečná místa.');
    detail.textContent = lines.join('\n');
}

function formatAge(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}
