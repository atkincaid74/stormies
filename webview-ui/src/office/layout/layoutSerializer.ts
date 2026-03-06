import { TileType, FurnitureType, DEFAULT_ROWS, TILE_SIZE, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, Seat, SeatZone, FurnitureInstance, FloorColor } from '../types.js'
import { getCatalogEntry } from './furnitureCatalog.js'
import { getColorizedSprite } from '../colorize.js'

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = []
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = []
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c])
    }
    map.push(row)
  }
  return map
}

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = new Map<string, number>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue
    const deskZY = item.row * TILE_SIZE + entry.sprite.length
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`
        const prev = deskZByTile.get(key)
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY)
      }
    }
  }

  const instances: FurnitureInstance[] = []
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const x = item.col * TILE_SIZE
    const y = item.row * TILE_SIZE
    const spriteH = entry.sprite.length
    let zY = y + spriteH

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it)
        zY = (item.row + 1) * TILE_SIZE + 1
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`)
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5
        }
      }
    }

    // Colorize sprite if this furniture has a color override
    let sprite = entry.sprite
    if (item.color) {
      const { h, s, b: bv, c: cv } = item.color
      sprite = getColorizedSprite(`furn-${item.type}-${h}-${s}-${bv}-${cv}-${item.color.colorize ? 1 : 0}`, entry.sprite, item.color)
    }

    instances.push({ sprite, x, y, zY })
  }
  return instances
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(furniture: PlacedFurniture[], excludeTiles?: Set<string>): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const bgRows = entry.backgroundTiles || 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`
        if (excludeTiles && excludeTiles.has(key)) continue
        tiles.add(key)
      }
    }
  }
  return tiles
}

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item */
export function getPlacementBlockedTiles(furniture: PlacedFurniture[], excludeUid?: string): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    if (item.uid === excludeUid) continue
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const bgRows = entry.backgroundTiles || 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }
  return tiles
}

/** Map chair orientation to character facing direction */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front': return Direction.DOWN
    case 'back': return Direction.UP
    case 'left': return Direction.LEFT
    case 'right': return Direction.RIGHT
    default: return Direction.DOWN
  }
}

/** Determine zone for a seat based on furniture placement metadata or column position.
 *  Zone boundaries: left third = work, middle third = waiting, right third = idle.
 *  Furniture with explicit zone property overrides position-based assignment. */
function inferSeatZone(item: PlacedFurniture, tileCol: number, totalCols: number): SeatZone {
  if ((item as any).zone) return (item as any).zone as SeatZone
  const third = totalCols / 3
  if (tileCol < third) return 'work'
  if (tileCol < third * 2) return 'waiting'
  return 'idle'
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(furniture: PlacedFurniture[], totalCols?: number): Map<string, Seat> {
  const seats = new Map<string, Seat>()

  // Build set of all desk tiles
  const deskTiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP },    // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN },   // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT },   // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT },   // desk is right of chair → face RIGHT
  ]

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || entry.category !== 'chairs') continue

    let seatCount = 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc
        const tileRow = item.row + dr

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation)
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing
              break
            }
          }
        }

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`
        const zone = inferSeatZone(item, tileCol, totalCols ?? 20)
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
          zone,
        })
        seatCount++
      }
    }
  }

  return seats
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles) */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>()
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`)
  }
  return tiles
}

/** Default floor colors for the three rooms */
const DEFAULT_WORK_ROOM_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 }    // warm beige
const DEFAULT_WAITING_ROOM_COLOR: FloorColor = { h: 25, s: 45, b: 5, c: 10 } // warm brown
const DEFAULT_IDLE_ROOM_COLOR: FloorColor = { h: 210, s: 25, b: 10, c: 0 }   // cool blue-gray
const DEFAULT_CARPET_COLOR: FloorColor = { h: 280, s: 40, b: -5, c: 0 }      // purple
const DEFAULT_DOORWAY_COLOR: FloorColor = { h: 35, s: 25, b: 10, c: 0 }      // tan

/** Create the default 3-room office layout:
 *  - Left room (cols 1-9): Work area — active agents
 *  - Center room (cols 11-19): Waiting room — agents needing input
 *  - Right room (cols 21-28): Idle lounge — finished agents */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL
  const F1 = TileType.FLOOR_1
  const F2 = TileType.FLOOR_2
  const F3 = TileType.FLOOR_3
  const F4 = TileType.FLOOR_4
  const COLS = 30
  const ROWS = DEFAULT_ROWS

  const tiles: TileTypeVal[] = []
  const tileColors: Array<FloorColor | null> = []

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      // Outer walls
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        tiles.push(W); tileColors.push(null); continue
      }
      // First divider wall (col 10) with doorway
      if (c === 10) {
        if (r >= 4 && r <= 6) { tiles.push(F4); tileColors.push(DEFAULT_DOORWAY_COLOR) }
        else { tiles.push(W); tileColors.push(null) }
        continue
      }
      // Second divider wall (col 20) with doorway
      if (c === 20) {
        if (r >= 4 && r <= 6) { tiles.push(F4); tileColors.push(DEFAULT_DOORWAY_COLOR) }
        else { tiles.push(W); tileColors.push(null) }
        continue
      }
      // Idle lounge carpet area
      if (c >= 24 && c <= 27 && r >= 7 && r <= 9) {
        tiles.push(F3); tileColors.push(DEFAULT_CARPET_COLOR); continue
      }
      // Room floors
      if (c < 10) { tiles.push(F1); tileColors.push(DEFAULT_WORK_ROOM_COLOR) }
      else if (c < 20) { tiles.push(F2); tileColors.push(DEFAULT_WAITING_ROOM_COLOR) }
      else { tiles.push(F1); tileColors.push(DEFAULT_IDLE_ROOM_COLOR) }
    }
  }

  const furniture: PlacedFurniture[] = [
    // === WORK ROOM (left, cols 1-9) — desks for active agents ===
    { uid: 'desk-w1', type: FurnitureType.DESK, col: 4, row: 3 },
    { uid: 'chair-w-top', type: FurnitureType.CHAIR, col: 4, row: 2 },
    { uid: 'chair-w-bottom', type: FurnitureType.CHAIR, col: 5, row: 5 },
    { uid: 'chair-w-left', type: FurnitureType.CHAIR, col: 3, row: 4 },
    { uid: 'chair-w-right', type: FurnitureType.CHAIR, col: 6, row: 3 },
    { uid: 'desk-w2', type: FurnitureType.DESK, col: 4, row: 7 },
    { uid: 'chair-w2-top', type: FurnitureType.CHAIR, col: 4, row: 6 },
    { uid: 'chair-w2-bottom', type: FurnitureType.CHAIR, col: 5, row: 9 },
    { uid: 'chair-w2-left', type: FurnitureType.CHAIR, col: 3, row: 8 },
    { uid: 'chair-w2-right', type: FurnitureType.CHAIR, col: 6, row: 7 },
    { uid: 'bookshelf-w', type: FurnitureType.BOOKSHELF, col: 1, row: 5 },
    { uid: 'plant-w', type: FurnitureType.PLANT, col: 1, row: 1 },

    // === WAITING ROOM (center, cols 11-19) — agents needing input ===
    { uid: 'desk-wt1', type: FurnitureType.DESK, col: 14, row: 3 },
    { uid: 'chair-wt-top', type: FurnitureType.CHAIR, col: 14, row: 2 },
    { uid: 'chair-wt-bottom', type: FurnitureType.CHAIR, col: 15, row: 5 },
    { uid: 'chair-wt-left', type: FurnitureType.CHAIR, col: 13, row: 4 },
    { uid: 'chair-wt-right', type: FurnitureType.CHAIR, col: 16, row: 3 },
    { uid: 'whiteboard-wt', type: FurnitureType.WHITEBOARD, col: 15, row: 0 },
    { uid: 'cooler-wt', type: FurnitureType.COOLER, col: 18, row: 7 },
    { uid: 'plant-wt', type: FurnitureType.PLANT, col: 18, row: 1 },

    // === IDLE LOUNGE (right, cols 21-28) — resting agents ===
    { uid: 'desk-i1', type: FurnitureType.DESK, col: 24, row: 3 },
    { uid: 'chair-i-top', type: FurnitureType.CHAIR, col: 24, row: 2 },
    { uid: 'chair-i-bottom', type: FurnitureType.CHAIR, col: 25, row: 5 },
    { uid: 'chair-i-left', type: FurnitureType.CHAIR, col: 23, row: 4 },
    { uid: 'chair-i-right', type: FurnitureType.CHAIR, col: 26, row: 3 },
    { uid: 'plant-i1', type: FurnitureType.PLANT, col: 28, row: 1 },
    { uid: 'plant-i2', type: FurnitureType.PLANT, col: 21, row: 1 },
    { uid: 'cooler-i', type: FurnitureType.COOLER, col: 27, row: 7 },
  ]

  return { version: 1, cols: COLS, rows: ROWS, tiles, tileColors, furniture }
}

/** Serialize layout to JSON string */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout)
}

/** Deserialize layout from JSON string, migrating old tile types if needed */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json)
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return migrateLayout(obj as OfficeLayout)
    }
  } catch { /* ignore parse errors */ }
  return null
}

/**
 * Ensure layout has tileColors. If missing, generate defaults based on tile types.
 * Exported for use by message handlers that receive layouts over the wire.
 */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout)
}

/**
 * Migrate old layouts that use legacy tile types (TILE_FLOOR=1, WOOD_FLOOR=2, CARPET=3, DOORWAY=4)
 * to the new pattern-based system. If tileColors is already present, no migration needed.
 */
function migrateLayout(layout: OfficeLayout): OfficeLayout {
  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout // Already migrated
  }

  // Check if any tiles use old values (1-4) — these map directly to FLOOR_1-4
  // but need color assignments
  const tileColors: Array<FloorColor | null> = []
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0: // WALL
        tileColors.push(null)
        break
      case 1: // was TILE_FLOOR → FLOOR_1 beige
        tileColors.push(DEFAULT_WORK_ROOM_COLOR)
        break
      case 2: // was WOOD_FLOOR → FLOOR_2 brown
        tileColors.push(DEFAULT_WAITING_ROOM_COLOR)
        break
      case 3: // was CARPET → FLOOR_3 purple
        tileColors.push(DEFAULT_CARPET_COLOR)
        break
      case 4: // was DOORWAY → FLOOR_4 tan
        tileColors.push(DEFAULT_DOORWAY_COLOR)
        break
      default:
        // New tile types (5-7) without colors — use neutral gray
        tileColors.push(tile > 0 ? { h: 0, s: 0, b: 0, c: 0 } : null)
    }
  }

  return { ...layout, tileColors }
}
