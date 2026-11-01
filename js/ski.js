// Lyžařský areál (prototyp, ?areal=pec): sjezdovky, vleky, turistické trasy a vrcholy přes obraz z kamery.
// Těžké počty (co je odkud vidět, obzor) dělá ski-worker.js jednou po změně polohy; tady se každý snímek jen
// promítají hotové body podle natočení kamery, které počítá C# stejně jako pro zbytek appky.

import * as accuracy from './ski-accuracy.js';

const EYE_METERS = 1.6;
const RECOMPUTE_METERS = 15;
const MAX_PISTE_LABELS = 24;
const COLORS = { novice: '#22a447', easy: '#1f6fe0', intermediate: '#e02424', advanced: '#111111', expert: '#111111', freeride: '#f08c00' };
const font = (size) => `bold ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

let dotnet = null;
let area = null;
let worker = null;
let lineOf = null;          // čára každého zhuštěného bodu
let runs = [];              // [od, do) bodů každé čáry
let layerIndex = 0;
let view = null;            // poslední výsledek workeru
let spotIndex = 0;
let gps = null;             // poslední poloha z GPS uvnitř areálu
let computedAt = null;      // kde se naposledy počítalo
let pending = false;
let button = null;
let lastCamera = null;

// Měření pro ladění plynulosti.
const frameTimes = [];
let drawMs = 0;

export async function init(dotnetRef, areaId, videoElement) {
    dotnet = dotnetRef;
    accuracy.init(dotnetRef, videoElement);
    area = await (await fetch(`data/ski/${areaId}.json`)).json();
    const heights = await (await fetch(`data/ski/${area.terrain.file}`)).arrayBuffer();

    worker = new Worker(new URL('ski-worker.js', import.meta.url));
    worker.onmessage = onWorker;
    worker.postMessage({ type: 'init', terrain: area.terrain, heights, lines: area.lines, peaks: area.peaks, guideposts: area.guideposts },
        [heights]);

    button = document.createElement('button');
    button.className = 'spot';
    button.addEventListener('click', () => {
        spotIndex = (spotIndex + 1) % area.spots.length;
        gps = null;
        updatePosition();
    });
    document.body.appendChild(button);

    const layers = document.createElement('button');
    layers.className = 'layers';
    layers.textContent = LAYERS[layerIndex].label;
    layers.addEventListener('click', () => {
        layerIndex = (layerIndex + 1) % LAYERS.length;
        layers.textContent = LAYERS[layerIndex].label;
    });
    document.body.appendChild(layers);

    if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(onGps, () => { }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    }
}

/** Natočení pro zkoušení na počítači bez senzorů: telefon svisle, směr podle ukázkového stanoviště. */
export function simulatedAngles() {
    const heading = area?.spots[spotIndex].heading ?? 0;
    return { alpha: (360 - heading) % 360, beta: 87, gamma: 0 };
}

function onGps(p) {
    const t = area.terrain;
    const inside = p.coords.latitude < t.north && p.coords.latitude > t.north - t.rows * t.stepLat
        && p.coords.longitude > t.west && p.coords.longitude < t.west + t.cols * t.stepLon;
    gps = inside ? { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy } : null;
    updatePosition();
}

function position() {
    if (gps)
        return { lat: gps.lat, lon: gps.lon, label: `GPS ±${Math.round(gps.accuracy)} m` };
    const spot = area.spots[spotIndex];
    return { lat: spot.lat, lon: spot.lon, label: spot.name };
}

function onWorker(e) {
    if (e.data.type === 'ready') {
        lineOf = e.data.lineOf;
        runs = [];
        let start = 0;
        for (let i = 1; i <= lineOf.length; i++) {
            if (i === lineOf.length || lineOf[i] !== lineOf[start]) {
                runs.push([start, i]);
                start = i;
            }
        }
        updatePosition();
        return;
    }

    pending = false;
    view = e.data;
    const p = position();
    dotnet.invokeMethod('SetObserver', computedAt.lat, computedAt.lon, view.eye, p.label);
    // Mezitím se poloha mohla pohnout dál.
    updatePosition();
}

function updatePosition() {
    if (!lineOf || !area)
        return;
    const p = position();
    button.textContent = gps ? `📍 ${p.label}` : `📍 ${p.label} ▸`;
    if (pending)
        return;
    if (computedAt && distance(computedAt, p) < RECOMPUTE_METERS)
        return;
    pending = true;
    computedAt = { lat: p.lat, lon: p.lon };
    worker.postMessage({ type: 'position', lat: p.lat, lon: p.lon, eye: EYE_METERS });
}

function distance(a, b) {
    const k = Math.PI / 180 * 6371000;
    return Math.hypot((a.lat - b.lat) * k, (a.lon - b.lon) * k * Math.cos(a.lat * Math.PI / 180));
}

/** Pro ladění z konzole prohlížeče: poslední póza kamery a výsledek výpočtu. */
export function debugState() {
    const horizonAt = (azimuth) => view && +(view.horizon[Math.round(azimuth / view.horizonStep) % view.horizon.length] * 180 / Math.PI).toFixed(3);
    return {
        camera: lastCamera, eye: view?.eye, ground: view?.ground, totalMs: view?.totalMs, linesMs: view?.linesMs,
        visiblePoints: view?.seen.reduce((a, b) => a + b, 0), points: lineOf?.length,
        peaks: view?.peaks.map(p => p.name),
        horizon: [180, 200, 220, 240, 260, 280, 300].map(a => [a, horizonAt(a)]),
    };
}

// ---------- Kreslení ----------

/**
 * Promítne a nakreslí areál. Kamera je póza z C# (azimut, výška pohledu, náklon) a vodorovný zorný úhel;
 * promítání odpovídá ScreenProjector v knihovně (dírková komora, čtvercové pixely).
 */
export function draw(ctx, camera, width, height) {
    lastCamera = camera;
    if (!view || !camera)
        return;
    const started = performance.now();
    const projector = makeProjector(camera, width, height);

    drawHorizon(ctx, projector, width);
    const { placed, typicalDistance } = drawLines(ctx, projector, width, height);
    drawGuideposts(ctx, projector, width, height, placed);
    drawPeaks(ctx, projector, width, height, placed);

    accuracy.update(camera, view, gps ? gps.accuracy : 0, typicalDistance, width, height);
    drawMs = drawMs * 0.9 + (performance.now() - started) * 0.1;
    drawStats(ctx, height);
}

function makeProjector(camera, width, height) {
    const d = Math.PI / 180;
    const az = camera.azimuth * d, el = camera.elevation * d, roll = camera.roll * d;
    const forward = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
    const levelRight = [Math.cos(az), -Math.sin(az), 0];
    const levelUp = cross(levelRight, forward);
    const right = levelRight.map((v, i) => v * Math.cos(roll) + levelUp[i] * Math.sin(roll));
    const up = levelUp.map((v, i) => v * Math.cos(roll) - levelRight[i] * Math.sin(roll));
    const focal = width / 2 / Math.tan(camera.horizontalFov * d / 2);
    const cx = width / 2, cy = height / 2;

    // Vrací [x, y, hloubka]; hloubka ≤ 0 = za kamerou.
    return (e, n, u) => {
        const depth = e * forward[0] + n * forward[1] + u * forward[2];
        return [cx + (e * right[0] + n * right[1] + u * right[2]) / depth * focal,
            cy - (e * up[0] + n * up[1] + u * up[2]) / depth * focal, depth];
    };
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Vypočtený obzor jako tenká žlutá čára: podle něj jde na první pohled poznat, jestli sedí směr. */
function drawHorizon(ctx, project, width) {
    const step = view.horizonStep * Math.PI / 180;
    ctx.beginPath();
    let pen = false;
    for (let a = 0; a <= view.horizon.length; a++) {
        const azimuth = (a % view.horizon.length) * step, elevation = view.horizon[a % view.horizon.length];
        const [x, y, depth] = project(Math.cos(elevation) * Math.sin(azimuth), Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation));
        if (depth < 0.05 || x < -width || x > 2 * width) {
            pen = false;
            continue;
        }
        if (pen)
            ctx.lineTo(x, y);
        else
            ctx.moveTo(x, y);
        pen = true;
    }
    ctx.strokeStyle = 'rgba(255, 210, 0, 0.9)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
}

// Barvy značek KČT a jak se vrstvy jmenují na tlačítku.
const TRAIL_COLORS = { red: '#d8232a', blue: '#1b5fbf', green: '#16924a', yellow: '#f2c200' };
const LAYERS = [
    { id: 'all', label: '⛷ + 🥾' },
    { id: 'ski', label: '⛷ sjezdovky' },
    { id: 'trails', label: '🥾 trasy' },
];

// Skryté úseky (za kopcem) jen do této vzdálenosti, dál už by to byla změť čar.
const HIDDEN_RANGE_METERS = 5000;

// Čáry těsně u pozorovatele se nekreslí: stojíš na nich. Úsek pár metrů vedle oka by se promítl skoro do výšky
// obzoru přes celou obrazovku a podle natočení telefonu by blikal (na Portáškách začíná sjezdovka u nohou).
const NEAR_HIDE_METERS = 50;
const MAX_GUIDEPOST_LABELS = 10;

/**
 * Čáry areálu. Viditelné úseky plně s bílým lemem, skryté za terénem čárkovaně a poloprůhledně, jako zadní hrany
 * rýsované krychle: cesta tam vede, jen není vidět. Stromy a budovy se neřeší, cestu nezakrývají „doopravdy“.
 * Vrací obdélníky umístěných popisků (ať se jim další vyhnou) a typickou vzdálenost čar v záběru.
 */
function drawLines(ctx, project, width, height) {
    const n = lineOf.length;
    const xs = new Float32Array(n), ys = new Float32Array(n), ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const [x, y, depth] = project(view.east[i], view.north[i], view.up[i]);
        if (depth < 5 || x < -width || x > 2 * width || y < -height || y > 2 * height)
            continue;
        xs[i] = x; ys[i] = y; ok[i] = 1;
    }

    // Typická vzdálenost toho, co je v záběru (pro odhad, jak moc vadí nepřesná GPS).
    const distances = [];
    for (let i = 0; i < n; i += 7)
        if (ok[i] && view.seen[i] && xs[i] > 0 && xs[i] < width && ys[i] > 0 && ys[i] < height)
            distances.push(Math.hypot(view.east[i], view.north[i]));
    distances.sort((a, b) => a - b);
    const typicalDistance = distances.length ? distances[distances.length >> 1] : 1500;

    // Každá čára se rozpadne na lomené čáry stejného stavu: viditelný úsek = oba konce vidět.
    const hidden = [], shown = [], labels = [];
    for (const [from, to] of runs) {
        const line = area.lines[lineOf[from]];
        if (!layerShows(line.kind))
            continue;
        const middle = (from + to) >> 1;
        const near = Math.hypot(view.east[middle], view.north[middle]);
        let current = null, state = null;
        for (let i = from; i < to - 1; i++) {
            const segmentSeen = view.seen[i] === 1 && view.seen[i + 1] === 1;
            const distance = Math.min(Math.hypot(view.east[i], view.north[i]), Math.hypot(view.east[i + 1], view.north[i + 1]));
            const usable = ok[i] && ok[i + 1] && distance >= NEAR_HIDE_METERS
                && (segmentSeen || distance < HIDDEN_RANGE_METERS);
            // Nová lomená čára i při změně tloušťky (blízké úseky sjezdovek jsou širší než vzdálené).
            if (!usable || segmentSeen !== state || (current && Math.round(pisteWidth(distance)) !== Math.round(pisteWidth(current.near))))
                current = null;
            if (!usable)
                continue;
            if (!current) {
                current = { line, near: distance, points: [xs[i], ys[i]] };
                (segmentSeen ? shown : hidden).push(current);
                state = segmentSeen;
            }
            current.points.push(xs[i + 1], ys[i + 1]);
        }

        if (line.kind === 'piste' && line.name) {
            const onScreen = [];
            for (let i = from; i < to; i++)
                if (ok[i] && view.seen[i] && xs[i] > 0 && xs[i] < width && ys[i] > 0 && ys[i] < height)
                    onScreen.push(i);
            if (onScreen.length > 3) {
                const i = onScreen[onScreen.length >> 1];
                labels.push({ text: line.name, x: xs[i], y: ys[i], distance: near, color: COLORS[line.difficulty] ?? '#8a8a8a' });
            }
        }
    }

    // Nejdřív skryté (vespod), pak viditelné; v obou trasy, vleky, sjezdovky.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 0.55;
    for (const kind of ['trail', 'lift', 'piste'])
        for (const p of hidden)
            if (p.line.kind === kind)
                strokeLine(ctx, p, false);
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    for (const kind of ['trail', 'lift', 'piste'])
        for (const p of shown)
            if (p.line.kind === kind)
                strokeLine(ctx, p, true);
    ctx.setLineDash([]);

    // Názvy sjezdovek: bližší mají přednost, překrývající se vynecháme.
    labels.sort((a, b) => a.distance - b.distance);
    const placed = [];
    ctx.font = font(13);
    for (const l of labels) {
        if (placed.length >= MAX_PISTE_LABELS)
            break;
        const box = { x: l.x + 6, y: l.y - 22, w: ctx.measureText(l.text).width, h: 16 };
        if (placed.some(b => overlaps(b, box)))
            continue;
        placed.push(box);
        outlined(ctx, l.text, box.x, box.y + 13, 13, l.color, 'left');
    }
    return { placed, typicalDistance };
}

function layerShows(kind) {
    const layer = LAYERS[layerIndex].id;
    return layer === 'all' || (layer === 'trails') === (kind === 'trail');
}

function strokeLine(ctx, polyline, visible) {
    const { line, near, points } = polyline;
    if (line.kind === 'trail') {
        // Souběžné trasy jako pruhy vedle sebe, jako na mapách KČT; v obraze odsazené kolmo na čáru.
        const stripe = visible ? 3 : 2;
        const colors = line.colors;
        if (visible)
            path(ctx, points, 'rgba(255,255,255,0.85)', stripe * colors.length + 3, null);
        colors.forEach((c, k) => {
            const shift = (k - (colors.length - 1) / 2) * stripe;
            path(ctx, shift ? offset(points, shift) : points, TRAIL_COLORS[c], stripe, visible ? null : [7, 5]);
        });
    } else if (line.kind === 'lift') {
        if (visible)
            path(ctx, points, 'rgba(255,255,255,0.85)', 5, null);
        path(ctx, points, '#2b2b2b', visible ? 2 : 1.5, visible ? null : [4, 5]);
    } else {
        const w = pisteWidth(near);
        if (visible)
            path(ctx, points, 'rgba(255,255,255,0.85)', w + 3, null);
        path(ctx, points, COLORS[line.difficulty] ?? '#8a8a8a', visible ? w : Math.max(2, w * 0.6), visible ? null : [9, 6]);
    }
}

/** Šířka sjezdovky v bodech obrazovky podle vzdálenosti: zblízka 6, od 3 km 2,5. */
function pisteWidth(distance) {
    return Math.max(2.5, Math.min(6, 7 - distance / 700));
}

function path(ctx, points, color, lineWidth, dash) {
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2)
        ctx.lineTo(points[i], points[i + 1]);
    ctx.setLineDash(dash ?? []);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
}

/** Lomená čára posunutá kolmo o daný počet bodů obrazovky (normála ze sousedních bodů). */
function offset(points, distance) {
    const out = new Array(points.length);
    const count = points.length / 2;
    for (let k = 0; k < count; k++) {
        const a = Math.max(0, k - 1) * 2, b = Math.min(count - 1, k + 1) * 2;
        const dx = points[b] - points[a], dy = points[b + 1] - points[a + 1];
        const length = Math.hypot(dx, dy) || 1;
        out[2 * k] = points[2 * k] - dy / length * distance;
        out[2 * k + 1] = points[2 * k + 1] + dx / length * distance;
    }
    return out;
}

/** Rozcestníky: žlutá cedulka s názvem, nejbližší mají přednost; jen když jsou zapnuté trasy. */
function drawGuideposts(ctx, project, width, height, placed) {
    if (LAYERS[layerIndex].id === 'ski')
        return;
    let shown = 0;
    for (const g of [...view.guideposts].sort((a, b) => a.distance - b.distance)) {
        if (shown >= MAX_GUIDEPOST_LABELS)
            break;
        const [x, y, depth] = project(g.east, g.north, g.up);
        if (depth < 20 || x < 0 || x > width || y < 0 || y > height)
            continue;
        ctx.font = font(12);
        const box = { x: x + 7, y: y - 16, w: ctx.measureText(g.name).width, h: 15 };
        if (placed.some(b => overlaps(b, box)))
            continue;
        placed.push(box);
        shown++;
        ctx.fillStyle = '#f2c200';
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth = 1.5;
        ctx.fillRect(x - 4, y - 8, 8, 6);
        ctx.strokeRect(x - 4, y - 8, 8, 6);
        ctx.beginPath();
        ctx.moveTo(x, y - 2);
        ctx.lineTo(x, y + 4);
        ctx.stroke();
        outlined(ctx, g.name, box.x, y - 4, 12, '#3a3a3a', 'left');
    }
}

function drawPeaks(ctx, project, width, height, placed) {
    const sorted = [...view.peaks].sort((a, b) => (b.ele || 0) - (a.ele || 0));
    for (const p of sorted) {
        const [x, y, depth] = project(p.east, p.north, p.up);
        if (depth < 50 || x < 0 || x > width || y < 0 || y > height)
            continue;
        const text = p.ele ? `${p.name} ${Math.round(p.ele)} m` : p.name;
        ctx.font = font(13);
        const w = ctx.measureText(text).width;
        const box = { x: x - w / 2, y: y - 40, w, h: 18 };
        if (placed.some(b => overlaps(b, box)))
            continue;
        placed.push(box);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x, y - 22);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 3); ctx.lineTo(x - 5, y + 3); ctx.closePath();
        ctx.fillStyle = '#5b3a1e';
        ctx.fill();
        outlined(ctx, text, x, y - 26, 13, '#1a1a1a', 'center');
    }
}

function drawStats(ctx, height) {
    const now = performance.now();
    frameTimes.push(now);
    while (frameTimes.length && frameTimes[0] < now - 1000)
        frameTimes.shift();
    const lines = [
        `${frameTimes.length} fps · kreslení ${drawMs.toFixed(1)} ms`,
        `výpočet polohy ${Math.round(view.totalMs)} ms (čáry ${Math.round(view.linesMs)} ms, ${lineOf.length} bodů)`,
    ];
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, height - 100, Math.max(...lines.map(l => ctx.measureText(l).width)) + 12, 38);
    ctx.fillStyle = '#fff';
    lines.forEach((line, i) => ctx.fillText(line, 14, height - 86 + i * 17));
}

function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function outlined(ctx, text, x, baseline, size, color, align) {
    ctx.font = font(size);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 4;
    ctx.strokeText(text, x, baseline);
    ctx.fillStyle = color;
    ctx.fillText(text, x, baseline);
}
