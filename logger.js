// Records everything a smart cube sends over Bluetooth, for the rubiks-move-recognition dataset.
//
// Two layers are logged side by side:
// - GATT: every notification, write and read, as raw bytes with the host time. Decoding happens
//   offline (Python), so a fixed decoder can re-read old logs.
// - EVENT: what smartcube-web-bluetooth decoded (moves, cube states, battery), to check the
//   offline decoder against and to show progress on the page.
// The library does the protocol work that must happen live: handshakes, ACKs, finding the MAC.

import { connectSmartCube } from './vendor/smartcube-web-bluetooth.js';

const FORMAT = 'cube-logger/1';
const LOGGER_VERSION = '0.1.0';
const LIBRARY = 'poliva/smartcube-web-bluetooth@2077416d6c828ec926dee424cf1bbfe4c0f25a47';
const SOLVED = ['U', 'R', 'F', 'D', 'L', 'B'].map(face => face.repeat(9)).join('');
const AUTOSAVE_KEY = 'cube-logger:current';
const PREVIOUS_KEY = 'cube-logger:previous';
const AUTOSAVE_EVERY_MS = 10_000;
const SHOWN_MOVES = 24;
const TEST_MOVES = 8;              // moves the connection test waits for
const TEST_SILENCE_MS = 60_000;    // no move at all within this time fails the test

const records = [];       // every line after META, in arrival order
const connections = [];   // one entry per successful connection; goes into META
let savedCount = 0;       // records already in a downloaded file
let conn = null;
let moveCount = 0;
let lastMoves = [];
let lastMoveMs = null;
let connectedMs = null;
let wakeLock = null;
let test = null;          // connection test: { from: first record index, startMs, done }

const $ = id => document.getElementById(id);

// --- time and bytes -----------------------------------------------------------------------

const round3 = x => Math.round(x * 1000) / 1000;

/** Host times of an event: wall clock (Unix ms) and monotonic (ms since page load), both in µs steps. */
function hostTimes(monoMs = performance.now()) {
    return { host_wall_ms: round3(performance.timeOrigin + monoMs), host_mono_ms: round3(monoMs) };
}

/** Hex string of an ArrayBuffer or any view of one (DataView, Uint8Array...). */
function hex(data) {
    const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function utcStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// --- raw GATT capture -----------------------------------------------------------------------

/**
 * Wrap the GATT characteristic methods the library uses, so that every byte in or out is logged
 * before the library sees it. Returns false where Web Bluetooth has no such class (e.g. some iOS
 * browsers): then only decoded events are logged.
 */
function tapGatt() {
    if (typeof BluetoothRemoteGATTCharacteristic === 'undefined') return false;
    const proto = BluetoothRemoteGATTCharacteristic.prototype;
    const tapped = new WeakSet();

    const log = (op, characteristic, data, monoMs) => records.push({
        type: 'GATT', op,
        service: characteristic.service?.uuid ?? null,
        char: characteristic.uuid,
        raw: hex(data),
        ...hostTimes(monoMs),
    });
    // event.timeStamp is when the notification arrived, before any queued JavaScript ran.
    const onNotify = event => log('notify', event.target, event.target.value, event.timeStamp);

    const startNotifications = proto.startNotifications;
    proto.startNotifications = function (...args) {
        if (!tapped.has(this)) {
            tapped.add(this);
            this.addEventListener('characteristicvaluechanged', onNotify);
        }
        return startNotifications.apply(this, args);
    };
    for (const name of ['writeValue', 'writeValueWithResponse', 'writeValueWithoutResponse']) {
        const original = proto[name];
        if (!original) continue;
        proto[name] = function (value, ...rest) {
            log('write', this, value);
            return original.call(this, value, ...rest);
        };
    }
    const readValue = proto.readValue;  // GAN Gen1 is polled instead of notifying
    proto.readValue = async function (...args) {
        const value = await readValue.apply(this, args);
        log('read', this, value);
        return value;
    };
    return true;
}

const rawCapture = tapGatt();

// --- the log file ---------------------------------------------------------------------------

function buildFile() {
    const meta = {
        type: 'META',
        format: FORMAT,
        logger_version: LOGGER_VERSION,
        library: LIBRARY,
        raw_capture: rawCapture,
        user_agent: navigator.userAgent,
        time_origin_ms: performance.timeOrigin,
        connections,
        saved_wall_ms: Date.now(),
    };
    return [meta, ...records].map(r => JSON.stringify(r)).join('\n') + '\n';
}

function fileName() {
    const first = connections[0];
    const device = (first?.device ?? 'cube').replace(/[^A-Za-z0-9_-]+/g, '-');
    return `${utcStamp(first?.host_wall_ms ?? Date.now())}_${device}.jsonl`;
}

function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function save() {
    download(buildFile(), fileName());
    savedCount = records.length;
    autosave();
    render();
}

/** Keep a copy in the browser in case the tab is closed or crashes before saving. */
function autosave() {
    if (records.length === 0) return;
    try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
            name: fileName(), saved: savedCount === records.length, text: buildFile(),
        }));
    } catch {
        // Full or blocked storage: the copy is a convenience, the download is what counts.
    }
}

