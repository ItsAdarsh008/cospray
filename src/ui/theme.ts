import type { TextStyle } from 'react-native';

// Fresco "pixel arcade" look: Subway-Surfers chunky buttons x Kahoot purple/primary shapes x
// early-2000s CRT / vaporwave pixel nostalgia. Flat colours, hard edges, hard shadows, no blur.
export const C = {
  bg: '#12082b',
  bg2: '#1c0f42',
  ink: '#0a0620', // outline / hard shadow colour
  panel: '#2c1868',
  panelHi: '#4327a8',
  panelLo: '#1b0f45',
  card: '#221252',
  white: '#ffffff',
  text: '#ffffff',
  dim: '#cdbff5',
  faint: '#8f80c8',
  line: '#ffffff1a',

  green: '#59d92d', greenHi: '#9cff6b', greenLo: '#2b8a17',
  yellow: '#ffd21f', yellowHi: '#fff07a', yellowLo: '#c48f00',
  red: '#ff3d55', redHi: '#ff8a99', redLo: '#a8162c',
  blue: '#2f80ff', blueHi: '#86b8ff', blueLo: '#1748b5',
  purple: '#7a45ff', purpleHi: '#ab8cff', purpleLo: '#4a22b8',
  pink: '#ff4fa3',
  phosphor: '#57ffa0', phosDim: '#1fae62',
  // legacy names still used by a few overlays
  cyan: '#19e6ff', lime: '#7cff3a', orange: '#ff8a1f', violet: '#b26bff',
};

export const F = {
  display: 'PixelifySans_700Bold',
  displayMd: 'PixelifySans_600SemiBold',
  body: 'PixelifySans_500Medium',
  bodyReg: 'PixelifySans_400Regular',
  label: 'Silkscreen_400Regular',
  labelBold: 'Silkscreen_700Bold',
  mono: 'VT323_400Regular',
};

export type Tone = 'green' | 'yellow' | 'red' | 'blue' | 'purple' | 'dark' | 'white' | 'panel';
/** fill / bevel-highlight / bevel-shade for the chunky buttons and panels. */
export const TONES: Record<Tone, { fill: string; hi: string; lo: string; text: string }> = {
  green: { fill: C.green, hi: C.greenHi, lo: C.greenLo, text: '#ffffff' },
  yellow: { fill: C.yellow, hi: C.yellowHi, lo: C.yellowLo, text: '#2a1a00' },
  red: { fill: C.red, hi: C.redHi, lo: C.redLo, text: '#ffffff' },
  blue: { fill: C.blue, hi: C.blueHi, lo: C.blueLo, text: '#ffffff' },
  purple: { fill: C.purple, hi: C.purpleHi, lo: C.purpleLo, text: '#ffffff' },
  dark: { fill: '#1a0f3a', hi: '#3a2a78', lo: '#0f0826', text: '#ffffff' },
  white: { fill: '#ffffff', hi: '#ffffff', lo: '#b9aee0', text: '#1c0f42' },
  panel: { fill: C.panel, hi: C.panelHi, lo: C.panelLo, text: '#ffffff' },
};

/** Screen background tones (top -> bottom) used by <Backdrop>. */
export const BACKDROPS = {
  purple: { top: '#3a1a8a', bottom: '#12082b', star: '#a889ff' },
  night: { top: '#1c0f42', bottom: '#07030f', star: '#7a45ff' },
  terminal: { top: '#0c3a2a', bottom: '#03100b', star: '#57ffa0' },
  magenta: { top: '#5a1466', bottom: '#150626', star: '#ff8fd0' },
  blue: { top: '#1a3fa8', bottom: '#0b0a2e', star: '#86b8ff' },
} as const;
export type BackdropName = keyof typeof BACKDROPS;

/**
 * Legibility: the pixel faces (Pixelify Sans, Silkscreen, VT323) only read well big. Anything under
 * ~16px — labels, captions, meta, HUD subtitles — uses the system face instead, so the arcade look
 * comes from the boxes, colours and headings rather than from text nobody can read.
 */
export const ui = (size: number, weight: TextStyle['fontWeight'] = '600', letterSpacing = 0): TextStyle => ({ fontSize: size, fontWeight: weight, letterSpacing });
/** All-caps section label / chip text. */
export const uiLabel = (size = 11.5, letterSpacing = 0.9): TextStyle => ({ fontSize: size, fontWeight: '800', letterSpacing, textTransform: 'uppercase' });

export const PX = 3; // one "pixel" of UI
export const DOCK_H = 66;
export const DOCK_PAD = 24; // home-indicator padding under the dock
export const DOCK_TOTAL = DOCK_H + DOCK_PAD;
/** Space to leave under scrolling content so the dock never covers it. */
export const DOCK_INSET = DOCK_TOTAL + 20;
export const DOCK_BOTTOM = 0;
/** Create-tab layout: the hold buttons sit just above the dock; the tools tray opens above them. */
export const HOLD_BOTTOM = DOCK_TOTAL + 10;
export const HOLD_H = 60;
export const HOLD_TOP = HOLD_BOTTOM + HOLD_H + 5; // top edge of the buttons, measured from the bottom of the screen
/** Camera overlay plates: deliberately colourless (dark plate, white text), so the only colour over the camera is paint. */
export const PLATE = '#120a2e';
export const PLATE_HI = '#2a1c5c';

/** Hard drop shadow for text, the Subway-Surfers "outlined" look without a stroke. */
export const outline = (color: string = C.ink, px = 2) => ({
  textShadowColor: color,
  textShadowOffset: { width: 0, height: px },
  textShadowRadius: 0,
});
