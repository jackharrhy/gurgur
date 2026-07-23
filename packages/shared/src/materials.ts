export const MATERIAL_TEXTURE_SIZE = 32;

export const materialPalette = (name: string): readonly [string, string, string] => {
  if (name.includes("CONCRETE")) return ["#4f5655", "#34383f", "#8b806d"];
  if (name.includes("STONE")) return ["#62536f", "#3c334d", "#9b6b68"];
  if (name.includes("WOOD")) return ["#a55b3f", "#663744", "#d18a4f"];
  if (name.includes("RUBBER")) return ["#71335f", "#452542", "#cb4c73"];
  if (name.includes("CAUTION")) return ["#d9a92f", "#28253c", "#ffe18a"];
  if (name.includes("DANGER")) return ["#a52b4c", "#292037", "#ff6b5b"];
  if (name.includes("BUTTON")) return ["#d94b3e", "#732d46", "#ffb35c"];
  if (name.includes("PLATFORM")) return ["#347e87", "#24485d", "#70c3a6"];
  if (name.includes("RAMP")) return ["#687447", "#3c493d", "#a6a85b"];
  if (name.includes("DOOR")) return ["#596878", "#303b50", "#a2b0ad"];
  if (name.includes("WATER")) return ["#173a5c", "#197d88", "#6bd2b2"];
  return ["#4a5868", "#2d3445", "#8396a0"];
};

const rgb = (hex: string): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

export function createMaterialTextureRgba(name: string): Uint8ClampedArray {
  const size = MATERIAL_TEXTURE_SIZE;
  const pixels = new Uint8ClampedArray(size * size * 4);
  const colors = materialPalette(name).map(rgb);
  const fillRect = (
    colorIndex: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ) => {
    const color = colors[colorIndex]!;
    for (let y = Math.max(0, top); y < Math.min(size, top + height); y += 1) {
      for (let x = Math.max(0, left); x < Math.min(size, left + width); x += 1) {
        const offset = (y * size + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  };

  fillRect(0, 0, 0, size, size);
  if (name.includes("CONCRETE") || name.includes("STONE")) {
    let seed = name.includes("STONE") ? 0x5a17 : 0xc0c0;
    for (let index = 0; index < 86; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      fillRect(
        index % 5 === 0 ? 2 : 1,
        seed & 31,
        (seed >>> 8) & 31,
        index % 7 === 0 ? 2 : 1,
        index % 11 === 0 ? 2 : 1,
      );
    }
  } else if (name.includes("WATER")) {
    for (let y = 3; y < size; y += 6)
      for (let x = -4; x < size; x += 8) fillRect(1, x + (y % 4), y, 6, 2);
    for (let y = 6; y < size; y += 12) for (let x = 1; x < size; x += 12) fillRect(2, x, y, 4, 1);
  } else if (name.includes("CAUTION")) {
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) if ((x + y) % 12 < 6) fillRect(1, x, y, 1, 1);
  } else if (name.includes("METAL") || name.includes("DOOR")) {
    fillRect(1, 0, 0, size, 2);
    fillRect(1, 0, 15, size, 2);
    for (const x of [2, 14, 18, 30]) for (const y of [3, 13, 19, 29]) fillRect(2, x, y, 1, 1);
  } else if (name.includes("WOOD")) {
    for (let y = 5; y < size; y += 8) fillRect(1, 0, y, size, 2);
    for (let x = 4; x < size; x += 10) fillRect(2, x, 0, 1, size);
  } else if (name.includes("DANGER")) {
    for (let y = 0; y < size; y += 8)
      for (let x = 0; x < size; x += 8) if (((x + y) / 8) % 2 === 0) fillRect(1, x, y, 8, 8);
  } else {
    for (let y = 0; y < size; y += 8) fillRect(1, 0, y, size, 1);
    for (const [x, y] of [
      [3, 4],
      [21, 6],
      [13, 13],
      [28, 21],
      [7, 27],
    ])
      fillRect(2, x!, y!, 2, 2);
  }
  return pixels;
}