/** On page load, the last session's copy becomes "previous", offered only if it was never saved. */
function offerPrevious() {
    try {
        const current = localStorage.getItem(AUTOSAVE_KEY);
        if (current) {
            localStorage.setItem(PREVIOUS_KEY, current);
            localStorage.removeItem(AUTOSAVE_KEY);
        }
        const previous = JSON.parse(localStorage.getItem(PREVIOUS_KEY) ?? 'null');
        if (!previous || previous.saved) return;
        $('previous').hidden = false;
        $('save-previous').onclick = () => {
            download(previous.text, previous.name);
            localStorage.setItem(PREVIOUS_KEY, JSON.stringify({ ...previous, saved: true }));
            $('previous').hidden = true;
        };
    } catch {
        // No storage: nothing to offer.
    }
}

// --- connection -----------------------------------------------------------------------------

/** Called by the library only when it could not find the MAC itself (isFallbackCall). */
async function askMac(device, isFallbackCall) {
    if (!isFallbackCall) return null;
    const mac = prompt(
        `Nie udało się odczytać adresu MAC kostki ${device.name ?? ''}.\n\n` +
        'Wpisz go (np. AB:12:34:56:78:9A). Znajdziesz go, otwierając w nowej karcie ' +
        'chrome://bluetooth-internals → Devices → Start scan.\n\n' +
        'Albo włącz chrome://flags → "Experimental Web Platform features", uruchom Chrome ponownie ' +
        'i połącz jeszcze raz.');
    return mac?.trim() || null;
}

async function connect() {
    $('connect').disabled = true;
    status('Łączenie…');
    try {
        conn = await connectSmartCube({
            enableAddressSearch: true,
            macAddressProvider: askMac,
            onStatus: message => status(message),
        });
    } catch (error) {
        conn = null;
        status(`Nie udało się połączyć: ${error.message}`, 'error');
        $('connect').disabled = false;
        return;
    }
    const info = {
        device: conn.deviceName,
        mac: conn.deviceMAC || null,
        protocol: conn.protocol,
        capabilities: conn.capabilities,
        ...hostTimes(),
    };
    connections.push(info);
    records.push({ type: 'MARK', what: 'connected', device: info.device, ...hostTimes() });
    connectedMs ??= performance.now();
    conn.events$.subscribe(onCubeEvent);
    for (const [capability, command] of [['hardware', 'REQUEST_HARDWARE'], ['battery', 'REQUEST_BATTERY'],
                                         ['facelets', 'REQUEST_FACELETS']]) {
        if (conn.capabilities[capability]) conn.sendCommand({ type: command }).catch(() => {});
    }
    keepAwake();
    status(`Połączono: ${info.device} (${info.protocol.name})`, 'ok');
    startTest();
}

// --- connection test ------------------------------------------------------------------------

function startTest() {
    test = { from: records.length, startMs: performance.now(), done: false };
    $('test-result').innerHTML = '';
    $('test-verdict').className = 'status';
    render();
}

/** True if consecutive move counters skip a value (Gen2 counts mod 256, Gen3 mod 65536). */
function hasGap(moves) {
    const serials = moves.map(m => m.serial).filter(s => typeof s === 'number');
    return serials.slice(1).some((s, i) => ![1, -255, -65535].includes(s - serials[i]));
}

/**
 * After TEST_MOVES moves, check what the dataset needs from this cube and computer: moves arrive,
 * raw bytes are logged, nothing is lost, and the cube has its own clock (else timing comes from
 * Bluetooth arrival, which jitters by hundreds of ms: the session is still useful, for testing).
 */
