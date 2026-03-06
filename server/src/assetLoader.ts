import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import {
  PNG_ALPHA_THRESHOLD,
  CHAR_COUNT, CHAR_FRAME_W, CHAR_FRAME_H, CHAR_FRAMES_PER_ROW, CHARACTER_DIRECTIONS,
  FLOOR_PATTERN_COUNT, FLOOR_TILE_SIZE,
  WALL_BITMASK_COUNT, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, WALL_GRID_COLS,
} from './constants.js';

function hex(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

function loadPng(filePath: string): PNG | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return PNG.sync.read(data);
  } catch (e) {
    console.warn(`[Stormies] Failed to load PNG: ${filePath}`, e);
    return null;
  }
}

function extractRegion(png: PNG, x: number, y: number, width: number, height: number): string[][] {
  const sprite: string[][] = [];
  for (let row = 0; row < height; row++) {
    const rowData: string[] = [];
    for (let col = 0; col < width; col++) {
      const px = x + col;
      const py = y + row;
      if (px >= png.width || py >= png.height) {
        rowData.push('');
        continue;
      }
      const idx = (py * png.width + px) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];
      if (a < PNG_ALPHA_THRESHOLD) {
        rowData.push('');
      } else {
        rowData.push(`#${hex(r)}${hex(g)}${hex(b)}`);
      }
    }
    sprite.push(rowData);
  }
  return sprite;
}

interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  partOfGroup?: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
}

export class AssetLoader {
  constructor(private publicDir: string) {}

  private assetPath(...segments: string[]): string {
    return path.join(this.publicDir, 'assets', ...segments);
  }

  loadDefaultLayout(): Record<string, any> | null {
    try {
      const filePath = this.assetPath('default-layout.json');
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.warn('[Stormies] Error loading default layout:', e);
      return null;
    }
  }

  loadCharacterSprites(): CharacterDirectionSprites[] | null {
    try {
      const characters: CharacterDirectionSprites[] = [];
      for (let ci = 0; ci < CHAR_COUNT; ci++) {
        const png = loadPng(this.assetPath('characters', `char_${ci}.png`));
        if (!png) return null;

        const charData: Record<string, string[][][]> = {};
        for (const dir of CHARACTER_DIRECTIONS) charData[dir] = [];

        for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
          const dir = CHARACTER_DIRECTIONS[dirIdx];
          const rowOffsetY = dirIdx * CHAR_FRAME_H;
          const frames: string[][][] = [];
          for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
            frames.push(extractRegion(png, f * CHAR_FRAME_W, rowOffsetY, CHAR_FRAME_W, CHAR_FRAME_H));
          }
          charData[dir] = frames;
        }

        characters.push({
          down: charData['down'],
          up: charData['up'],
          right: charData['right'],
        });
      }
      console.log(`[Stormies] Loaded ${characters.length} character sprites`);
      return characters;
    } catch (e) {
      console.warn('[Stormies] Error loading character sprites:', e);
      return null;
    }
  }

  loadFloorTiles(): string[][][] | null {
    try {
      const png = loadPng(this.assetPath('floors.png'));
      if (!png) return null;
      const sprites: string[][][] = [];
      for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
        sprites.push(extractRegion(png, t * FLOOR_TILE_SIZE, 0, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE));
      }
      console.log(`[Stormies] Loaded ${sprites.length} floor tile patterns`);
      return sprites;
    } catch (e) {
      console.warn('[Stormies] Error loading floor tiles:', e);
      return null;
    }
  }

  loadWallTiles(): string[][][] | null {
    try {
      const png = loadPng(this.assetPath('walls.png'));
      if (!png) return null;
      const sprites: string[][][] = [];
      for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
        const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
        const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
        sprites.push(extractRegion(png, ox, oy, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT));
      }
      console.log(`[Stormies] Loaded ${sprites.length} wall tile pieces`);
      return sprites;
    } catch (e) {
      console.warn('[Stormies] Error loading wall tiles:', e);
      return null;
    }
  }

  loadFurnitureAssets(): { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | null {
    try {
      const catalogPath = this.assetPath('furniture', 'furniture-catalog.json');
      if (!fs.existsSync(catalogPath)) return null;
      const catalogData = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
      const catalog: FurnitureAsset[] = catalogData.assets ?? [];
      const sprites: Record<string, string[][]> = {};

      for (const asset of catalog) {
        try {
          let filePath = asset.file;
          if (!filePath.startsWith('assets/')) filePath = `assets/${filePath}`;
          const fullPath = path.join(this.publicDir, filePath);
          const png = loadPng(fullPath);
          if (!png) continue;
          sprites[asset.id] = extractRegion(png, 0, 0, asset.width, asset.height);
        } catch (e) {
          console.warn(`[Stormies] Error loading asset ${asset.id}:`, e);
        }
      }

      console.log(`[Stormies] Loaded ${Object.keys(sprites).length} / ${catalog.length} furniture sprites`);
      return { catalog, sprites };
    } catch (e) {
      console.warn('[Stormies] Error loading furniture assets:', e);
      return null;
    }
  }
}
