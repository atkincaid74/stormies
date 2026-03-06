import fs from 'fs';
import path from 'path';
import os from 'os';
import { Bridge, type Cancellable } from './bridge.js';
import { LAYOUT_FILE_DIR, LAYOUT_FILE_NAME, LAYOUT_FILE_POLL_INTERVAL_MS } from './constants.js';

export class LayoutPersistence {
  private layoutDir = path.join(os.homedir(), LAYOUT_FILE_DIR);
  private layoutFile = path.join(this.layoutDir, LAYOUT_FILE_NAME);
  private skipNextChange = false;
  private lastMtime = 0;
  private pollTimer: Cancellable | null = null;
  private watching = false;

  constructor(private bridge: Bridge) {}

  readLayoutFromFile(): Record<string, any> | null {
    try {
      if (!fs.existsSync(this.layoutFile)) return null;
      return JSON.parse(fs.readFileSync(this.layoutFile, 'utf-8'));
    } catch (e) {
      console.warn('[Stormies] Failed to read layout file:', e);
      return null;
    }
  }

  writeLayoutToFile(layout: any) {
    try {
      fs.mkdirSync(this.layoutDir, { recursive: true });
      const json = JSON.stringify(layout);
      const tmpFile = this.layoutFile + '.tmp';
      fs.writeFileSync(tmpFile, json, 'utf-8');
      fs.renameSync(tmpFile, this.layoutFile);
    } catch (e) {
      console.warn('[Stormies] Failed to write layout file:', e);
    }
  }

  markOwnWrite() {
    this.skipNextChange = true;
    try {
      if (fs.existsSync(this.layoutFile)) {
        this.lastMtime = fs.statSync(this.layoutFile).mtimeMs;
      }
    } catch { /* ignore */ }
  }

  migrateAndLoadLayout(defaultLayout: Record<string, any> | null = null): Record<string, any> | null {
    const fromFile = this.readLayoutFromFile();
    if (fromFile) {
      console.log('[Stormies] Layout loaded from file');
      return fromFile;
    }
    if (defaultLayout) {
      console.log('[Stormies] Writing bundled default layout to file');
      this.writeLayoutToFile(defaultLayout);
      return defaultLayout;
    }
    return null;
  }

  startWatching(onExternalChange: (layout: Record<string, any>) => void) {
    if (this.watching) return;
    this.watching = true;

    try {
      if (fs.existsSync(this.layoutFile)) {
        this.lastMtime = fs.statSync(this.layoutFile).mtimeMs;
      }
    } catch { /* ignore */ }

    this.pollTimer = this.bridge.schedule(() => {
      this.checkForChange(onExternalChange);
    }, LAYOUT_FILE_POLL_INTERVAL_MS, true);
  }

  private checkForChange(onExternalChange: (layout: Record<string, any>) => void) {
    try {
      if (!fs.existsSync(this.layoutFile)) return;
      const mtime = fs.statSync(this.layoutFile).mtimeMs;
      if (mtime <= this.lastMtime) return;
      this.lastMtime = mtime;

      if (this.skipNextChange) {
        this.skipNextChange = false;
        return;
      }

      const raw = fs.readFileSync(this.layoutFile, 'utf-8');
      const layout = JSON.parse(raw);
      console.log('[Stormies] External layout change detected');
      onExternalChange(layout);
    } catch (e) {
      console.warn('[Stormies] Error checking layout file:', e);
    }
  }

  dispose() {
    this.pollTimer?.cancel();
    this.pollTimer = null;
  }
}
