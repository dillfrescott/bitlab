const TRACKER_URL = "https://raw.githubusercontent.com/ngosang/trackerslist/refs/heads/master/trackers_best.txt";

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.leechers-paradise.org:6969/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.cyberia.is:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://opentracker.i2p.rocks:6969/announce",
  "udp://tracker.openbittorrent.com:80/announce",
  "http://tracker.openbittorrent.com:80/announce",
  "udp://exodus.desync.com:6969/announce"
];

let cachedTrackers = [...DEFAULT_TRACKERS];
let lastFetched = 0;
const FETCH_INTERVAL_MS = 1000 * 60 * 60 * 6; // 6 hours
let isFetching = false;

async function refreshTrackers() {
  if (isFetching) return;
  isFetching = true;
  try {
    console.log(`[trackers] fetching trackers from ${TRACKER_URL}`);
    const res = await fetch(TRACKER_URL, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`http error ${res.status}`);
    }
    const text = await res.text();
    const trackers = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && (line.startsWith("udp://") || line.startsWith("http://") || line.startsWith("https://")));

    if (trackers.length > 0) {
      cachedTrackers = trackers;
      lastFetched = Date.now();
      console.log(`[trackers] successfully updated cache with ${trackers.length} trackers`);
    }
  } catch (err) {
    console.error(`[trackers] failed to fetch trackers, using cached/default: ${err.message}`);
  } finally {
    isFetching = false;
  }
}

function getTrackers() {
  // If cache is empty or expired, trigger refresh in background
  if (Date.now() - lastFetched > FETCH_INTERVAL_MS) {
    refreshTrackers().catch(() => {});
  }
  return cachedTrackers;
}

// Initial fetch in background
refreshTrackers().catch(() => {});

module.exports = {
  getTrackers,
};