function evaluateTest() {
    if (!test || test.done) return;
    const since = records.slice(test.from);
    const moves = since.filter(r => r.type === 'EVENT' && r.event.type === 'MOVE').map(r => r.event);
    if (moves.length < TEST_MOVES) {
        const silent = moves.length === 0 && performance.now() - test.startMs > TEST_SILENCE_MS;
        if (!silent) {
            $('test-verdict').textContent =
                `Na ułożonej kostce zrób R R' U U' F F' L L': ${moves.length} / ${TEST_MOVES}`;
            return;
        }
    }
    const notifications = since.filter(r => r.type === 'GATT' && r.op === 'notify').length;
    const checks = [
        { ok: moves.length >= TEST_MOVES, text: 'Ruchy docierają do komputera' },
        { ok: rawCapture && notifications > 0, text: 'Surowe dane z kostki zapisują się' },
        { ok: !hasGap(moves), text: 'Żaden ruch nie zginął' },
        { ok: moves.length > 0 && moves.every(m => m.cubeTimestamp !== null), warnOnly: true,
          text: 'Kostka ma własny zegar (dokładne czasy ruchów)' },
    ];
    const failed = checks.some(c => !c.ok && !c.warnOnly);
    test.done = true;
    records.push({
        type: 'MARK', what: failed ? 'self_test_failed' : 'self_test_passed',
        checks: checks.map(c => ({ text: c.text, ok: c.ok })), moves: moves.length, ...hostTimes(),
    });
    $('test-result').innerHTML = checks
        .map(c => `<li>${c.ok ? '✅' : c.warnOnly ? '⚠️' : '❌'} ${c.text}</li>`).join('');
    $('test-verdict').textContent = failed
        ? 'Coś nie działa. Kliknij „Zapisz plik” i wyślij mi ten plik, nie nagrywaj jeszcze sesji.'
        : 'Wszystko działa: możesz nagrywać.';
    $('test-verdict').className = `status ${failed ? 'error' : 'ok'}`;
}

function onCubeEvent(event) {
    const { timestamp, ...message } = event;
    // Gyro streams fast and is already in the raw GATT lines; keep the decoded log small.
    if (message.type !== 'GYRO') {
        records.push({ type: 'EVENT', event: message, lib_timestamp: timestamp, ...hostTimes() });
    }
    switch (message.type) {
        case 'MOVE':
            moveCount += 1;
            lastMoveMs = performance.now();
            lastMoves = [...lastMoves, message.move].slice(-SHOWN_MOVES);
            break;
        case 'FACELETS':
            if (message.facelets.length === 54) $('state').textContent = message.facelets === SOLVED ? 'ułożona ✓' : 'pomieszana';
            break;
        case 'BATTERY':
            $('battery').textContent = `${message.batteryLevel}%`;
            break;
        case 'DISCONNECT':
            conn = null;
            records.push({ type: 'MARK', what: 'disconnected', ...hostTimes() });
            status('Kostka się rozłączyła. Połącz ją ponownie: nagranie trwa dalej w tym samym pliku.', 'error');
            $('connect').disabled = false;
            break;
    }
    render();
}

/** The user says the cube is solved; cubes that support it are told so (resets their memory). */
async function markSolved() {
    records.push({ type: 'MARK', what: 'user_says_solved', ...hostTimes() });
    if (conn?.capabilities.reset) {
        try {
            await conn.sendCommand({ type: 'REQUEST_RESET' });
            records.push({ type: 'MARK', what: 'reset_to_solved', ...hostTimes() });
            if (conn.capabilities.facelets) await conn.sendCommand({ type: 'REQUEST_FACELETS' });
        } catch (error) {
            status(`Nie udało się zresetować kostki: ${error.message}`, 'error');
        }
    }
    $('solved').textContent = 'Zapisano: kostka ułożona ✓';
    render();
}

async function keepAwake() {
    try {
        wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
        wakeLock = null;  // not supported or refused: the instructions say to keep the screen on
    }
}

// --- page -----------------------------------------------------------------------------------

function status(text, kind = '') {
    $('status').textContent = text;
    $('status').className = `status ${kind}`;
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
    evaluateTest();
    const now = performance.now();
    $('live').hidden = connections.length === 0;
    $('test').hidden = test === null;
    $('elapsed').textContent = connectedMs === null ? '–' : formatDuration(now - connectedMs);
    $('moves').textContent = moveCount;
    $('last-move').textContent = lastMoveMs === null ? '–' : `${Math.round((now - lastMoveMs) / 1000)} s temu`;
    $('move-list').textContent = lastMoves.join(' ') || '–';
    $('solved-button').disabled = !conn;
    const unsaved = records.length - savedCount;
    $('save').disabled = records.length === 0;
    $('save-note').textContent = records.length === 0 ? ''
        : unsaved === 0 ? 'Wszystko zapisane ✓' : 'Niezapisane dane: kliknij „Zapisz plik” przed zamknięciem strony.';
}

function init() {
    if (!navigator.bluetooth) {
        status('Ta przeglądarka nie obsługuje Bluetooth. Użyj Chrome albo Edge na komputerze ' +
               'lub Androidzie (na iPhonie: aplikacja Bluefy).', 'error');
        $('connect').disabled = true;
    }
    if (!rawCapture) $('raw-warning').hidden = false;
    $('connect').onclick = connect;
    $('solved-button').onclick = markSolved;
    $('test-again').onclick = startTest;
    $('save').onclick = save;
    offerPrevious();
    setInterval(render, 1000);
    setInterval(autosave, AUTOSAVE_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && conn) keepAwake();  // the lock drops when hidden
    });
    window.addEventListener('beforeunload', event => {
        if (records.length > savedCount) {
            autosave();
            event.preventDefault();
            event.returnValue = '';
        }
    });
    render();
}

init();
