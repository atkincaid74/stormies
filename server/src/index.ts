import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { Bridge } from './bridge.js';
import { TimerManager } from './timerManager.js';
import { TranscriptParser } from './transcriptParser.js';
import { JsonlWatcher } from './jsonlWatcher.js';
import { AgentManager } from './agentManager.js';
import { LayoutPersistence } from './layoutPersistence.js';
import { AssetLoader } from './assetLoader.js';
import { PORT, LAYOUT_FILE_DIR, SETTINGS_FILE } from './constants.js';
import type { AgentState } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// --- Static file serving ---
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const webviewDist = path.join(repoRoot, 'webview-ui', 'dist');
if (!fs.existsSync(webviewDist)) {
  console.error(`[Stormies] webview-ui/dist not found. Run "npm run build:webview" first.`);
  process.exit(1);
}
app.use(express.static(webviewDist));

// --- Core components ---
const bridge = new Bridge();
const agents = new Map<number, AgentState>();
const timerManager = new TimerManager(bridge);
const transcriptParser = new TranscriptParser(bridge, timerManager);
const jsonlWatcher = new JsonlWatcher(bridge, timerManager, transcriptParser, agents);
const agentManager = new AgentManager(bridge, timerManager, jsonlWatcher, agents);
const layoutPersistence = new LayoutPersistence(bridge);
const assetLoader = new AssetLoader(path.join(repoRoot, 'webview-ui', 'public'));

// --- Settings persistence ---
const settingsDir = path.join(os.homedir(), LAYOUT_FILE_DIR);
const settingsFile = path.join(settingsDir, SETTINGS_FILE);

let settings: Record<string, any> = { soundEnabled: true, agentSeats: {} };

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }
  } catch { /* use defaults */ }
}

function saveSettings() {
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch { /* ignore */ }
}

loadSettings();

// --- Pre-load assets (cached for all clients) ---
const cachedCharSprites = assetLoader.loadCharacterSprites();
const cachedFloorTiles = assetLoader.loadFloorTiles();
const cachedWallTiles = assetLoader.loadWallTiles();
const cachedFurniture = assetLoader.loadFurnitureAssets();
const defaultLayout = assetLoader.loadDefaultLayout();

// --- Message handling ---
bridge.onMessage((msg, sender) => {
  const type = msg.type;

  switch (type) {
    case 'webviewReady': {
      // Send settings
      bridge.sendTo(sender, { type: 'settingsLoaded', soundEnabled: settings.soundEnabled ?? true });

      // Send cached assets
      if (cachedCharSprites) bridge.sendTo(sender, { type: 'characterSpritesLoaded', characters: cachedCharSprites });
      if (cachedFloorTiles) bridge.sendTo(sender, { type: 'floorTilesLoaded', sprites: cachedFloorTiles });
      if (cachedWallTiles) bridge.sendTo(sender, { type: 'wallTilesLoaded', sprites: cachedWallTiles });
      if (cachedFurniture) bridge.sendTo(sender, { type: 'furnitureAssetsLoaded', catalog: cachedFurniture.catalog, sprites: cachedFurniture.sprites });

      // Send layout
      const layout = layoutPersistence.migrateAndLoadLayout(defaultLayout);
      bridge.sendTo(sender, { type: 'layoutLoaded', layout });

      // Start layout watching (idempotent)
      layoutPersistence.startWatching((layout) => {
        bridge.postMessage({ type: 'layoutLoaded', layout });
      });

      // Send existing agents to this client
      agentManager.sendExistingAgents(sender, settings.agentSeats ?? {});

      // Start project scanning (idempotent)
      agentManager.startProjectScanning();
      break;
    }

    case 'closeAgent': {
      const id = Number(msg.id);
      agentManager.removeAgent(id);
      bridge.postMessage({ type: 'agentClosed', id });
      break;
    }

    case 'saveAgentSeats': {
      settings.agentSeats = msg.seats;
      saveSettings();
      break;
    }

    case 'saveLayout': {
      if (msg.layout) {
        layoutPersistence.markOwnWrite();
        layoutPersistence.writeLayoutToFile(msg.layout);
      }
      break;
    }

    case 'setSoundEnabled': {
      settings.soundEnabled = msg.enabled;
      saveSettings();
      break;
    }

    case 'openSessionsFolder':
    case 'exportLayout':
    case 'importLayout':
    case 'focusAgent':
    case 'openClaude':
      break;
  }
});

// --- WebSocket connections ---
wss.on('connection', (ws) => {
  console.log('[Stormies] Client connected');
  bridge.addClient(ws);
  ws.on('close', () => console.log('[Stormies] Client disconnected'));
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`[Stormies] Pixel agents office running at http://localhost:${PORT}`);
});

// --- Graceful shutdown ---
function shutdown() {
  console.log('[Stormies] Shutting down...');
  agentManager.dispose();
  jsonlWatcher.dispose();
  timerManager.dispose();
  layoutPersistence.dispose();
  bridge.dispose();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
